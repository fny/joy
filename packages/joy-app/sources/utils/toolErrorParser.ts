import { parseBudget } from './parseBudget';

/**
 * Checks if an error message indicates a cancellation/interruption
 * 
 * Handles various cancellation error formats:
 * - <tool_use_error>...</tool_use_error>
 * - Error: [Request interrupted by user for tool use]
 * - Request interrupted
 * - User cancelled
 * - Operation cancelled
 */
export function isCancelError(message: string): boolean {
    // Check if the message is a string
    if (typeof message !== 'string') {
        return false;
    }

        // Check for a complete <tool_use_error>…</tool_use_error> pair
    if (findToolUseErrorTag(message, 0) !== null) {
        return true;
    }

    // Check for common cancellation patterns
    const cancelPatterns = [
        /\[Request interrupted by user for tool use\]/i,
        /Request interrupted/i,
        /User cancelled/i,
        /Operation cancelled/i,
        /Cancelled by user/i,
        /User aborted/i,
        /Operation aborted/i,
        /Interrupted by user/i,
        /The user doesn't want to proceed with this tool use\. The tool use was rejected/i
    ];

    return cancelPatterns.some(pattern => pattern.test(message));
}

/**
 * Parses error messages that contain <tool_use_error> tags
 * 
 * Example:
 * Input: "<tool_use_error>File has not been read yet. Read it first before writing to it.</tool_use_error>"
 * Output: { isToolUseError: true, errorMessage: "File has not been read yet. Read it first before writing to it." }
 */
export function parseToolUseError(message: string): {
    isToolUseError: boolean;
    errorMessage: string | null;
} {
    // Check if the message is a string
    if (typeof message !== 'string') {
        return {
            isToolUseError: false,
            errorMessage: null
        };
    }

        // First opening tag and the first closing tag after it (content may
    // span lines); linear scan, see findToolUseErrorTag.
    const tag = findToolUseErrorTag(message, 0);
    if (tag) {
        return {
            isToolUseError: true,
            errorMessage: tag.content ? tag.content.trim() : ''
        };
    }

    return {
        isToolUseError: false,
        errorMessage: null
    };
}

/**
 * Extracts all tool use errors from a message that might contain multiple
 */
export function parseAllToolUseErrors(message: string): string[] {
    if (typeof message !== 'string') {
        return [];
    }

        const errors: string[] = [];
    const budget = parseBudget();
    let from = 0;
    let tag: ToolUseErrorTag | null;
    while ((tag = findToolUseErrorTag(message, from)) !== null) {
        if (!budget.spend()) break;
        if (tag.content) {
            errors.push(tag.content.trim());
        }
        from = tag.end;
    }

    return errors;
}

const OPEN_TAG = '<tool_use_error>';
const CLOSE_TAG = '</tool_use_error>';

type ToolUseErrorTag = { content: string; end: number };

/**
 * Locate the next complete <tool_use_error>…</tool_use_error> pair at or
 * after `from` with two indexOf calls. The previous `/<tag>.*<\/tag>/s` and
 * `.*?` regexes rescanned the remaining message from EVERY opening tag, so
 * repeated unclosed openings were quadratic — 128k characters took ~0.8 s and
 * 256k ~3.3 s of blocked UI thread (#458). If the first opening tag has no
 * closing tag after it, no later one does either, so the scan stops there.
 */
function findToolUseErrorTag(message: string, from: number): ToolUseErrorTag | null {
    const open = message.indexOf(OPEN_TAG, from);
    if (open < 0) return null;
    const contentStart = open + OPEN_TAG.length;
    const close = message.indexOf(CLOSE_TAG, contentStart);
    if (close < 0) return null;
    return { content: message.slice(contentStart, close), end: close + CLOSE_TAG.length };
}

/**
 * Checks if a message contains any tool use error
 */
export function hasToolUseError(message: string): boolean {
    return parseToolUseError(message).isToolUseError;
}