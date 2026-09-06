import { describe, it, expect } from 'vitest';
import { normalizeRawMessage, RawRecordSchema } from './typesRaw';
import {
    buildToolModel,
    getToolModel,
    parseGeminiExecuteTitle,
    splitUnifiedDiff,
    toolResultBlocks,
    trimCommonIndent,
    ToolCallLike,
} from './toolModel';
import { ToolCall } from './typesMessage';
import * as fixtures from './toolModel.fixtures';

/** Normalize a raw fixture and pull the tool-result content the reducer would store. */
function normalizedResult(raw: unknown): { content: unknown; is_error: boolean } {
    const normalized = normalizeRawMessage('m1', null, 1000, raw as any);
    expect(normalized).not.toBeNull();
    expect(normalized!.role).toBe('agent');
    const result = (normalized as any).content.find((c: any) => c.type === 'tool-result');
    expect(result).toBeDefined();
    return { content: result.content, is_error: result.is_error };
}

function tool(overrides: Partial<ToolCallLike> & { name: string }): ToolCall {
    return {
        state: 'completed',
        input: {},
        createdAt: 1,
        startedAt: 1,
        completedAt: 2,
        description: null,
        ...overrides,
    } as ToolCall;
}

/** The legacy ToolCall the reducer would hold after applying a result. */
function toolFromResult(name: string, input: unknown, raw: unknown): ToolCall {
    const { content, is_error } = normalizedResult(raw);
    return tool({ name, input, state: is_error ? 'error' : 'completed', result: content });
}

describe('toolModel — result blocks', () => {
    it('keeps every text block of a Claude multi-block result, in order', () => {
        const model = getToolModel(toolFromResult('Read', { file_path: '/a' }, fixtures.claudeMultiBlockResult));
        expect(model.outcome).toBe('succeeded');
        expect(model.outputText).toBe('First file\nSecond file');
        expect(model.blocks.map((b) => b.kind)).toEqual(['text']);
    });

    it('keeps image blocks alongside text', () => {
        const model = getToolModel(toolFromResult('Read', { file_path: '/a' }, fixtures.claudeImageResult));
        expect(model.blocks.map((b) => b.kind)).toEqual(['text', 'image']);
        const image = model.blocks[1];
        expect(image.kind === 'image' && image.mediaType).toBe('image/png');
        expect(image.kind === 'image' && image.data).toBe('iVBORw0KGgo=');
    });

    it('preserves zero, false and the empty string as real results', () => {
        expect(toolResultBlocks(0)).toEqual([{ kind: 'text', text: '0' }]);
        expect(toolResultBlocks(false)).toEqual([{ kind: 'text', text: 'false' }]);
        expect(toolResultBlocks('')).toEqual([{ kind: 'text', text: '' }]);
        expect(toolResultBlocks(null)).toEqual([]);
        expect(toolResultBlocks(undefined)).toEqual([]);
        const zero = getToolModel(tool({ name: 'pi_tool', result: 0 }));
        expect(zero.outcome).toBe('succeeded');
        expect(zero.blocks).toHaveLength(1);
        expect(zero.outputText).toBe('0');
    });

    it('keeps structured output as a structured block and extracts stdout/stderr for terminals', () => {
        const codex = toolFromResult('CodexBash', { command: 'make' }, fixtures.codexStructuredResult);
        const model = getToolModel(codex);
        expect(model.outcome).toBe('succeeded');
        expect(model.blocks[0].kind).toBe('structured');
        expect(model.command?.stdout).toBe('compiled');
        expect(model.command?.exitCode).toBe(0);
    });

    it('accepts a hyphenated tool-call-result with structured output inside a user record', () => {
        expect(RawRecordSchema.safeParse(fixtures.codexHyphenatedInUserRecord).success).toBe(true);
        const { content } = normalizedResult(fixtures.codexHyphenatedInUserRecord);
        expect(content).toEqual({ stdout: 'ok', exitCode: 0 });
    });
});

describe('toolModel — outcome per provider error shape', () => {
    it('Claude: <tool_use_error> is an ordinary FAILURE with its reason, not a cancellation', () => {
        const model = getToolModel(toolFromResult('Edit', { file_path: '/a', old_string: 'a', new_string: 'b' }, fixtures.claudeToolUseError));
        expect(model.outcome).toBe('failed');
        expect(model.isError).toBe(true);
        expect(model.errorMessage).toBe('File has not been read yet. Read it first before writing to it.');
    });

    it('Claude: an interruption is CANCELLED', () => {
        const model = getToolModel(toolFromResult('Bash', { command: 'sleep 9' }, fixtures.claudeInterrupted));
        expect(model.outcome).toBe('cancelled');
    });

    it('Claude: a rejected tool use is DENIED', () => {
        const model = getToolModel(toolFromResult('Write', { file_path: '/a', content: 'x' }, fixtures.claudeRejected));
        expect(model.outcome).toBe('denied');
    });

    it('permission status wins: denied / canceled placeholders', () => {
        const denied = getToolModel(tool({ name: 'Bash', state: 'error', result: { error: 'nope' }, permission: { id: 'p', status: 'denied', reason: 'nope' } }));
        expect(denied.outcome).toBe('denied');
        expect(denied.errorMessage).toBe('nope');
        const canceled = getToolModel(tool({ name: 'Bash', state: 'error', permission: { id: 'p', status: 'canceled' } }));
        expect(canceled.outcome).toBe('cancelled');
        const pending = getToolModel(tool({ name: 'Bash', state: 'running', permission: { id: 'p', status: 'pending' } }));
        expect(pending.outcome).toBe('pending');
    });

    it('Gemini / agy and OpenCode: the ACP isError flag marks a failure', () => {
        for (const provider of ['gemini', 'opencode'] as const) {
            const model = getToolModel(toolFromResult('execute', fixtures.geminiExecuteInput, fixtures.acpErrorResult(provider, 'c1', 'boom', true)));
            expect(model.outcome).toBe('failed');
            expect(model.errorMessage).toBe('boom');
            const ok = getToolModel(toolFromResult('execute', fixtures.geminiExecuteInput, fixtures.acpErrorResult(provider, 'c1', 'fine', false)));
            expect(ok.outcome).toBe('succeeded');
        }
    });

    it('session protocol (pi): tool-call-end isError marks a failure; a zero result is a success with output', () => {
        const failed = getToolModel(toolFromResult('pi_tool', {}, fixtures.sessionToolCallEnd('c1', 'crashed', true)));
        expect(failed.outcome).toBe('failed');
        expect(failed.errorMessage).toBe('crashed');
        const zero = getToolModel(toolFromResult('pi_tool', {}, fixtures.sessionToolCallEnd('c2', 0)));
        expect(zero.outcome).toBe('succeeded');
        expect(zero.outputText).toBe('0');
    });

    it('a structured error never becomes "[object Object]"', () => {
        const model = getToolModel(tool({ name: 'WebFetch', state: 'error', result: { error: 'disk is full' } }));
        expect(model.outcome).toBe('failed');
        expect(model.errorMessage).toBe('disk is full');
    });

    it('compact and full surfaces read one outcome: the model is identical either way', () => {
        const record = toolFromResult('Edit', { file_path: '/a' }, fixtures.claudeToolUseError);
        const a = getToolModel(record);
        const b = getToolModel(record);
        expect(a).toBe(b);
        expect(buildToolModel(record)).toEqual(a);
    });
});

describe('toolModel — arguments and malformed items', () => {
    it('isolates unvalidated arguments as a raw fallback and never throws', () => {
        for (const input of [null, undefined, 'str', 7, [null], [1, 2]]) {
            const model = getToolModel(tool({ name: 'Read', input }));
            expect(model.arguments.ok).toBe(false);
            expect(model.arguments.value).toEqual({});
            expect(model.raw.input).toBe(input);
        }
        const nullParsed = getToolModel(tool({ name: 'CodexBash', input: { command: 'ls', parsed_cmd: [null] } }));
        expect(nullParsed.command?.command).toBe('ls');
        expect(nullParsed.command?.operations).toEqual([]);
    });

    it('CodexPatch: null entries are skipped, list-form keeps content pairs and rename destinations', () => {
        const list = getToolModel(tool({ name: 'CodexPatch', input: fixtures.codexListPatchInput }));
        expect(list.fileChanges?.map((c) => c.path)).toEqual(['a.ts', 'c.ts']);
        expect(list.fileChanges?.[0]).toMatchObject({ kind: 'move', movePath: 'b.ts', oldText: 'old\n', newText: 'new\n' });
        expect(list.fileChanges?.[1]).toMatchObject({ kind: 'add', newText: 'hello\n' });

        const object = getToolModel(tool({ name: 'CodexPatch', input: fixtures.codexNullEntryPatchInput }));
        expect(object.fileChanges?.map((c) => c.path)).toEqual(['b.ts']);
        expect(object.fileChanges?.[0].patch).toContain('+++ b/b.ts');
    });

    it('CodexDiff: a multi-file unified diff is split per file', () => {
        const model = getToolModel(tool({ name: 'CodexDiff', input: { unified_diff: fixtures.codexMultiFileDiff } }));
        expect(model.fileChanges?.map((c) => c.path)).toEqual(['one.ts', 'two.ts']);
        expect(model.fileChanges?.[0].patch).toContain('-const b = 2;');
        expect(model.fileChanges?.[0].patch).not.toContain('export const c');
    });

    it('splitUnifiedDiff keeps a removed "--" line inside a hunk as content', () => {
        const patch = ['--- a/x.sql', '+++ b/x.sql', '@@ -1,2 +1,2 @@', ' select 1;', '-- old comment', '+-- new comment'].join('\n');
        const files = splitUnifiedDiff(patch);
        expect(files).toHaveLength(1);
        expect(files[0].fileName).toBe('x.sql');
    });

    it('Gemini edit: non-string texts are dropped instead of thrown', () => {
        const model = getToolModel(tool({ name: 'edit', input: fixtures.geminiEditNonStringInput }));
        expect(model.fileChanges?.[0].path).toBe('a.ts');
        expect(model.fileChanges?.[0].edits).toEqual([]);
    });

    it('Gemini execute: only the trailing metadata is stripped from the title', () => {
        expect(parseGeminiExecuteTitle(fixtures.geminiExecuteInput.toolCall.title)).toEqual({
            command: 'if [ -f package.json ]; then cat package.json; fi',
            cwd: '/repo',
            description: 'Read manifest',
        });
        expect(parseGeminiExecuteTitle('echo [hello] world').command).toBe('echo [hello] world');
        const model = getToolModel(tool({ name: 'execute', input: fixtures.geminiExecuteInput }));
        expect(model.command?.command).toBe('if [ -f package.json ]; then cat package.json; fi');
    });

    it('Codex compound commands keep their full text and every parsed operation', () => {
        const model = getToolModel(tool({ name: 'CodexBash', input: fixtures.codexCompoundBashInput }));
        expect(model.command?.command).toBe('cat a && cat b');
        expect(model.command?.operations.map((o) => o.path)).toEqual(['a', 'b']);
    });

    it('Edit / MultiEdit / Write produce file changes with edits', () => {
        const edit = getToolModel(tool({ name: 'Edit', input: { file_path: '/a.ts', old_string: 'x', new_string: 'y' } }));
        expect(edit.fileChanges?.[0]).toMatchObject({ path: '/a.ts', kind: 'modify', edits: [{ oldText: 'x', newText: 'y', replaceAll: false }] });
        const multi = getToolModel(tool({ name: 'MultiEdit', input: { file_path: '/a.ts', edits: [{ old_string: 'a', new_string: 'b' }, null, { old_string: 'c', new_string: 'd', replace_all: true }] } }));
        expect(multi.fileChanges?.[0].edits).toHaveLength(2);
        expect(multi.fileChanges?.[0].edits?.[1].replaceAll).toBe(true);
        const write = getToolModel(tool({ name: 'Write', input: { file_path: '/n.ts', content: 'hi' } }));
        expect(write.fileChanges?.[0]).toMatchObject({ kind: 'add', newText: 'hi' });
    });
});

describe('toolModel — never throws (#413)', () => {
    it('unwraps a 12,000-level nested structured error iteratively and keeps its reason', () => {
        let error: unknown = 'disk full';
        for (let i = 0; i < 12000; i++) error = { error };
        const model = buildToolModel(tool({ name: 'Read', state: 'error', result: error }));
        expect(model.outcome).toBe('failed');
        expect(model.errorMessage).toBe('disk full');
        expect(model.blocks[0].kind).toBe('structured');
    });

    it('terminates on a cyclic structured error and still classifies it as a failure', () => {
        const cyclic: { error: { error?: unknown } } = { error: {} };
        cyclic.error.error = cyclic;
        const model = buildToolModel(tool({ name: 'Read', state: 'error', result: cyclic }));
        expect(model.outcome).toBe('failed');
        expect(typeof model.errorMessage).toBe('string');
    });

    it('a deeply nested successful structured result projects without throwing', () => {
        let value: unknown = { ok: true };
        for (let i = 0; i < 12000; i++) value = { message: value };
        const model = buildToolModel(tool({ name: 'Read', state: 'completed', result: value }));
        expect(model.outcome).toBe('succeeded');
        expect(model.blocks).toHaveLength(1);
    });
});

describe('trimCommonIndent', () => {
    it('trims by one shared indent so indentation-only edits stay visible', () => {
        expect(trimCommonIndent(['        x', '    x'])).toEqual(['    x', 'x']);
        expect(trimCommonIndent(['    a\n    b', '    a\n  b'])).toEqual(['  a\n  b', '  a\nb']);
        expect(trimCommonIndent(['x', 'y'])).toEqual(['x', 'y']);
    });
});
