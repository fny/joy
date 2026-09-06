import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { GitStatusFiles } from './gitStatusModel';

// Every cache writer must publish through ONE ownership (fd07ad20 residual
// #5): the sidebar used to fetch and write on its own, so its older result
// could land after — and overwrite — a fresher list the Changes hook had
// already published. These tests drive startGitStatusRefresh with a
// controllable daemon answer and a fake store.

const cache: Record<string, GitStatusFiles | null> = {};
const store = {
    sessions: { s1: { metadata: { path: '/repo', machineId: 'm' } } },
    applyGitStatusFiles(pathKey: string, files: GitStatusFiles | null) { cache[pathKey] = files; },
};
vi.mock('./storage', () => ({ storage: { getState: () => store } }));
vi.mock('./sync', () => ({ sync: { awaitMachineCtx: async () => ({ localSessionId: 's1' }) } }));

type Answer = { status: number; data: unknown };
const pending: Array<(a: Answer) => void> = [];
vi.mock('./v2/machine', () => ({
    machineGitStatus: () => new Promise<Answer>((resolve) => { pending.push(resolve); }),
}));

import { startGitStatusRefresh, gitStatusRefreshScope } from './gitStatusFiles';

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
const cachedName = () => cache[KEY]?.unstagedFiles.map((f) => f.fullPath) ?? null;
// fetchGitStatusFiles awaits the machine context before it asks the daemon, so
// the n-th answer slot appears a few microtasks after startGitStatusRefresh.
const asked = async (n: number) => { while (pending.length < n) await new Promise((r) => setTimeout(r, 0)); };

beforeEach(() => { delete cache[KEY]; pending.length = 0; });

describe('startGitStatusRefresh — one publication ownership for every writer', () => {
    it('an older sidebar result resolving after a fresher hook result does not overwrite it', async () => {
        const sidebar = startGitStatusRefresh('s1', KEY); // slow
        const hook = startGitStatusRefresh('s1', KEY);    // fast
        await asked(2);
        pending[1](listWith('fresh.ts'));
        expect(await hook.settled).toBe(true);
        expect(cachedName()).toEqual(['fresh.ts']);
        pending[0](listWith('stale.ts'));
        expect(await sidebar.settled).toBe(false);
        expect(cachedName()).toEqual(['fresh.ts']);
    });

    it('disposing one owner retires only its own refresh; the other owner still publishes', async () => {
        const a = startGitStatusRefresh('s1', KEY);
        const b = startGitStatusRefresh('s1', KEY);
        gitStatusRefreshScope.retire(KEY, a.gen); // owner A unmounted
        await asked(2);
        pending[1](listWith('b.ts'));
        expect(await b.settled).toBe(true);
        expect(cachedName()).toEqual(['b.ts']);
        pending[0](listWith('a.ts'));
        expect(await a.settled).toBe(false);
        expect(cachedName()).toEqual(['b.ts']);
    });

    it('a retired owner\'s late result publishes nothing; not-repo clears; a failed read keeps the last list', async () => {
        const first = startGitStatusRefresh('s1', KEY);
        await asked(1);
        pending[0](listWith('a.ts'));
        expect(await first.settled).toBe(true);
        expect(cachedName()).toEqual(['a.ts']);

        const retired = startGitStatusRefresh('s1', KEY);
        gitStatusRefreshScope.retire(KEY, retired.gen);
        await asked(2);
        pending[1](listWith('late.ts'));
        expect(await retired.settled).toBe(false);
        expect(cachedName()).toEqual(['a.ts']);

        const failed = startGitStatusRefresh('s1', KEY);
        await asked(3);
        pending[2]({ status: 200, data: { v: 2, ok: false, code: 'git_failed', error: 'boom' } });
        expect(await failed.settled).toBe(true);
        expect(cachedName()).toEqual(['a.ts']);

        const none = startGitStatusRefresh('s1', KEY);
        await asked(4);
        pending[3]({ status: 200, data: { v: 2, ok: true, relation: 'none', cwd: '/repo' } });
        expect(await none.settled).toBe(true);
        expect(cache[KEY]).toBeNull();
    });
});
