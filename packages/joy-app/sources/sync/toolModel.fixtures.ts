/**
 * Captured provider shapes for the canonical tool model and the reducer
 * projection tests. Each fixture is a RAW record as the relay stores it
 * (post-decrypt, pre-normalize), so the tests exercise the whole ingestion
 * path: schema → normalizer → reducer → model. Shapes come from the issues
 * the model closes (multi-block results, structured Codex output, Gemini
 * titles, zero-valued session results, wrapped Claude failures).
 */

export const claudeAssistantToolUse = (toolId: string, name: string, input: unknown, uuid = `uuid-${toolId}`) => ({
    role: 'agent' as const,
    content: {
        type: 'output' as const,
        data: {
            type: 'assistant' as const,
            uuid,
            parentUuid: null,
            isSidechain: false,
            message: {
                role: 'assistant' as const,
                model: 'claude-sonnet-4-5',
                content: [{ type: 'tool_use' as const, id: toolId, name, input }],
                usage: { input_tokens: 10, output_tokens: 5 },
            },
        },
    },
});

export const claudeUserToolResult = (toolId: string, content: unknown, options: { isError?: boolean; toolUseResult?: unknown; uuid?: string } = {}) => ({
    role: 'agent' as const,
    content: {
        type: 'output' as const,
        data: {
            type: 'user' as const,
            uuid: options.uuid ?? `uuid-result-${toolId}`,
            parentUuid: null,
            isSidechain: false,
            message: {
                role: 'user' as const,
                content: [{ type: 'tool_result' as const, tool_use_id: toolId, content, ...(options.isError ? { is_error: true } : {}) }],
            },
            ...(options.toolUseResult !== undefined ? { toolUseResult: options.toolUseResult } : {}),
        },
    },
});

/** Claude Code: a multi-block Read result — every block must survive. */
export const claudeMultiBlockResult = claudeUserToolResult('toolu_read', [
    { type: 'text', text: 'First file' },
    { type: 'text', text: 'Second file' },
]);

/** Claude Code: an image block riding with text (pasted screenshot). */
export const claudeImageResult = claudeUserToolResult('toolu_img', [
    { type: 'text', text: 'Screenshot' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } },
]);

/** Claude Code: an ORDINARY failure wrapped in <tool_use_error> — not a cancellation. */
export const claudeToolUseError = claudeUserToolResult(
    'toolu_edit',
    '<tool_use_error>File has not been read yet. Read it first before writing to it.</tool_use_error>',
    { isError: true },
);

/** Claude Code: an interruption — a cancellation by its meaning. */
export const claudeInterrupted = claudeUserToolResult(
    'toolu_bash',
    '[Request interrupted by user for tool use]',
    { isError: true },
);

/** Claude Code: a rejected permission. */
export const claudeRejected = claudeUserToolResult(
    'toolu_write',
    "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file).",
    { isError: true },
);

/** Codex (hyphenated) tool-call-result with STRUCTURED output. */
export const codexStructuredResult = {
    role: 'agent' as const,
    content: {
        type: 'codex' as const,
        data: {
            type: 'tool-call-result' as const,
            callId: 'call_codex_1',
            id: 'codex-result-1',
            output: { stdout: 'compiled', stderr: '', exitCode: 0 },
        },
    },
};

/** Codex hyphenated result INSIDE an assistant/user record (the preprocess path). */
export const codexHyphenatedInUserRecord = {
    role: 'agent' as const,
    content: {
        type: 'output' as const,
        data: {
            type: 'user' as const,
            uuid: 'uuid-hyphen',
            parentUuid: null,
            message: {
                role: 'user' as const,
                content: [{ type: 'tool-call-result', callId: 'call_codex_2', output: { stdout: 'ok', exitCode: 0 } }],
            },
        },
    },
};

export const codexToolCall = (callId: string, name: string, input: unknown) => ({
    role: 'agent' as const,
    content: {
        type: 'codex' as const,
        data: { type: 'tool-call' as const, callId, id: `codex-call-${callId}`, name, input },
    },
});

/** ACP (Gemini / agy / OpenCode) tool-result with an explicit error flag. */
export const acpErrorResult = (provider: 'gemini' | 'opencode' | 'codex', callId: string, output: unknown, isError: boolean) => ({
    role: 'agent' as const,
    content: {
        type: 'acp' as const,
        provider,
        data: { type: 'tool-result' as const, callId, id: `acp-result-${callId}`, output, isError },
    },
});

export const acpToolCall = (provider: 'gemini' | 'opencode' | 'codex', callId: string, name: string, input: unknown) => ({
    role: 'agent' as const,
    content: {
        type: 'acp' as const,
        provider,
        data: { type: 'tool-call' as const, callId, id: `acp-call-${callId}`, name, input },
    },
});

/** Session protocol (pi / joy-daemon): tool-call-end carrying a ZERO result. */
export const sessionToolCallEnd = (call: string, result: unknown, isError?: boolean, turn = 'turn-1') => ({
    role: 'session' as const,
    content: {
        id: `sess-end-${call}`,
        role: 'agent' as const,
        turn,
        time: 1_700_000_000_000,
        ev: { t: 'tool-call-end' as const, call, result, ...(isError !== undefined ? { isError } : {}) },
    },
});

export const sessionToolCallStart = (call: string, name: string, args: unknown, turn = 'turn-1') => ({
    role: 'session' as const,
    content: {
        id: `sess-start-${call}`,
        role: 'agent' as const,
        turn,
        time: 1_700_000_000_000,
        ev: { t: 'tool-call-start' as const, call, name, title: name, description: '', args },
    },
});

/** Gemini execute: the command lives only in the title, with shell brackets. */
export const geminiExecuteInput = {
    toolCall: {
        title: 'if [ -f package.json ]; then cat package.json; fi [current working directory /repo] (Read manifest)',
    },
};

/** Gemini edit with a non-string payload where text is expected. */
export const geminiEditNonStringInput = {
    toolCall: { content: [{ path: 'a.ts', oldText: { text: 'before' }, newText: 17 }] },
};

/** Codex compound command with two parsed reads. */
export const codexCompoundBashInput = {
    command: ['bash', '-lc', 'cat a && cat b'],
    parsed_cmd: [
        { type: 'read', cmd: 'cat a', name: 'a' },
        { type: 'read', cmd: 'cat b', name: 'b' },
    ],
};

/** Codex list-form patch: content pair AND rename destination. */
export const codexListPatchInput = {
    fileChanges: [
        { path: 'a.ts', type: 'update', oldContent: 'old\n', newContent: 'new\n', move_path: 'b.ts' },
        null,
        { path: 'c.ts', type: 'add', content: 'hello\n' },
    ],
};

/** Codex object-form patch with a NULL entry. */
export const codexNullEntryPatchInput = {
    fileChanges: { 'a.ts': null, 'b.ts': { diff: '@@ -1 +1 @@\n-x\n+y' } },
};

/** Codex multi-file unified diff. */
export const codexMultiFileDiff = [
    '--- a/one.ts',
    '+++ b/one.ts',
    '@@ -1,2 +1,2 @@',
    ' const a = 1;',
    '-const b = 2;',
    '+const b = 3;',
    '--- a/two.ts',
    '+++ b/two.ts',
    '@@ -1 +1,2 @@',
    ' export {};',
    '+export const c = 1;',
].join('\n');
