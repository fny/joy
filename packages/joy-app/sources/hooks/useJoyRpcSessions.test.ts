import { describe, it, expect, vi } from 'vitest';

vi.mock('@/sync/v2/machine', () => ({ machineListSessions: vi.fn(), machineKillSession: vi.fn(), machinePane: vi.fn() }));
vi.mock('@/sync/sync', () => ({ sync: {} }));
vi.mock('@/sync/v2/spawn', () => ({ v2SpawnAndWait: vi.fn() }));
vi.mock('./useActiveInterval', () => ({ useActiveInterval: vi.fn() }));

import { refreshLatest, type LatestResult } from './useJoyRpcSessions';

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

let n = 0;
const key = () => `joy-rpc-sessions-test#${++n}`;

describe('useJoyRpcSessions — request order, not just mounted lifetime, decides which list lands', () => {
    it('a list from an earlier request that resolves after a newer one is dropped', async () => {
        const k = key();
        const first = deferred<string[]>();
        const second = deferred<string[]>();
        const committed: LatestResult<string[]>[] = [];
        const commit = (r: LatestResult<string[]>) => committed.push(r);

        const p1 = refreshLatest(k, () => first.promise, commit);
        const p2 = refreshLatest(k, () => second.promise, commit);

        second.resolve(['new']);
        expect(await p2).toBe(true);
        first.resolve(['old']);
        expect(await p1).toBe(false);

        expect(committed).toEqual([{ ok: true, value: ['new'] }]);
    });

    it('an error from an earlier request does not replace a newer success', async () => {
        const k = key();
        const first = deferred<string[]>();
        const second = deferred<string[]>();
        const committed: LatestResult<string[]>[] = [];
        const commit = (r: LatestResult<string[]>) => committed.push(r);

        const p1 = refreshLatest(k, () => first.promise, commit);
        const p2 = refreshLatest(k, () => second.promise, commit);
        second.resolve(['good']);
        await p2;
        first.reject(new Error('HTTP 500'));
        expect(await p1).toBe(false);

        expect(committed).toEqual([{ ok: true, value: ['good'] }]);
    });

    it('the newest request commits its error (the last good list is the caller\'s to keep)', async () => {
        const k = key();
        const committed: LatestResult<string[]>[] = [];
        expect(await refreshLatest(k, () => Promise.reject(new Error('list sessions failed: HTTP 500')), (r) => committed.push(r))).toBe(true);
        expect(committed).toEqual([{ ok: false, error: 'list sessions failed: HTTP 500' }]);
    });

    it('keys are independent: another instance\'s request does not supersede this one', async () => {
        const a = key();
        const b = key();
        const committed: string[] = [];
        const slow = deferred<string[]>();
        const pa = refreshLatest(a, () => slow.promise, (r) => { if (r.ok) committed.push(`a:${r.value[0]}`); });
        await refreshLatest(b, async () => ['b'], (r) => { if (r.ok) committed.push(`b:${r.value[0]}`); });
        slow.resolve(['a']);
        expect(await pa).toBe(true);
        expect(committed).toEqual(['b:b', 'a:a']);
    });
});
