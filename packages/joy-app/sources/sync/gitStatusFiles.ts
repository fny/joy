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
import { classifyGitStatusResponse, type GitStatusFiles, type GitStatusFilesResult } from './gitStatusModel';

export { knownLines, filesFromStructured, mergeChangeRows, classifyGitStatusResponse } from './gitStatusModel';
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
 * Legacy two-state view of fetchGitStatusFiles: null for BOTH "not a repo" and
 * "unavailable". Callers that own a cache should use fetchGitStatusFiles.
 */
export async function getGitStatusFiles(sessionId: string): Promise<GitStatusFiles | null> {
    const result = await fetchGitStatusFiles(sessionId);
    return result.kind === 'ok' ? result.files : null;
}
