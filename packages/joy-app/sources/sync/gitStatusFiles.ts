/**
 * Git status, file level — the Changes list, the sidebar tree, the all-files
 * diff and the prefetcher all read this shape.
 *
 * Built from the daemon's STRUCTURED status (v=2): the daemon has already
 * parsed porcelain and numstat, so nothing here reads git text. The shapes and
 * the projection live in ./gitStatusModel (pure, unit-tested); this module
 * adds the store lookup and the tunnel call.
 */

import { storage } from './storage';
import { sync } from './sync';
import { machineGitStatus } from './v2/machine';
import { classifyGitStatusResponse, createRefreshScope, type GitStatusFiles, type GitStatusFilesResult } from './gitStatusModel';

export { knownLines, filesFromStructured, mergeChangeRows, classifyGitStatusResponse, gitPathIdentity } from './gitStatusModel';
export type { GitFileStatus, GitFileChange, GitStatusFiles, GitLineCount, GitStatusFilesResult } from './gitStatusModel';

/**
 * Fetch detailed git status with file-level information (three-state).
 */
export async function fetchGitStatusFiles(sessionId: string): Promise<GitStatusFilesResult> {
    try {
        const session = storage.getState().sessions[sessionId];
        if (!session?.metadata?.path) {
            return { kind: 'unavailable', error: 'session has no path yet' };
        }

        // One structured call over the sealed tunnel; the daemon did the parsing.
        const mctx = await sync.awaitMachineCtx(sessionId);
        if (!mctx) {
            return { kind: 'unavailable', error: 'no machine context yet' };
        }

        // Only an explicit "not a repository" clears the list; a failed git
        // command (ok:false) is unavailable and the last good list stands.
        return classifyGitStatusResponse(await machineGitStatus(mctx));
    } catch (error) {
        console.error('Error fetching git status files for session', sessionId, ':', error);
        return { kind: 'unavailable', error: error instanceof Error ? error.message : String(error) };
    }
}

/**
 * The ONE publication ownership for the per-project file-list cache. Every
 * writer (the Changes screen's hook, the session sidebar) refreshes through
 * startGitStatusRefresh, so a slow older request from one of them can never
 * overwrite a fresher result the other already published. The sidebar used
 * to fetch and write on its own, outside this scope (review residual on
 * fd07ad20, #5). Module-level: the screen that started a request may be gone
 * by the time it resolves, and a later instance must still outrank it.
 */
export const gitStatusRefreshScope = createRefreshScope();

export interface GitStatusRefresh {
    /** The generation this refresh minted; hand it to
     *  `gitStatusRefreshScope.retire(pathKey, gen)` when the owner goes away. */
    gen: number;
    /** Resolves once the read settled: true when the result was published
     *  (or, for a failed read, was still current and kept the last list),
     *  false when a newer refresh superseded it or the owner retired it. */
    settled: Promise<boolean>;
}

/**
 * Start a refresh of one project's file list under latest-wins ownership and
 * publish its outcome into the store: a fresh list, an authoritative "not a
 * repository" (clears the list), or — for a failed read — nothing, so the
 * last good list stands. Never throws.
 */
export function startGitStatusRefresh(sessionId: string, pathKey: string): GitStatusRefresh {
    const gen = gitStatusRefreshScope.begin(pathKey);
    const settled = (async () => {
        const result = await fetchGitStatusFiles(sessionId);
        if (!gitStatusRefreshScope.isCurrent(pathKey, gen)) return false; // superseded, or the owner retired it (#316)
        if (result.kind === 'ok') {
            storage.getState().applyGitStatusFiles(pathKey, result.files);
        } else if (result.kind === 'not-repo') {
            storage.getState().applyGitStatusFiles(pathKey, null);
        } else {
            console.warn(`[git] status refresh unavailable for ${pathKey}, keeping last result: ${result.error}`);
        }
        return true;
    })();
    return { gen, settled };
}

/**
 * Legacy two-state view of fetchGitStatusFiles: null for BOTH "not a repo" and
 * "unavailable". Callers that own a cache should use fetchGitStatusFiles.
 */
export async function getGitStatusFiles(sessionId: string): Promise<GitStatusFiles | null> {
    const result = await fetchGitStatusFiles(sessionId);
    return result.kind === 'ok' ? result.files : null;
}
