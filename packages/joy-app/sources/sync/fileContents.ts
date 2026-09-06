/**
 * File contents and per-path git diffs as resources (sync/resource).
 *
 * ONE definition for every reader — the file panel, the file screen, the
 * all-files diff and the prefetcher — so they share one cache keyed by the
 * real identity (session + absolute path; session + repo-relative path +
 * diff options) and one ownership rule: the newest read or write of a key
 * wins. The store's `sessionFileCache` and the prefetch commit gate that
 * coordinated two writers for the same file are gone.
 */
import { sessionGitDiff, sessionReadFile, type OpsFailure } from './ops';
import { resources, type ResourceOutcome, type ResourceSpec } from './resource';
import { isBinaryPath } from '@/utils/binaryFile';

export interface FileContents {
    /** The daemon's bytes as received — downloads write THESE (#164), images render from them. */
    base64: string;
    /** UTF-8 text, or null for a binary file. */
    content: string | null;
    isBinary: boolean;
}

const FILE_FAMILY = 'file';
const DIFF_FAMILY = 'git-diff';
// Bytes bound the payloads, entries bound the metadata (a failed, empty or
// binary read costs a slot too), age reclaims what nobody revisits. An entry
// on screen is exempt only while it is mounted (sync/resource.ts header).
resources.defineFamily(FILE_FAMILY, {
    maxBytes: 24 * 1024 * 1024,
    maxEntries: 512,
    maxAgeMs: 30 * 60_000,
    size: (d) => { const f = d as FileContents; return f.base64.length + (f.content?.length ?? 0); },
});
resources.defineFamily(DIFF_FAMILY, {
    maxBytes: 8 * 1024 * 1024,
    maxEntries: 1024,
    maxAgeMs: 30 * 60_000,
    size: (d) => (d as string).length,
});

export function fileContentsKey(sessionId: string, absolutePath: string): string {
    return `file:${sessionId}:${absolutePath}`;
}

/**
 * One rule for every file/diff read: no machine context → `unavailable`
 * (the next policy trigger retries, no error shown); a transport failure
 * (the tunnel threw or timed out) → THROWN, so the spec's bounded retry
 * fires; the daemon's own refusal → terminal `error`.
 */
function failed(res: { error?: string; failure?: OpsFailure }, fallback: string): ResourceOutcome<never> {
    const reason = res.error || fallback;
    if (res.failure === 'no-context') return { kind: 'unavailable', reason };
    if (res.failure === 'transport') throw new Error(reason);
    return { kind: 'error', reason };
}

function decodeBase64ToBytes(base64: string): Uint8Array {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

/**
 * Text or binary, from the bytes: a known binary extension is never decoded;
 * otherwise a decode failure, a NUL byte or >10% control characters means
 * binary. An empty file is text (#87).
 */
export function decodeFileContents(path: string, base64: string): FileContents {
    if (isBinaryPath(path)) return { base64, content: null, isBinary: true };
    let bytes: Uint8Array;
    let decoded: string;
    try {
        bytes = decodeBase64ToBytes(base64);
        decoded = new TextDecoder().decode(bytes);
    } catch {
        return { base64, content: null, isBinary: true };
    }
    if (decoded.length === 0) return { base64, content: '', isBinary: false };
    const hasNullBytes = bytes.some((b) => b === 0);
    let nonPrintable = 0;
    for (let i = 0; i < decoded.length; i++) {
        const code = decoded.charCodeAt(i);
        if (code < 32 && code !== 9 && code !== 10 && code !== 13) nonPrintable++;
    }
    if (hasNullBytes || nonPrintable / decoded.length > 0.1) return { base64, content: null, isBinary: true };
    return { base64, content: decoded, isBinary: false };
}

/**
 * The file at `absolutePath` on the session's machine. `version` is the
 * caller's revision of the repository (the prefetcher passes the changed
 * list's revision): contents fetched under an older revision are stale for
 * it — refetched, or served by one trailing read when a read is already
 * active — while the last good contents stay visible. A caller without a
 * revision (the file panel) takes whatever is cached and revalidates by time.
 */
export function fileContentsSpec(sessionId: string, absolutePath: string, version?: string): ResourceSpec<FileContents> {
    return {
        key: fileContentsKey(sessionId, absolutePath),
        family: FILE_FAMILY,
        version,
        // Shown from cache on revisit, revalidated in the background.
        staleTime: 0,
        // A dropped tunnel request is worth one more try; a daemon error is not.
        retry: { attempts: 1, delayMs: 500 },
        fetch: async () => {
            const res = await sessionReadFile(sessionId, absolutePath);
            if (!res.success) return failed(res, 'Failed to read file');
            return { kind: 'ok', data: decodeFileContents(absolutePath, res.content ?? '') };
        },
    };
}

export interface GitDiffOptions {
    /** Working tree vs HEAD (the all-files view); default index vs working tree. */
    head?: boolean;
    staged?: boolean;
}

export function gitDiffKey(sessionId: string, relativePath: string, opts: GitDiffOptions = {}): string {
    return `git-diff:${sessionId}:${opts.head ? 'head' : opts.staged ? 'staged' : 'worktree'}:${relativePath}`;
}

/**
 * The diff of one repo-relative path. `version` is the caller's revision of
 * the working tree (the status signature): a new version refetches while the
 * previous diff stays on screen; a failed fetch never records a version, so
 * it is retried on the next ensure (#199, #200).
 */
export function gitDiffSpec(sessionId: string, relativePath: string, opts: GitDiffOptions = {}, version?: string): ResourceSpec<string> {
    return {
        key: gitDiffKey(sessionId, relativePath, opts),
        family: DIFF_FAMILY,
        version,
        staleTime: version !== undefined ? Infinity : 0,
        retry: { attempts: 1, delayMs: 500 },
        fetch: async () => {
            const res = await sessionGitDiff(sessionId, { path: relativePath, head: opts.head, staged: opts.staged });
            if (!res.success) return failed(res, 'Failed to fetch diff');
            return { kind: 'ok', data: res.diff };
        },
    };
}

/** Forget every file and diff cached for a session (the session was deleted;
 *  called from sync.forgetSession). A reader still mounted for one of them
 *  sees an idle entry and keeps its subscription (sync/resource.ts `remove`). */
export function forgetSessionFiles(sessionId: string): void {
    resources.remove(`file:${sessionId}:`, { prefix: true });
    resources.remove(`git-diff:${sessionId}:`, { prefix: true });
}
