/**
 * Canonical tool-call model (v1).
 *
 * Every harness (Claude, Codex, Gemini/agy, OpenCode, pi) reports a tool
 * invocation in its own shape, and the legacy `ToolCall` record keeps those
 * shapes raw: `input` is whatever the harness sent, `result` is a string, a
 * block array, a structured object, a number or nothing, and `state: 'error'`
 * covers failures, denials and interruptions alike. Twenty views each
 * interpreted that record on their own, so the same outcome rendered
 * differently (or crashed) depending on which card showed it.
 *
 * This module normalizes a tool call ONCE into a versioned record with:
 *   - stable identity (session / turn / message / call / parent call),
 *   - validated arguments (always a record; the unknown shape is kept raw),
 *   - an explicit outcome (`pending | succeeded | failed | cancelled | denied`),
 *   - ordered result blocks (text / image / structured — every block),
 *   - structured command / file-change data when the harness provides it,
 *   - the raw input and result preserved for a safe fallback.
 *
 * Views are presentation-only over this record. The reducer attaches the
 * model at projection time; `getToolModel` derives it for any legacy record
 * that reaches a view without one (demo data, older callers), so consumers
 * never branch on the provider shape again. Building the model never throws:
 * a malformed item is isolated into its raw fallback rather than surfacing as
 * a thrown render.
 */

import { isCancelError, parseToolUseError } from '@/utils/toolErrorParser';
import { stringifyToolCommand } from '@/utils/toolCommand';
import type { ToolCall } from './typesMessage';

export const TOOL_MODEL_VERSION = 1 as const;

export type ToolOutcome = 'pending' | 'succeeded' | 'failed' | 'cancelled' | 'denied';

export type ToolResultBlock =
    | { kind: 'text'; text: string }
    | { kind: 'image'; mediaType: string | null; data: string | null; url: string | null }
    | { kind: 'structured'; value: unknown };

export type ToolFamily =
    | 'terminal'
    | 'edit'
    | 'read'
    | 'search'
    | 'web'
    | 'task'
    | 'todo'
    | 'plan'
    | 'question'
    | 'mcp'
    | 'other';

export type ToolIdentity = {
    /** Harness call id (tool_use id / callId / permission id). */
    callId: string | null;
    /** Server message id the call was observed in. */
    messageId: string | null;
    sessionId: string | null;
    turnId: string | null;
    /** Owning Task/Agent call for a subagent (sidechain) tool. */
    parentCallId: string | null;
};

export type ToolArguments =
    | { ok: true; value: Record<string, unknown> }
    | { ok: false; value: Record<string, unknown>; raw: unknown; reason: string };

export type ToolCommandOperation = {
    kind: 'read' | 'write' | 'run' | 'other';
    path: string | null;
    command: string | null;
};

export type ToolCommandModel = {
    /** Display form of the command (shell wrapper unwrapped). */
    command: string;
    argv: string[] | null;
    cwd: string | null;
    description: string | null;
    /** Harness-parsed operations (Codex `parsed_cmd`); empty when absent. */
    operations: ToolCommandOperation[];
    stdout: string | null;
    stderr: string | null;
    exitCode: number | null;
};

export type ToolFileEdit = { oldText: string; newText: string; replaceAll: boolean };

export type ToolFileChangeModel = {
    path: string;
    kind: 'add' | 'modify' | 'delete' | 'move' | 'unknown';
    movePath: string | null;
    oldText: string | null;
    newText: string | null;
    /** Unified diff for this file when the harness supplied one (headers included). */
    patch: string | null;
    /** Ordered replacements (Edit / MultiEdit) when the change is expressed as edits. */
    edits: ToolFileEdit[] | null;
};

export type ToolCallModel = {
    version: typeof TOOL_MODEL_VERSION;
    identity: ToolIdentity;
    name: string;
    family: ToolFamily;
    arguments: ToolArguments;
    outcome: ToolOutcome;
    /** The harness flagged the result as an error (any failure class). */
    isError: boolean;
    /** Ordered result blocks — every block, not just the first. */
    blocks: ToolResultBlock[];
    /** All text blocks joined, or null when there is no text output. */
    outputText: string | null;
    /** Presenter-ready failure / denial / interruption reason. */
    errorMessage: string | null;
    command: ToolCommandModel | null;
    fileChanges: ToolFileChangeModel[] | null;
    raw: { input: unknown; result: unknown };
    timing: { createdAt: number; startedAt: number | null; completedAt: number | null };
};

/** The legacy fields the model is derived from (a `ToolCall` minus `model`). */
export type ToolCallLike = {
    name: string;
    state: 'running' | 'completed' | 'error';
    input: unknown;
    createdAt: number;
    startedAt: number | null;
    completedAt: number | null;
    description: string | null;
    result?: unknown;
    permission?: ToolCall['permission'];
};

// ---------------------------------------------------------------------------
// Families
// ---------------------------------------------------------------------------

const TERMINAL_TOOLS = new Set(['Bash', 'CodexBash', 'GeminiBash', 'shell', 'execute', 'run_shell_command']);
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'CodexPatch', 'GeminiPatch', 'edit', 'NotebookEdit', 'file-edit', 'CodexDiff', 'GeminiDiff']);
const READ_TOOLS = new Set(['Read', 'read', 'NotebookRead', 'LS']);
const SEARCH_TOOLS = new Set(['Grep', 'Glob', 'search', 'WebSearch']);
const WEB_TOOLS = new Set(['WebFetch']);
const TASK_TOOLS = new Set(['Task', 'Agent']);
const TODO_TOOLS = new Set(['TodoWrite']);
const PLAN_TOOLS = new Set(['ExitPlanMode', 'exit_plan_mode', 'EnterPlanMode', 'enter_plan_mode']);
const QUESTION_TOOLS = new Set(['AskUserQuestion']);

export function toolFamilyOf(name: string): ToolFamily {
    if (TERMINAL_TOOLS.has(name)) return 'terminal';
    if (EDIT_TOOLS.has(name)) return 'edit';
    if (READ_TOOLS.has(name)) return 'read';
    if (SEARCH_TOOLS.has(name)) return 'search';
    if (WEB_TOOLS.has(name)) return 'web';
    if (TASK_TOOLS.has(name)) return 'task';
    if (TODO_TOOLS.has(name)) return 'todo';
    if (PLAN_TOOLS.has(name)) return 'plan';
    if (QUESTION_TOOLS.has(name)) return 'question';
    if (name.startsWith('mcp__')) return 'mcp';
    return 'other';
}

// ---------------------------------------------------------------------------
// Small guards
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
    return typeof value === 'string' ? value : null;
}

function asNonEmptyString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function firstString(...values: unknown[]): string | null {
    for (const value of values) {
        if (typeof value === 'string') return value;
    }
    return null;
}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

export function normalizeToolArguments(input: unknown): ToolArguments {
    if (isRecord(input)) {
        return { ok: true, value: input };
    }
    if (input === undefined || input === null) {
        return { ok: false, value: {}, raw: input, reason: 'missing' };
    }
    return { ok: false, value: {}, raw: input, reason: Array.isArray(input) ? 'array' : typeof input };
}

// ---------------------------------------------------------------------------
// Result blocks
// ---------------------------------------------------------------------------

/**
 * Normalize any provider result shape into ordered blocks. Zero, `false` and
 * the empty string are valid results and are kept (as text); only `null` /
 * `undefined` mean "no output".
 */
export function toolResultBlocks(result: unknown): ToolResultBlock[] {
    if (result === undefined || result === null) return [];
    if (typeof result === 'string') return [{ kind: 'text', text: result }];
    if (typeof result === 'number' || typeof result === 'boolean' || typeof result === 'bigint') {
        return [{ kind: 'text', text: String(result) }];
    }
    if (Array.isArray(result)) {
        const blocks: ToolResultBlock[] = [];
        for (const item of result) {
            const block = blockFromContentItem(item);
            if (block) blocks.push(block);
        }
        return blocks;
    }
    if (isRecord(result)) {
        const single = blockFromContentItem(result);
        if (single && single.kind !== 'structured') return [single];
        return [{ kind: 'structured', value: result }];
    }
    return [{ kind: 'structured', value: result }];
}

function blockFromContentItem(item: unknown): ToolResultBlock | null {
    if (typeof item === 'string') return { kind: 'text', text: item };
    if (typeof item === 'number' || typeof item === 'boolean') return { kind: 'text', text: String(item) };
    if (!isRecord(item)) return item === null || item === undefined ? null : { kind: 'structured', value: item };
    const type = item.type;
    if (type === 'text' && typeof item.text === 'string') {
        return { kind: 'text', text: item.text };
    }
    if (type === 'image') {
        const source = isRecord(item.source) ? item.source : item;
        return {
            kind: 'image',
            mediaType: firstString(source.media_type, source.mediaType, source.mimeType),
            data: firstString(source.data),
            url: firstString(source.url),
        };
    }
    return { kind: 'structured', value: item };
}

export function joinTextBlocks(blocks: ToolResultBlock[]): string | null {
    const texts: string[] = [];
    for (const block of blocks) {
        if (block.kind === 'text') texts.push(block.text);
    }
    return texts.length > 0 ? texts.join('\n') : null;
}

// ---------------------------------------------------------------------------
// Outcome
// ---------------------------------------------------------------------------

const DENIED_PATTERNS = [
    /The user doesn't want to proceed with this tool use/i,
    /tool use was rejected/i,
    /permission (was )?denied/i,
];

/** Text a failed result carries, with the `<tool_use_error>` wrapper stripped. */
function failureTextOf(blocks: ToolResultBlock[], raw: unknown): string | null {
    const fromBlocks = (): string | null => {
        const text = joinTextBlocks(blocks);
        if (text !== null) return text;
        for (const block of blocks) {
            if (block.kind === 'structured') {
                const structured = structuredErrorText(block.value);
                if (structured !== null) return structured;
            }
        }
        return null;
    };
    const text = fromBlocks();
    if (text === null) {
        if (raw === undefined || raw === null) return null;
        return safeStringify(raw);
    }
    const parsed = parseToolUseError(text);
    if (parsed.isToolUseError) {
        return parsed.errorMessage && parsed.errorMessage.length > 0 ? parsed.errorMessage : text;
    }
    return text;
}

/** How far into a nested `{error: {error: ...}}` shape the unwrap will look. */
const STRUCTURED_ERROR_MAX_DEPTH = 65536;

/**
 * The human text inside a structured error. Iterative and bounded: a
 * 12,000-level `{error: {error: ...}}` result is a valid record that a
 * recursive unwrap turned into a RangeError, thrown from a function that is
 * documented never to throw (#413). A cyclic value stops at its first repeat.
 */
function structuredErrorText(value: unknown): string | null {
    if (!isRecord(value)) return null;
    type Frame = { record: Record<string, unknown>; index: number };
    const stack: Frame[] = [{ record: value, index: 0 }];
    const seen = new Set<object>([value]);
    while (stack.length > 0) {
        const frame = stack[stack.length - 1];
        const candidates = [frame.record.error, frame.record.message, frame.record.stderr, frame.record.reason];
        if (frame.index >= candidates.length) {
            stack.pop();
            continue;
        }
        const candidate = candidates[frame.index++];
        if (typeof candidate === 'string' && candidate.trim().length > 0) return candidate;
        if (isRecord(candidate) && !seen.has(candidate) && stack.length < STRUCTURED_ERROR_MAX_DEPTH) {
            seen.add(candidate);
            stack.push({ record: candidate, index: 0 });
        }
    }
    return safeStringify(value);
}

export function safeStringify(value: unknown): string {
    if (typeof value === 'string') return value;
    try {
        const json = JSON.stringify(value, null, 2);
        return json === undefined ? String(value) : json;
    } catch {
        return String(value);
    }
}

function classifyOutcome(tool: ToolCallLike, blocks: ToolResultBlock[]): { outcome: ToolOutcome; errorMessage: string | null } {
    const permission = tool.permission;
    if (permission?.status === 'denied') {
        return { outcome: 'denied', errorMessage: permission.reason ?? failureTextOf(blocks, tool.result) };
    }
    if (permission?.status === 'canceled') {
        return { outcome: 'cancelled', errorMessage: permission.reason ?? failureTextOf(blocks, tool.result) };
    }
    if (tool.state === 'running') {
        return { outcome: 'pending', errorMessage: null };
    }
    if (tool.state === 'error') {
        const text = failureTextOf(blocks, tool.result);
        if (text !== null) {
            if (DENIED_PATTERNS.some((pattern) => pattern.test(text))) {
                return { outcome: 'denied', errorMessage: text };
            }
            // Only the MEANING of the message marks an interruption — a
            // `<tool_use_error>` wrapper alone is how Claude reports every
            // ordinary tool failure ("File has not been read yet").
            if (isCancelError(stripToolUseErrorTags(text))) {
                return { outcome: 'cancelled', errorMessage: text };
            }
        }
        return { outcome: 'failed', errorMessage: text };
    }
    return { outcome: 'succeeded', errorMessage: null };
}

function stripToolUseErrorTags(text: string): string {
    return text.replace(/<\/?tool_use_error>/g, '');
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const GEMINI_CWD_MARKER = ' [current working directory ';

/**
 * Gemini's `execute` reports the command only inside `toolCall.title`, shaped
 * `<command> [current working directory <cwd>] (<description>)`. Strip only
 * that recognized trailing metadata — a bare ` [` is shell syntax
 * (`if [ -f x ]`), not the start of the metadata.
 */
export function parseGeminiExecuteTitle(title: string): { command: string; cwd: string | null; description: string | null } {
    const markerIndex = title.lastIndexOf(GEMINI_CWD_MARKER);
    if (markerIndex < 0) {
        return { command: title.trim(), cwd: null, description: null };
    }
    const command = title.slice(0, markerIndex).trim();
    const rest = title.slice(markerIndex + GEMINI_CWD_MARKER.length);
    const closeIndex = rest.indexOf(']');
    if (closeIndex < 0) {
        return { command, cwd: rest.trim() || null, description: null };
    }
    const cwd = rest.slice(0, closeIndex).trim() || null;
    const tail = rest.slice(closeIndex + 1).trim();
    const descriptionMatch = tail.match(/^\((.*)\)$/s);
    return { command, cwd, description: descriptionMatch ? descriptionMatch[1].trim() || null : null };
}

function parsedOperations(value: unknown): ToolCommandOperation[] {
    if (!Array.isArray(value)) return [];
    const operations: ToolCommandOperation[] = [];
    for (const item of value) {
        if (!isRecord(item)) continue;
        const type = asString(item.type);
        const kind: ToolCommandOperation['kind'] = type === 'read' ? 'read' : type === 'write' ? 'write' : type === 'bash' || type === 'run' || type === 'exec' ? 'run' : 'other';
        operations.push({ kind, path: asNonEmptyString(item.name), command: asNonEmptyString(item.cmd) });
    }
    return operations;
}

function buildCommandModel(name: string, args: Record<string, unknown>, tool: ToolCallLike, blocks: ToolResultBlock[]): ToolCommandModel | null {
    const family = toolFamilyOf(name);
    if (family !== 'terminal') return null;

    const argv = Array.isArray(args.command) ? args.command.filter((part): part is string => typeof part === 'string') : null;
    const operations = parsedOperations(args.parsed_cmd);
    let command: string | null = null;
    // Gemini's `run_shell_command` names its working directory `directory`.
    let cwd = asNonEmptyString(args.cwd) ?? asNonEmptyString(args.directory);
    let description = asNonEmptyString(tool.description) ?? asNonEmptyString(args.description);

    // A single harness-parsed operation is the command; a compound command
    // (`cat a && cat b`) keeps its full text — never just the first part.
    if (operations.length === 1 && operations[0].command) {
        command = operations[0].command;
    }
    if (command === null) {
        command = stringifyToolCommand(args.command);
    }
    if (command === null) {
        const toolCall = isRecord(args.toolCall) ? args.toolCall : null;
        const title = asNonEmptyString(toolCall?.title) ?? asNonEmptyString(args.title);
        if (title) {
            const parsed = parseGeminiExecuteTitle(title);
            command = parsed.command;
            cwd = cwd ?? parsed.cwd;
            description = description ?? parsed.description;
        }
    }
    if (command === null && operations.length > 0) {
        command = operations.map((operation) => operation.command).filter((value): value is string => value !== null).join(' && ') || null;
    }
    if (command === null) return null;

    let stdout: string | null = null;
    let stderr: string | null = null;
    let exitCode: number | null = null;
    for (const block of blocks) {
        if (block.kind === 'structured' && isRecord(block.value)) {
            stdout = stdout ?? asString(block.value.stdout);
            stderr = stderr ?? asString(block.value.stderr);
            exitCode = exitCode ?? asNumber(block.value.exit_code) ?? asNumber(block.value.exitCode) ?? asNumber(block.value.code);
        }
    }
    if (stdout === null && stderr === null) {
        const text = joinTextBlocks(blocks);
        if (text !== null) {
            if (tool.state === 'error') stderr = text; else stdout = text;
        }
    }

    return { command, argv, cwd, description, operations, stdout, stderr, exitCode };
}

/** Longest one-line command preview a card header / summary row shows. */
export const COMMAND_PREVIEW_MAX_LENGTH = 200;

// `<<EOF`, `<<-EOF`, `<< 'EOF'`, `<<"EOF"`, `<<\EOF` — a heredoc opener.
const HEREDOC_RE = /<<-?\s*['"\\]?\w/;

/**
 * The ONE bounded, single-line projection of a command for every live
 * preview — the compact card header, the group summary row, the Task child
 * row, the detail header — running or settled alike. Each surface used to cut
 * the command its own way (the first `parsed_cmd` of a compound Codex
 * command, a Gemini title sliced at its first " [", the first 20 or 50
 * characters), so the same call previewed differently from card to card
 * (#413 #392 #394 #388).
 *
 * The whole command is kept on one line: newlines and runs of whitespace
 * collapse to one space, so `a && \` + newline + `  b | c` previews as
 * `a && b | c`. A heredoc is the exception — its body is data, not the
 * command — so `cat <<'EOF' > f` + body previews as the first line followed
 * by an ellipsis. Anything longer than `maxLength` is cut with an ellipsis, so
 * a pathological command can never blow up a header.
 */
export function toolCommandPreview(command: string, maxLength: number = COMMAND_PREVIEW_MAX_LENGTH): string {
    const lines = command.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
    if (lines.length === 0) return '';
    let preview: string;
    if (lines.length > 1 && HEREDOC_RE.test(lines[0])) {
        preview = `${lines[0].replace(/\s+/g, ' ')} …`;
    } else {
        preview = lines.map((line) => line.replace(/\\$/, '').trim()).join(' ').replace(/\s+/g, ' ').trim();
    }
    if (maxLength > 0 && preview.length > maxLength) {
        return `${preview.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
    }
    return preview;
}

/** The bounded one-line preview of a model's command, or null for a non-terminal call. */
export function commandPreviewOf(model: ToolCallModel, maxLength?: number): string | null {
    const command = model.command?.command;
    if (typeof command !== 'string') return null;
    const preview = toolCommandPreview(command, maxLength);
    return preview.length > 0 ? preview : null;
}

// ---------------------------------------------------------------------------
// File changes
// ---------------------------------------------------------------------------

function editOf(oldText: unknown, newText: unknown, replaceAll: unknown): ToolFileEdit | null {
    const oldString = asString(oldText);
    const newString = asString(newText);
    if (oldString === null && newString === null) return null;
    return { oldText: oldString ?? '', newText: newString ?? '', replaceAll: replaceAll === true };
}

function changeFromEdits(path: string, edits: ToolFileEdit[]): ToolFileChangeModel {
    const single = edits.length === 1 ? edits[0] : null;
    return {
        path,
        kind: 'modify',
        movePath: null,
        oldText: single ? single.oldText : null,
        newText: single ? single.newText : null,
        patch: null,
        edits,
    };
}

type PatchEntryShape = {
    path: string;
    type: string | null;
    movePath: string | null;
    diff: string | null;
    oldText: string | null;
    newText: string | null;
};

function readPatchEntry(path: string, entry: unknown): PatchEntryShape | null {
    if (!isRecord(entry)) return null;
    const kind = isRecord(entry.kind) ? entry.kind : null;
    const type = asString(entry.type) ?? asString(kind?.type);
    const movePath = asNonEmptyString(kind?.move_path) ?? asNonEmptyString(entry.move_path) ?? asNonEmptyString(entry.movePath);
    const diff = asString(entry.diff) ?? asString(entry.unified_diff);
    const add = isRecord(entry.add) ? entry.add : null;
    const modify = isRecord(entry.modify) ? entry.modify : null;
    const del = isRecord(entry.delete) ? entry.delete : null;

    let oldText: string | null = null;
    let newText: string | null = null;
    if (modify) {
        oldText = asString(modify.old_content) ?? asString(modify.oldContent);
        newText = asString(modify.new_content) ?? asString(modify.newContent);
    }
    oldText = oldText ?? asString(entry.oldContent) ?? asString(entry.old_content);
    newText = newText ?? asString(entry.newContent) ?? asString(entry.new_content);
    if (add) {
        oldText = oldText ?? '';
        newText = newText ?? asString(add.content);
    }
    if (del) {
        oldText = oldText ?? asString(del.content);
        newText = newText ?? '';
    }
    const content = asString(entry.content);
    if (type === 'add' && content !== null) {
        oldText = oldText ?? '';
        newText = newText ?? content;
    }
    if (type === 'delete' && content !== null) {
        oldText = oldText ?? content;
        newText = newText ?? '';
    }
    return { path, type, movePath, diff, oldText, newText };
}

function patchKind(entry: PatchEntryShape): ToolFileChangeModel['kind'] {
    if (entry.movePath) return 'move';
    switch (entry.type) {
        case 'add':
        case 'create':
            return 'add';
        case 'delete':
        case 'remove':
            return 'delete';
        case 'update':
        case 'modify':
            return 'modify';
        default:
            if (entry.oldText === '' && entry.newText !== null && entry.newText !== '') return 'add';
            if (entry.newText === '' && entry.oldText !== null && entry.oldText !== '') return 'delete';
            return entry.diff !== null || entry.oldText !== null || entry.newText !== null ? 'modify' : 'unknown';
    }
}

function materializePatch(diff: string, path: string, kind: ToolFileChangeModel['kind']): string {
    if (
        diff.startsWith('diff --git ')
        || diff.startsWith('--- ')
        || diff.startsWith('+++ ')
        || diff.includes('\n--- ')
        || diff.includes('\n+++ ')
    ) {
        return diff;
    }
    const oldPath = kind === 'add' ? '/dev/null' : `a/${path}`;
    const newPath = kind === 'delete' ? '/dev/null' : `b/${path}`;
    return `--- ${oldPath}\n+++ ${newPath}\n${diff}`;
}

function changesFromPatchInput(args: Record<string, unknown>): ToolFileChangeModel[] {
    const entries: PatchEntryShape[] = [];
    const collect = (source: unknown) => {
        if (Array.isArray(source)) {
            for (const item of source) {
                if (!isRecord(item)) continue;
                const path = asNonEmptyString(item.path) ?? asNonEmptyString(item.file_path) ?? asNonEmptyString(item.filePath);
                if (!path) continue;
                const entry = readPatchEntry(path.trim(), item);
                if (entry) entries.push(entry);
            }
        } else if (isRecord(source)) {
            for (const [path, item] of Object.entries(source)) {
                // A null / non-object entry is a malformed item — isolate it,
                // never dereference it.
                const entry = readPatchEntry(path, item);
                if (entry) entries.push(entry);
            }
        }
    };
    collect(args.changes);
    if (entries.length === 0) collect(args.fileChanges);

    return entries.map((entry) => {
        const kind = patchKind(entry);
        return {
            path: entry.path,
            kind,
            movePath: entry.movePath,
            oldText: entry.oldText,
            newText: entry.newText,
            patch: entry.diff !== null ? materializePatch(entry.diff, entry.path, kind) : null,
            edits: null,
        };
    });
}

/**
 * Split a unified diff that touches several files into one patch per file.
 * A new file starts at `diff --git` or at a `--- x` / `+++ y` header pair
 * outside a hunk (hunk bounds are tracked from the `@@` counts so a removed
 * `--` line inside a hunk is never mistaken for a header).
 */
export function splitUnifiedDiff(patch: string): Array<{ fileName: string | null; patch: string }> {
    type FileSection = { fileName: string | null; lines: string[] };
    const lines = patch.split('\n');
    const files: FileSection[] = [];
    let current: FileSection | null = null;
    let remainingOld = 0;
    let remainingNew = 0;

    const inHunk = () => remainingOld > 0 || remainingNew > 0;
    const start = (): FileSection => {
        const section: FileSection = { fileName: null, lines: [] };
        files.push(section);
        remainingOld = 0;
        remainingNew = 0;
        return section;
    };
    const pathOf = (header: string): string | null => {
        const raw = header.slice(4).trim();
        if (raw === '/dev/null' || raw.length === 0) return null;
        return raw.replace(/^[ab]\//, '');
    };

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.startsWith('diff --git ')) {
            current = start();
            current.lines.push(line);
            continue;
        }
        if (!inHunk() && line.startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) {
            const hasHeaderAlready = current !== null && current.lines.some((l: string) => l.startsWith('+++ '));
            if (current === null || hasHeaderAlready) current = start();
            current.lines.push(line, lines[i + 1]);
            current.fileName = pathOf(lines[i + 1]) ?? pathOf(line);
            i += 1;
            continue;
        }
        if (current === null) current = start();
        const hunk = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
        if (hunk) {
            remainingOld = hunk[2] === undefined ? 1 : parseInt(hunk[2], 10);
            remainingNew = hunk[4] === undefined ? 1 : parseInt(hunk[4], 10);
            current.lines.push(line);
            continue;
        }
        if (inHunk()) {
            if (line.startsWith('+')) remainingNew = Math.max(0, remainingNew - 1);
            else if (line.startsWith('-')) remainingOld = Math.max(0, remainingOld - 1);
            else if (!line.startsWith('\\')) {
                remainingOld = Math.max(0, remainingOld - 1);
                remainingNew = Math.max(0, remainingNew - 1);
            }
        }
        current.lines.push(line);
    }

    return files
        .filter((file) => file.lines.some((line) => line.trim().length > 0))
        .map((file) => ({ fileName: file.fileName, patch: file.lines.join('\n') }));
}

function geminiEditContent(args: Record<string, unknown>): { path: string | null; oldText: unknown; newText: unknown } {
    const toolCall = isRecord(args.toolCall) ? args.toolCall : null;
    const nested = Array.isArray(toolCall?.content) && isRecord(toolCall!.content[0]) ? (toolCall!.content[0] as Record<string, unknown>) : null;
    if (nested) {
        return { path: asNonEmptyString(nested.path), oldText: nested.oldText, newText: nested.newText };
    }
    const arrayForm = Array.isArray(args.input) && isRecord(args.input[0]) ? (args.input[0] as Record<string, unknown>) : null;
    if (arrayForm) {
        return { path: asNonEmptyString(arrayForm.path), oldText: arrayForm.oldText, newText: arrayForm.newText };
    }
    return {
        path: asNonEmptyString(args.path) ?? asNonEmptyString(args.file_path),
        oldText: args.oldText ?? args.old_string,
        newText: args.newText ?? args.new_string,
    };
}

function buildFileChanges(name: string, args: Record<string, unknown>): ToolFileChangeModel[] | null {
    switch (name) {
        case 'Edit': {
            const edit = editOf(args.old_string, args.new_string, args.replace_all);
            const path = asNonEmptyString(args.file_path);
            if (!edit && !path) return null;
            return [changeFromEdits(path ?? '', edit ? [edit] : [])];
        }
        case 'MultiEdit': {
            const path = asNonEmptyString(args.file_path);
            const edits: ToolFileEdit[] = [];
            if (Array.isArray(args.edits)) {
                for (const item of args.edits) {
                    if (!isRecord(item)) continue;
                    const edit = editOf(item.old_string, item.new_string, item.replace_all);
                    if (edit) edits.push(edit);
                }
            }
            if (!path && edits.length === 0) return null;
            return [changeFromEdits(path ?? '', edits)];
        }
        case 'Write': {
            const path = asNonEmptyString(args.file_path);
            const content = asString(args.content);
            if (!path && content === null) return null;
            return [{ path: path ?? '', kind: 'add', movePath: null, oldText: '', newText: content, patch: null, edits: null }];
        }
        case 'NotebookEdit': {
            const path = asNonEmptyString(args.notebook_path);
            const source = asString(args.new_source);
            if (!path && source === null) return null;
            return [{ path: path ?? '', kind: 'modify', movePath: null, oldText: null, newText: source, patch: null, edits: null }];
        }
        case 'edit': {
            const content = geminiEditContent(args);
            const edit = editOf(content.oldText, content.newText, false);
            if (!edit && !content.path) return null;
            return [changeFromEdits(content.path ?? '', edit ? [edit] : [])];
        }
        case 'file-edit': {
            const path = asNonEmptyString(args.filePath) ?? asNonEmptyString(args.path);
            const diff = asString(args.diff);
            const oldText = asString(args.oldContent);
            const newText = asString(args.newContent);
            if (!path && diff === null && oldText === null && newText === null) return null;
            const kind: ToolFileChangeModel['kind'] = oldText === '' && newText ? 'add' : 'modify';
            return [{
                path: path ?? '',
                kind,
                movePath: null,
                oldText,
                newText,
                patch: diff !== null ? materializePatch(diff, path ?? 'file', kind) : null,
                edits: null,
            }];
        }
        case 'CodexPatch':
        case 'GeminiPatch': {
            const changes = changesFromPatchInput(args);
            return changes.length > 0 ? changes : null;
        }
        case 'CodexDiff':
        case 'GeminiDiff': {
            const diff = asString(args.unified_diff);
            const filePath = asNonEmptyString(args.filePath);
            if (diff === null) {
                return filePath ? [{ path: filePath, kind: 'unknown', movePath: null, oldText: null, newText: null, patch: null, edits: null }] : null;
            }
            const files = splitUnifiedDiff(diff);
            if (files.length === 0) return null;
            return files.map((file) => ({
                path: file.fileName ?? filePath ?? '',
                kind: 'modify' as const,
                movePath: null,
                oldText: null,
                newText: null,
                patch: file.patch,
                edits: null,
            }));
        }
        default:
            return null;
    }
}

// ---------------------------------------------------------------------------
// Indentation
// ---------------------------------------------------------------------------

/**
 * Strip the indentation shared by ALL the given texts (min over every
 * non-blank line across all of them). Trimming each side of an edit on its
 * own erased indentation-only changes and misattributed which line moved.
 */
export function trimCommonIndent(texts: string[]): string[] {
    let minIndent = Infinity;
    for (const text of texts) {
        for (const line of text.split('\n')) {
            if (line.trim().length === 0) continue;
            const indent = line.match(/^[ \t]*/)![0].length;
            if (indent < minIndent) minIndent = indent;
        }
    }
    if (!Number.isFinite(minIndent) || minIndent === 0) return texts;
    return texts.map((text) => text.split('\n').map((line) => (line.trim().length === 0 ? line : line.slice(minIndent))).join('\n'));
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

const EMPTY_IDENTITY: ToolIdentity = { callId: null, messageId: null, sessionId: null, turnId: null, parentCallId: null };

/**
 * Build the canonical record. Never throws: any failure while interpreting
 * the provider shape yields a model with the raw fallback and no structured
 * command / file-change data, so a malformed item renders as raw data instead
 * of taking the card (or the whole list) down with it.
 */
export function buildToolModel(tool: ToolCallLike, identity: Partial<ToolIdentity> = {}): ToolCallModel {
    const fullIdentity: ToolIdentity = { ...EMPTY_IDENTITY, ...identity };
    const name = typeof tool.name === 'string' ? tool.name : String(tool.name);
    const args = normalizeToolArguments(tool.input);
    const timing = { createdAt: tool.createdAt, startedAt: tool.startedAt, completedAt: tool.completedAt };
    const raw = { input: tool.input, result: tool.result };

    let blocks: ToolResultBlock[];
    try {
        blocks = toolResultBlocks(tool.result);
    } catch {
        blocks = [{ kind: 'structured', value: tool.result }];
    }
    // Classification runs INSIDE the guard: a permitted result must never
    // throw during projection after its record was marked processed (#413).
    let outcome: ToolOutcome;
    let errorMessage: string | null;
    try {
        ({ outcome, errorMessage } = classifyOutcome(tool, blocks));
    } catch {
        ({ outcome, errorMessage } = fallbackOutcome(tool));
    }

    let command: ToolCommandModel | null = null;
    let fileChanges: ToolFileChangeModel[] | null = null;
    try {
        command = buildCommandModel(name, args.value, tool, blocks);
    } catch {
        command = null;
    }
    try {
        fileChanges = buildFileChanges(name, args.value);
    } catch {
        fileChanges = null;
    }
    let outputText: string | null;
    try {
        outputText = joinTextBlocks(blocks);
    } catch {
        outputText = null;
    }

    return {
        version: TOOL_MODEL_VERSION,
        identity: fullIdentity,
        name,
        family: toolFamilyOf(name),
        arguments: args,
        outcome,
        isError: outcome === 'failed' || outcome === 'denied' || outcome === 'cancelled',
        blocks,
        outputText,
        errorMessage,
        command,
        fileChanges,
        raw,
        timing,
    };
}

/** The outcome by record state alone — what is left when classification itself failed. */
function fallbackOutcome(tool: ToolCallLike): { outcome: ToolOutcome; errorMessage: string | null } {
    if (tool.permission?.status === 'denied') return { outcome: 'denied', errorMessage: tool.permission.reason ?? null };
    if (tool.permission?.status === 'canceled') return { outcome: 'cancelled', errorMessage: tool.permission.reason ?? null };
    if (tool.state === 'running') return { outcome: 'pending', errorMessage: null };
    if (tool.state === 'error') return { outcome: 'failed', errorMessage: null };
    return { outcome: 'succeeded', errorMessage: null };
}

const derivedModels = new WeakMap<object, ToolCallModel>();

/**
 * The model for a `ToolCall`: the one the reducer attached, or one derived
 * (and cached per record identity) for legacy records that carry none.
 */
export function getToolModel(tool: ToolCall): ToolCallModel {
    if (tool.model && tool.model.version === TOOL_MODEL_VERSION) {
        return tool.model;
    }
    const cached = derivedModels.get(tool);
    if (cached) return cached;
    const built = buildToolModel(tool);
    derivedModels.set(tool, built);
    return built;
}

/** Convenience: the validated argument record (always an object). */
export function toolArgs(tool: ToolCall): Record<string, unknown> {
    return getToolModel(tool).arguments.value;
}
