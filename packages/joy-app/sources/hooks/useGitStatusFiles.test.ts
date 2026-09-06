import { describe, it, expect, vi } from 'vitest';

vi.mock('@/sync/gitStatusResource', () => ({ useGitStatusResource: () => ({}) }));

import { gitStatusScreenState } from './useGitStatusFiles';
import type { GitStatusFiles } from '@/sync/gitStatusModel';

// The Changes screen's projection of the git status resource keeps the
// resource's four states apart: a failed read with nothing cached is an
// error (never "not a repository"), only the daemon's explicit answer is
// "not a repository", and a last good list survives a failed check with a
// stale marker.

const files = { branch: 'main', stagedFiles: [], unstagedFiles: [], totalStaged: 0, totalUnstaged: 0 } as unknown as GitStatusFiles;

describe('gitStatusScreenState', () => {
    it('no answer yet is loading', () => {
        expect(gitStatusScreenState({ hasData: false, files: null, error: null, unavailable: null })).toEqual({ kind: 'loading' });
    });

    it('a failed or unavailable read with nothing cached is a failure with its reason, not "not a repository"', () => {
        expect(gitStatusScreenState({ hasData: false, files: null, error: 'git_failed: bad ownership', unavailable: null })).toEqual({ kind: 'failed', reason: 'git_failed: bad ownership' });
        expect(gitStatusScreenState({ hasData: false, files: null, error: null, unavailable: 'no machine context yet' })).toEqual({ kind: 'failed', reason: 'no machine context yet' });
    });

    it('the daemon\'s explicit "not a repository" (data null) is its own state', () => {
        expect(gitStatusScreenState({ hasData: true, files: null, error: null, unavailable: null })).toEqual({ kind: 'not-repo' });
    });

    it('a last good list stays on screen through a failed check, marked stale', () => {
        expect(gitStatusScreenState({ hasData: true, files, error: null, unavailable: null })).toEqual({ kind: 'ready', files, stale: null });
        expect(gitStatusScreenState({ hasData: true, files, error: 'git status HTTP 500', unavailable: null })).toEqual({ kind: 'ready', files, stale: 'git status HTTP 500' });
        expect(gitStatusScreenState({ hasData: true, files, error: null, unavailable: 'no session for this project' })).toEqual({ kind: 'ready', files, stale: 'no session for this project' });
    });
});
