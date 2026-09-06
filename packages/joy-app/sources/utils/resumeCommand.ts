export type ResumeCommandMetadata = {
    path?: string | null;
    os?: string | null;
    flavor?: string | null;
    claudeSessionId?: string | null;
    codexThreadId?: string | null;
};

export type ResumeCommandBlock = {
    lines: string[];
    copyText: string;
};

function quotePosixPath(path: string): string {
    return `'${path.replace(/'/g, `'\\''`)}'`;
}

function quotePowerShellPath(path: string): string {
    return `'${path.replace(/'/g, `''`)}'`;
}

function isWindows(metadata: ResumeCommandMetadata): boolean {
    return metadata.os?.toLowerCase() === 'win32';
}

function buildResumeInvocation(metadata: ResumeCommandMetadata): string | null {
    if ((metadata.flavor === 'codex' || metadata.flavor === 'openai' || metadata.flavor === 'gpt') && metadata.codexThreadId) {
        return `joy new . --resume ${metadata.codexThreadId}`;
    }
    if (metadata.claudeSessionId) {
        return `joy new . --resume ${metadata.claudeSessionId}`;
    }
    return null;
}

function buildChangeDirectoryCommand(metadata: ResumeCommandMetadata): string | null {
    // Emptiness is checked separately from the value: the saved path is used
    // EXACTLY as recorded. Trimming it turned "/tmp/project " into another
    // directory before quoting (#443); only an all-whitespace path counts as
    // absent.
    const path = metadata.path;
    if (!path || path.trim().length === 0) {
        return null;
    }

    return isWindows(metadata)
        ? `Set-Location -LiteralPath ${quotePowerShellPath(path)}`
        : `cd ${quotePosixPath(path)}`;
}

/**
 * Chain the directory change and the resume invocation so the invocation runs
 * ONLY when the change succeeded. Joined by a newline (or an unconditional
 * `;`), a moved/missing project directory failed the `cd` and then started a
 * resume in whatever directory the shell happened to be in (#444). POSIX uses
 * `&&`; PowerShell 5.1 has no `&&`, so the invocation is gated on `$?`.
 */
function chainConditionally(changeDirectoryCommand: string, invocation: string, windows: boolean): string {
    return windows
        ? `${changeDirectoryCommand}; if ($?) { ${invocation} }`
        : `${changeDirectoryCommand} && ${invocation}`;
}

export function buildResumeCommandBlock(metadata: ResumeCommandMetadata): ResumeCommandBlock | null {
    const invocation = buildResumeInvocation(metadata);
    if (!invocation) {
        return null;
    }

    const changeDirectoryCommand = buildChangeDirectoryCommand(metadata);
    if (!changeDirectoryCommand) {
        return { lines: [invocation], copyText: invocation };
    }

    // `lines` stays two lines for display; the COPIED text is the conditional
    // one-liner so a paste can never run the resume after a failed cd (#444).
    return {
        lines: [changeDirectoryCommand, invocation],
        copyText: chainConditionally(changeDirectoryCommand, invocation, isWindows(metadata)),
    };
}

export function buildResumeCommand(metadata: ResumeCommandMetadata): string | null {
    const commandBlock = buildResumeCommandBlock(metadata);
    if (!commandBlock) {
        return null;
    }
    return commandBlock.copyText;
}
