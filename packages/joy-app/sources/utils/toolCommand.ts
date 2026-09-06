const SHELL_WRAPPERS = new Set([
    'bash',
    '/bin/bash',
    'sh',
    '/bin/sh',
    'zsh',
    '/bin/zsh',
]);

// Characters that need no quoting in a POSIX shell word.
const SAFE_WORD = /^[A-Za-z0-9_@%+=:,./-]+$/;

/**
 * One argv element as a shell word: bare when it is plain, otherwise
 * single-quoted with embedded single quotes closed/escaped/reopened. An
 * empty argument becomes '' rather than vanishing.
 */
export function shellQuote(arg: string): string {
    if (arg === '') return "''";
    if (SAFE_WORD.test(arg)) return arg;
    return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/**
 * Display form of a tool's `command` — a string as-is, an argv array as the
 * shell line that would run it.
 *
 * Joining argv with spaces described a different command: `printf '<%s>'
 * 'hello world' ''` became `printf <%s> hello world` — the empty argument
 * gone, the format string now a redirection, the two-word argument split
 * (#456). Each element is shell-quoted; `sh -c <script>` is unwrapped to the
 * script only when nothing follows it (positional arguments would be lost).
 */
export function stringifyToolCommand(command: unknown): string | null {
    if (typeof command === 'string') {
        const trimmed = command.trim();
        return trimmed.length > 0 ? trimmed : null;
    }

    if (!Array.isArray(command)) {
        return null;
    }

    const parts = command.filter((part): part is string => typeof part === 'string');

    if (parts.length === 0 || parts.every((part) => part.trim().length === 0)) {
        return null;
    }

    if (parts.length === 3 && SHELL_WRAPPERS.has(parts[0]) && (parts[1] === '-c' || parts[1] === '-lc')) {
        const wrappedCommand = parts[2].trim();
        return wrappedCommand.length > 0 ? wrappedCommand : null;
    }

    return parts.map(shellQuote).join(' ');
}
