import { ToolCall } from '@/sync/typesMessage';
import { getToolModel } from '@/sync/toolModel';
import { t } from '@/text';

const TERMINAL_TOOL_NAMES = new Set([
    'Bash',
    'CodexBash',
    'GeminiBash',
    'shell',
    'execute',
]);

const EDIT_TOOL_NAMES = new Set([
    'Edit',
    'MultiEdit',
    'Write',
    'CodexPatch',
    'GeminiPatch',
    'edit',
    'NotebookEdit',
]);

const READ_TOOL_NAMES = new Set([
    'Read',
    'read',
    'NotebookRead',
    'LS',
]);

const SEARCH_TOOL_NAMES = new Set([
    'Grep',
    'Glob',
    'search',
    'WebSearch',
]);

const WEB_TOOL_NAMES = new Set([
    'WebFetch',
]);

const TASK_TOOL_NAMES = new Set([
    'Task',
    'Agent',
]);

export type ToolSummaryCategory = 'terminal' | 'edit' | 'read' | 'search' | 'web' | 'task' | 'other';

export function isTerminalToolName(name: string): boolean {
    return TERMINAL_TOOL_NAMES.has(name);
}

export function shouldRenderToolCardHeader(toolName: string, platformOS: string): boolean {
    return !(platformOS === 'web' && toolName === 'CodexPatch');
}

export function getToolSummaryCategory(toolName: string): ToolSummaryCategory {
    if (TERMINAL_TOOL_NAMES.has(toolName)) {
        return 'terminal';
    }
    if (EDIT_TOOL_NAMES.has(toolName)) {
        return 'edit';
    }
    if (READ_TOOL_NAMES.has(toolName)) {
        return 'read';
    }
    if (SEARCH_TOOL_NAMES.has(toolName)) {
        return 'search';
    }
    if (WEB_TOOL_NAMES.has(toolName)) {
        return 'web';
    }
    if (TASK_TOOL_NAMES.has(toolName)) {
        return 'task';
    }
    return 'other';
}

/**
 * Title of a compact transcript row. An edit row names its OUTCOME: only a
 * succeeded edit reads "Edited file" — a running, failed, denied or cancelled
 * one says so instead of claiming a change that has not happened (#318).
 */
export function getToolSummaryTitle(category: ToolSummaryCategory, tool: ToolCall): string {
    switch (category) {
        case 'terminal':
            return t('tools.names.terminal');
        case 'edit': {
            const outcome = getToolModel(tool).outcome;
            if (outcome === 'succeeded') {
                return t('toolGroup.editedFile');
            }
            return `${t('tools.names.editFile')} · ${t(`tools.outcome.${outcome}`)}`;
        }
        case 'read':
            return t('tools.names.readFile');
        case 'search':
            return t('tools.names.search');
        case 'web':
            return t('tools.names.fetchUrl');
        case 'task':
            return t('tools.names.task');
        default:
            return tool.name;
    }
}

export function getToolSummaryDetail(tool: ToolCall): string | null {
    const terminalCommand = getTerminalToolCommand(tool);
    if (terminalCommand) {
        return terminalCommand;
    }

    // The validated argument record: a null / array payload reads as {}.
    const args = getToolModel(tool).arguments.value;

    const filePath = args.file_path;
    if (typeof filePath === 'string' && filePath.trim().length > 0) {
        return filePath.trim();
    }

    const patchFiles = getPatchFiles(args);
    if (patchFiles.length > 0) {
        if (patchFiles.length === 1) {
            return patchFiles[0];
        }
        return `${patchFiles[0]} +${patchFiles.length - 1}`;
    }

    const path = args.path;
    if (typeof path === 'string' && path.trim().length > 0) {
        return path.trim();
    }

    const pattern = args.pattern;
    if (typeof pattern === 'string' && pattern.trim().length > 0) {
        return pattern.trim();
    }

    const url = args.url;
    if (typeof url === 'string' && url.trim().length > 0) {
        return url.trim();
    }

    return tool.description?.trim() || null;
}

/**
 * The command a terminal card header / summary row shows — the canonical
 * model's command, the same text the card body renders. The previous
 * extractor picked the first `parsed_cmd` of a compound Codex command
 * (`cat a && cat b` showed `cat a`, #286) and sliced a Gemini title at its
 * first " [" (`if [ -f x ]; ...` showed `if`, #295).
 */
export function getTerminalToolCommand(tool: ToolCall): string | null {
    if (!isTerminalToolName(tool.name)) {
        return null;
    }
    const command = getToolModel(tool).command?.command ?? null;
    if (command === null) {
        return null;
    }
    const trimmed = command.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function getPatchFiles(input: any): string[] {
    if (input?.changes && typeof input.changes === 'object' && !Array.isArray(input.changes)) {
        return Object.keys(input.changes);
    }
    if (input?.fileChanges && typeof input.fileChanges === 'object' && !Array.isArray(input.fileChanges)) {
        return Object.keys(input.fileChanges);
    }
    if (Array.isArray(input?.changes)) {
        return input.changes
            .map((change: unknown) => {
                if (!change || typeof change !== 'object' || Array.isArray(change)) {
                    return null;
                }
                const path = (change as { path?: unknown }).path;
                return typeof path === 'string' && path.trim().length > 0 ? path.trim() : null;
            })
            .filter((path: string | null): path is string => path !== null);
    }
    if (Array.isArray(input?.fileChanges)) {
        return input.fileChanges
            .map((change: unknown) => {
                if (!change || typeof change !== 'object' || Array.isArray(change)) {
                    return null;
                }
                const path = (change as { path?: unknown }).path;
                return typeof path === 'string' && path.trim().length > 0 ? path.trim() : null;
            })
            .filter((path: string | null): path is string => path !== null);
    }
    return [];
}
