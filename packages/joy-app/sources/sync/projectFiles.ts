/**
 * Project file listing via git ls-files.
 * Fetches all tracked + untracked files and stores them in Zustand.
 */

import { storage } from './storage';
import { machineGitEntries } from '@/sync/v2/machine';
import { sync } from '@/sync/sync';

export interface ProjectFile {
    fileName: string;
    filePath: string;
    fullPath: string;
}

export interface ProjectFilesList {
    files: ProjectFile[];
    fetchedAt: number;
}

/**
 * Fetch all project files for a session via bash.
 * Uses git ls-files (tracked + untracked), falls back to find.
 */
export async function getProjectFiles(sessionId: string): Promise<ProjectFilesList | null> {
    const session = storage.getState().sessions[sessionId];
    if (!session?.metadata?.path) {
        return null;
    }

    const cwd = session.metadata.path;

    // git ls-files for repos (tracked + untracked, .gitignore respected);
    // outside a repo, fall back to a pruned find so the All-files tab works on
    // plain directories too (the header comment always promised this fallback
    // — it was never actually implemented, so non-git projects showed nothing).
    // The prune list covers the usual heavyweight dirs; 20k-file cap protects
    // against pathological trees. BSD/GNU-find compatible (boite is a Mac).
    // Tracked + untracked (not ignored) through the daemon's git route (#5).
    // Outside a repo the route fails and the tab is empty — the shell `find`
    // fallback never actually ran either (the bash path never reached the
    // daemon), so this is not a regression; a listDir-based fallback is a
    // separate change.
    const ctx = await sync.awaitMachineCtx(sessionId);
    if (!ctx) return null;
    const { data } = await machineGitEntries(ctx, { untracked: true });
    if (!data?.ok || !data.files) return null;

    // The daemon splits `ls-files -z` on NUL and hands back one exact path per
    // entry. Re-joining on newlines and trimming turned a name with a newline
    // into two nonexistent files and dropped an all-space name (#384) — take
    // the entries as they are.
    const files: ProjectFile[] = data.files
        .filter(p => p.length > 0)
        .map(p => {
            const cut = p.lastIndexOf('/');
            const fileName = cut < 0 ? p : (p.slice(cut + 1) || p);
            const filePath = cut < 0 ? '' : p.slice(0, cut);
            return { fileName, filePath, fullPath: p };
        });

    return { files, fetchedAt: Date.now() };
}
