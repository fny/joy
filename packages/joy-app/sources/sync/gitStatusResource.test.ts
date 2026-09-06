import { describe, it, expect, vi, beforeEach } from 'vitest';

// Every reader of a project's git status shares ONE resource (fd07ad20
// residual #5, #316, #378, #379): a slow older read — the sidebar's, the
// Changes screen's, a stopped synchronizer's — can never overwrite a fresher
// answer, only the daemon's explicit "not a repository" clears the list, and
// a failed or impossible read keeps the last good one. These tests drive the
// real resource with a controllable daemon answer and a fake store.

const store = {
    sessions: {
        s1: { id: 's1', presence: 'online', metadata: { path: '/repo', machineId: 'm' } },
        s2: { id: 's2', presence: 'offline', metadata: { path: '/repo', machineId: 'm' } },
    } as Record<string, { id: string; presence: string; metadata: { path: string; machineId: string } }>,
};
let ctx: unknown = { localSessionId: 's1' };
vi.mock('./storage', () => ({ storage: { getState: () => store }, useSession: () => null }));
vi.mock('./sync', () => ({ sync: { awaitMachineCtx: async () => ctx } }));
vi.mock('@/hooks/useResource', () => ({ useResource: () => { throw new Error('not rendered'); }, useResourceEntry: () => { throw new Error('not rendered'); } }));

type Answer = { status: number; data: unknown };
const pending: Array<(a: Answer) => void> = [];
vi.mock('./v2/machine', () => ({
    machineGitStatus: () => new Promise<Answer>((resolve) => { pending.push(resolve); }),
}));

import { resources } from './resource';
import { clearGitStatusForSession, fetchGitStatusFiles, filesOf, gitStatusKey, gitStatusSpec, summaryOf, type GitStatusData } from './gitStatusResource';

const KEY = 'm:/repo';
const listWith = (name: string) => ({
    status: 200,
    data: {
        v: 2, ok: true, relation: 'root', cwd: '/repo',
        repository: { root: '/repo', gitDir: '/repo/.git', commonDir: '/repo/.git', linkedWorktree: false, prefix: '' },
        head: { kind: 'branch', name: 'main', oid: 'abc' },
        upstream: null, operation: null, stashCount: 0, branches: [],
        entries: [{ path: { repo: name, cwd: name, display: name, utf8: true }, index: '.', worktree: 'M', untracked: false, conflict: null, rename: null, submodule: false, binary: false, lines: { staged: { added: 0, removed: 0 }, unstaged: { added: 1, removed: 0 } } }],
        totals: { staged: { added: 0, removed: 0 }, unstaged: { added: 1, removed: 0 }, counts: { staged: 0, unstaged: 1, untracked: 0, conflicted: 0, entries: 1 } },
        clean: false,
    },
});
const entry = () => resources.peek<GitStatusData>(gitStatusKey(KEY));
const cachedName = () => filesOf(entry().data)?.unstagedFiles.map((f) => f.fullPath) ?? null;
// The fetch awaits the machine context before it asks the daemon, so the
// n-th answer slot appears a few microtasks after refresh().
const asked = async (n: number) => { while (pending.length < n) await new Promise((r) => setTimeout(r, 0)); };

beforeEach(() => { resources.remove(gitStatusKey(KEY)); pending.length = 0; ctx = { localSessionId: 's1' }; });

describe('git status resource — one ownership for every reader', () => {
    it('an older sidebar result resolving after a fresher hook result does not overwrite it', async () => {
        const sidebar = resources.refresh(gitStatusSpec(KEY)); // slow
        const hook = resources.refresh(gitStatusSpec(KEY));    // fast
        await asked(2);
        pending[1](listWith('fresh.ts'));
        await hook;
        expect(cachedName()).toEqual(['fresh.ts']);
        pending[0](listWith('stale.ts'));
        await sidebar;
        expect(cachedName()).toEqual(['fresh.ts']);
    });

    it('a cancelled owner\'s late result publishes nothing; not-repo clears; a failed read keeps the last list', async () => {
        const first = resources.refresh(gitStatusSpec(KEY));
        await asked(1);
        pending[0](listWith('a.ts'));
        await first;
        expect(cachedName()).toEqual(['a.ts']);

        const cancelled = resources.refresh(gitStatusSpec(KEY));
        resources.cancel(gitStatusKey(KEY));
        await asked(2);
        pending[1](listWith('late.ts'));
        await cancelled;
        expect(cachedName()).toEqual(['a.ts']);

        const failed = resources.refresh(gitStatusSpec(KEY));
        await asked(3);
        pending[2]({ status: 200, data: { v: 2, ok: false, code: 'git_failed', error: 'boom' } });
        await failed;
        expect(cachedName()).toEqual(['a.ts']);
        expect(entry().error).toBe('git_failed: boom');

        const none = resources.refresh(gitStatusSpec(KEY));
        await asked(4);
        pending[3]({ status: 200, data: { v: 2, ok: true, relation: 'none', cwd: '/repo' } });
        await none;
        expect(entry().hasData).toBe(true);
        expect(entry().data).toBeNull();
        expect(cachedName()).toBeNull();
        expect(entry().error).toBeNull();
    });

    it('no machine context is unavailable, not an error, and keeps the last list', async () => {
        const first = resources.refresh(gitStatusSpec(KEY));
        await asked(1);
        pending[0](listWith('a.ts'));
        await first;
        ctx = null;
        await resources.refresh(gitStatusSpec(KEY));
        expect(cachedName()).toEqual(['a.ts']);
        expect(entry().unavailable).toBe('no machine context yet');
        expect(entry().error).toBeNull();
    });

    it('an unchanged answer keeps the projected list and summary references', async () => {
        const first = resources.refresh(gitStatusSpec(KEY));
        await asked(1);
        pending[0](listWith('a.ts'));
        await first;
        const files = filesOf(entry().data);
        const summary = summaryOf(entry().data, entry().dataUpdatedAt);
        const second = resources.refresh(gitStatusSpec(KEY));
        await asked(2);
        pending[1](listWith('a.ts'));
        await second;
        expect(filesOf(entry().data)).toBe(files);
        expect(summaryOf(entry().data, entry().dataUpdatedAt)).toBe(summary);
        expect(summary?.lastUpdatedAt).toBeGreaterThan(0);
    });

    it('fetchGitStatusFiles reports the three states; clearing a shared project keeps it, the last session drops it', async () => {
        const p = fetchGitStatusFiles('s1');
        await asked(1);
        pending[0](listWith('a.ts'));
        expect(await p).toMatchObject({ kind: 'ok' });
        clearGitStatusForSession('s2'); // s1 still shares the project
        expect(entry().hasData).toBe(true);
        delete store.sessions.s2;
        clearGitStatusForSession('s1');
        expect(entry().hasData).toBe(false);
        store.sessions.s2 = { id: 's2', presence: 'offline', metadata: { path: '/repo', machineId: 'm' } };
    });
});
