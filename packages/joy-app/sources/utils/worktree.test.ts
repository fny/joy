import { describe, expect, it } from 'vitest';
import { getRepoPath, getWorktreeName, isWorktreePath } from './worktree';

describe('worktree paths', () => {
    it('detects worktree paths and recovers the main checkout', () => {
        expect(isWorktreePath('/repo/.dev/worktree/feature')).toBe(true);
        expect(isWorktreePath('/repo/src')).toBe(false);
        expect(getRepoPath('/repo/.dev/worktree/feature/packages/app')).toBe('/repo');
        expect(getRepoPath('/repo/src')).toBe('/repo/src');
    });

    // #464: the name is the first component after the marker — a subdirectory
    // inside the worktree and a trailing separator are the same worktree.
    it('names the worktree by its first path component only (#464)', () => {
        expect(getWorktreeName('/repo/.dev/worktree/feature')).toBe('feature');
        expect(getWorktreeName('/repo/.dev/worktree/feature/packages/app')).toBe('feature');
        expect(getWorktreeName('/repo/.dev/worktree/feature/')).toBe('feature');
        expect(getWorktreeName('/repo/.dev/worktree/feature//')).toBe('feature');
    });

    it('returns null when the marker has no name after it or the path is not a worktree', () => {
        expect(getWorktreeName('/repo/.dev/worktree/')).toBeNull();
        expect(getWorktreeName('/repo/src')).toBeNull();
    });
});
