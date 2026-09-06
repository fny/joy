/**
 * Pure projections of the daemon's STRUCTURED git status (schema v2, see
 * docs/API.md "Structured git status") onto the shapes the app renders. No
 * I/O and no git text: the daemon parsed porcelain/numstat once, this module
 * only reshapes typed facts. Kept free of store imports so it is unit-testable.
 *
 * Two fields carry a file's name and they are not interchangeable:
 *  - `fullPath` is the IDENTITY — the cwd-relative path the daemon accepts on
 *    files/* and git/diff. Open, diff and cache a file by this. (A name that
 *    is not valid UTF-8 has no such path; its row is `unaddressable` and
 *    `fullPath` is only a distinct key — see gitPathIdentity.)
 *  - `displayPath` / `fileName` / `filePath` are DISPLAY text — control
 *    characters pictured, undecodable bytes as U+FFFD. Show these; never send
 *    them anywhere.
 */

import type { GitLineCount, GitPathV2, GitStatusEntryV2, GitStatusRepoV2, GitStatusV2 } from './v2/machine';
import type { GitStatus } from './storageTypes';

export type { GitLineCount };

export type GitFileChange = 'modified' | 'added' | 'deleted' | 'renamed' | 'typechange' | 'untracked' | 'conflicted';

export interface GitFileStatus {
    /** Display: last segment of the display path. */
    fileName: string;
    /** Display: the parent directory of the display path ('' at the root). */
    filePath: string;
    /** IDENTITY: cwd-relative path for file operations. For a name that is
     *  not valid UTF-8 this is NOT a path git or the daemon will accept — it
     *  is a key that stays distinct per file (see gitPathIdentity) and the
     *  row is `unaddressable`. */
    fullPath: string;
    /** Display text of the whole path. */
    displayPath: string;
    /** False when the filename bytes are not valid UTF-8 (then `fullPath` and
     *  `displayPath` are lossy and `rawBase64` holds the exact bytes). */
    utf8: boolean;
    /** Base64 of the exact repo-relative filename bytes; only when !utf8. */
    rawBase64?: string;
    /** No open/diff action exists for this row: the daemon cannot be handed
     *  its name as a UTF-8 string. Show it by `displayPath`, never fetch it. */
    unaddressable: boolean;
    status: GitFileChange;
    isStaged: boolean;
    /** Exact counts for this side, or 'unavailable' (binary, untracked, or
     *  the daemon could not read them) — never a stand-in zero. */
    lines: GitLineCount;
    binary: boolean;
    /** Rename/copy source (identity). */
    oldPath?: string;
    /** Rename/copy source (display). */
    oldDisplayPath?: string;
    /** Unmerged XY pair (AA, DD, UU, ...) for a conflicted entry. */
    conflict?: string;
}

export interface GitStatusFiles {
    stagedFiles: GitFileStatus[];
    unstagedFiles: GitFileStatus[];
    /** Branch name (or the unborn branch's name); null when detached. */
    branch: string | null;
    head: 'branch' | 'detached' | 'unborn';
    totalStaged: number;
    totalUnstaged: number;
}

/** `lines` as numbers for a badge, or null when unknown (render nothing). */
export function knownLines(lines: GitLineCount): { added: number; removed: number } | null {
    return lines === 'unavailable' ? null : lines;
}

/** Porcelain column letter → the UI's change kind. */
function changeFromCode(code: string): GitFileChange {
    switch (code) {
        case 'A': return 'added';
        case 'D': return 'deleted';
        case 'R': case 'C': return 'renamed';
        case 'T': return 'typechange';
        case 'U': return 'conflicted';
        default: return 'modified';
    }
}

function splitDisplay(display: string): { fileName: string; filePath: string } {
    const cut = display.lastIndexOf('/');
    return cut < 0
        ? { fileName: display, filePath: '' }
        : { fileName: display.slice(cut + 1) || display, filePath: display.slice(0, cut) };
}

/**
 * The identity string every keyed consumer (tree, merge, diff list, prefetch)
 * uses for a path. A valid-UTF-8 name IS its cwd path. A name that is not
 * valid UTF-8 decodes lossily — two different byte strings can both become
 * "\uFFFD\uFFFD.bin" — so keying by the lossy text merged two real files into
 * one nonexistent row (review residual on fd07ad20, #3). Such a name is keyed
 * by its exact bytes instead: NUL cannot occur in a filename, so the suffix
 * can never collide with a real path, and the row is marked unaddressable.
 */
export function gitPathIdentity(p: GitPathV2): string {
    return p.utf8 ? p.cwd : `${p.cwd}\u0000raw:${p.rawBase64 ?? ''}`;
}

function fileFromEntry(e: GitStatusEntryV2, side: 'staged' | 'unstaged'): GitFileStatus {
    const status: GitFileChange = e.untracked ? 'untracked'
        : e.conflict ? 'conflicted'
            : changeFromCode(side === 'staged' ? e.index : e.worktree);
    const f: GitFileStatus = {
        ...splitDisplay(e.path.display),
        fullPath: gitPathIdentity(e.path),
        displayPath: e.path.display,
        utf8: e.path.utf8,
        unaddressable: !e.path.utf8,
        status,
        isStaged: side === 'staged',
        lines: e.lines[side],
        binary: e.binary === true,
    };
    if (!e.path.utf8 && e.path.rawBase64 !== undefined) f.rawBase64 = e.path.rawBase64;
    if (e.rename) {
        f.oldPath = gitPathIdentity(e.rename.from);
        f.oldDisplayPath = e.rename.from.display;
    }
    if (e.conflict) f.conflict = e.conflict.xy;
    return f;
}

/** The daemon's structured status → the two-list view the screens render. */
export function filesFromStructured(d: GitStatusRepoV2): GitStatusFiles {
    const stagedFiles: GitFileStatus[] = [];
    const unstagedFiles: GitFileStatus[] = [];
    for (const e of d.entries) {
        if (e.untracked) { unstagedFiles.push(fileFromEntry(e, 'unstaged')); continue; }
        if (e.conflict) { unstagedFiles.push(fileFromEntry(e, 'unstaged')); continue; } // a conflict is resolved in the worktree
        if (e.index !== '.') stagedFiles.push(fileFromEntry(e, 'staged'));
        if (e.worktree !== '.') unstagedFiles.push(fileFromEntry(e, 'unstaged'));
    }
    return {
        stagedFiles,
        unstagedFiles,
        branch: d.head.kind === 'detached' ? null : d.head.name,
        head: d.head.kind,
        totalStaged: stagedFiles.length,
        totalUnstaged: unstagedFiles.length,
    };
}

/** Both sides known → their sum; otherwise the total is unknown too. */
export function sumLines(a: GitLineCount, b: GitLineCount): GitLineCount {
    if (a === 'unavailable' || b === 'unavailable') return 'unavailable';
    return { added: a.added + b.added, removed: a.removed + b.removed };
}

/** The daemon's structured status → the store's per-project summary. */
export function gitStatusFromStructured(d: GitStatusRepoV2, now: number = Date.now()): GitStatus {
    return {
        branch: d.head.kind === 'detached' ? null : d.head.name,
        head: d.head.kind,
        isDirty: !d.clean,
        modifiedCount: d.totals.counts.unstaged,
        untrackedCount: d.totals.counts.untracked,
        stagedCount: d.totals.counts.staged,
        conflictedCount: d.totals.counts.conflicted,
        stagedLines: d.totals.staged,
        unstagedLines: d.totals.unstaged,
        totalLines: sumLines(d.totals.staged, d.totals.unstaged),
        lastUpdatedAt: now,
        upstreamBranch: d.upstream?.name ?? null,
        aheadCount: d.upstream?.ahead ?? null,
        behindCount: d.upstream?.behind ?? null,
        stashCount: d.stashCount,
    };
}

/**
 * One row per path for the Changes tree. A path can carry a staged AND an
 * unstaged record (a staged deletion plus an untracked re-creation, a staged
 * edit plus further unstaged edits, a staged edit plus a worktree deletion).
 * Keep the record that describes the WORKING TREE, whatever it says: a
 * recreated file must open, not sit struck-through behind its staged
 * deletion, and a file deleted from the worktree must show as deleted — not
 * as the openable modified file its staged record still describes (#216;
 * review residual on fd07ad20, #4). Availability follows the worktree.
 */
export function mergeChangeRows(staged: GitFileStatus[], unstaged: GitFileStatus[]): GitFileStatus[] {
    const byPath = new Map<string, GitFileStatus>();
    for (const file of [...staged, ...unstaged]) {
        const prev = byPath.get(file.fullPath);
        if (!prev) { byPath.set(file.fullPath, file); continue; }
        // The unstaged record is the worktree's own view and always wins over
        // the staged one, deletion included. Between two records of the same
        // side (should not happen), a non-deleted one beats a deleted one.
        if ((!file.isStaged && prev.isStaged) || (prev.status === 'deleted' && file.status !== 'deleted')) {
            byPath.set(file.fullPath, file);
        }
    }
    return Array.from(byPath.values());
}

/**
 * Outcome of a git-status read. The three states are DISTINCT so callers can
 * keep the last good list on a failed read instead of showing "not a git
 * repository" (the old `null` meant both):
 *  - ok:          a fresh, complete file list;
 *  - not-repo:    the daemon answered and there is nothing to list;
 *  - unavailable: no answer / a failed request — the last list still stands.
 */
export type GitStatusFilesResult =
    | { kind: 'ok'; files: GitStatusFiles }
    | { kind: 'not-repo' }
    | { kind: 'unavailable'; error: string };

/**
 * Classify the daemon's answer. Only an explicit `relation:'none'` is
 * "not a repository"; a git command that FAILED (`ok:false` — bad ownership,
 * an unreadable pack, a timeout) is unavailable, so a transient failure never
 * erases the cached file list (#316 review follow-up).
 */
export function classifyGitStatusResponse(res: { status: number; data: GitStatusV2 | null }): GitStatusFilesResult {
    const { status, data } = res;
    if (status !== 200 || !data) return { kind: 'unavailable', error: `status HTTP ${status}` };
    if (!data.ok) return { kind: 'unavailable', error: `${data.code}: ${data.error}` };
    if (data.relation === 'none') return { kind: 'not-repo' };
    return { kind: 'ok', files: filesFromStructured(data) };
}

/**
 * Latest-wins + owner-scoped refresh bookkeeping, keyed by project. A refresh
 * publishes only while its generation is current: a newer refresh for the same
 * project supersedes it (#316), and `retire` (on blur/unmount) makes the
 * refresh the disposed owner started write nothing if it completes late.
 *
 * `retire` takes the generation the owner minted and only retires THAT one.
 * An unconditional retire invalidated the whole project: with screen A and
 * screen B refreshing the same project, disposing A retired B's in-flight
 * refresh too — B then published nothing and sat on isFetching forever
 * (review residual on fd07ad20, #5).
 */
export function createRefreshScope() {
    const latest = new Map<string, number>();
    let counter = 0;
    return {
        /** Start a refresh; returns its generation. */
        begin(key: string): number {
            const gen = ++counter;
            latest.set(key, gen);
            return gen;
        },
        /** May this refresh still publish? */
        isCurrent(key: string, gen: number): boolean {
            return latest.get(key) === gen;
        },
        /** Owner disposal: the owner's own refresh may no longer publish. A
         *  newer refresh (another owner's, or a later one) is untouched. */
        retire(key: string, gen: number): void {
            if (latest.get(key) === gen) latest.set(key, ++counter);
        },
    };
}
