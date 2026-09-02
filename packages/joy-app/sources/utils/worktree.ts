/**
 * Git worktree path helpers. Worktrees the app knows about live under a fixed
 * prefix inside the repo; these only inspect paths (creation/removal is the
 * agent's job on the machine).
 */

/** Relative path prefix where worktrees are stored inside a repo */
export const WORKTREE_DIR = '.dev/worktree';

/** Absolute path marker used to detect worktree paths */
export const WORKTREE_PATH_MARKER = `/${WORKTREE_DIR}/`;

/** Check if a path is inside a worktree */
export function isWorktreePath(path: string): boolean {
    return path.includes(WORKTREE_PATH_MARKER);
}

/** Extract the main repository checkout path from a possibly-worktree path */
export function getRepoPath(path: string): string {
    const idx = path.indexOf(WORKTREE_PATH_MARKER);
    if (idx === -1) return path;
    return path.slice(0, idx);
}

/** Extract the worktree name from a worktree path, or null if not a worktree */
export function getWorktreeName(path: string): string | null {
    const idx = path.indexOf(WORKTREE_PATH_MARKER);
    if (idx === -1) return null;
    return path.slice(idx + WORKTREE_PATH_MARKER.length);
}
