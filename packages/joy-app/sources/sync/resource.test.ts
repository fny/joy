import { describe, it, expect } from 'vitest';
import { ResourceStore, withTimeout, type ResourceOutcome, type ResourceSpec } from './resource';

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

const ok = <T>(data: T): ResourceOutcome<T> => ({ kind: 'ok', data });
const unavailable = (reason: string): ResourceOutcome<never> => ({ kind: 'unavailable', reason });
const failed = (reason: string): ResourceOutcome<never> => ({ kind: 'error', reason });

/** A spec whose every fetch is a controllable slot (answered in any order). */
function slotted<T>(key: string, extra: Partial<ResourceSpec<T>> = {}) {
    const slots: Array<{ resolve: (o: ResourceOutcome<T>) => void; reject: (e: unknown) => void; signal: AbortSignal }> = [];
    const spec: ResourceSpec<T> = {
        key,
        fetch: ({ signal }) => new Promise<ResourceOutcome<T>>((resolve, reject) => { slots.push({ resolve, reject, signal }); }),
        ...extra,
    };
    return { spec, slots };
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe('resource store — keyed identity', () => {
    it('a request writes only its own key; other keys are untouched', async () => {
        const store = new ResourceStore();
        const a = slotted<string>('file:s1:/a.txt');
        const b = slotted<string>('file:s1:/b.txt');
        const pa = store.ensure(a.spec);
        const pb = store.ensure(b.spec);
        b.slots[0].resolve(ok('B'));
        await pb;
        expect(store.peek<string>('file:s1:/b.txt').data).toBe('B');
        expect(store.peek<string>('file:s1:/a.txt').hasData).toBe(false);
        a.slots[0].resolve(ok('A'));
        await pa;
        expect(store.peek<string>('file:s1:/a.txt').data).toBe('A');
        expect(store.peek<string>('file:s1:/b.txt').data).toBe('B');
    });

    it('the same path on another machine/session is another resource', async () => {
        const store = new ResourceStore();
        const s1 = slotted<string>('file:s1:/x');
        const s2 = slotted<string>('file:s2:/x');
        const p1 = store.ensure(s1.spec);
        const p2 = store.ensure(s2.spec);
        s1.slots[0].resolve(ok('one'));
        s2.slots[0].resolve(ok('two'));
        await Promise.all([p1, p2]);
        expect(store.peek<string>('file:s1:/x').data).toBe('one');
        expect(store.peek<string>('file:s2:/x').data).toBe('two');
    });
});

describe('resource store — latest wins across refetch, cancel and mutation', () => {
    it('an older request resolving after a newer one is dropped (#316, #219)', async () => {
        const store = new ResourceStore();
        const r = slotted<string[]>('git-status:m:/repo');
        const slow = store.refresh(r.spec);
        const fast = store.refresh(r.spec);
        expect(r.slots.length).toBe(2);
        expect(r.slots[0].signal.aborted).toBe(true); // the courtesy signal is raised
        r.slots[1].resolve(ok(['fresh']));
        await fast;
        expect(store.peek<string[]>('git-status:m:/repo').data).toEqual(['fresh']);
        r.slots[0].resolve(ok(['stale'])); // the fetcher ignored the signal
        await slow;
        expect(store.peek<string[]>('git-status:m:/repo').data).toEqual(['fresh']);
    });

    it('an error from an older request does not replace a newer success', async () => {
        const store = new ResourceStore();
        const r = slotted<string>('k');
        const slow = store.refresh(r.spec);
        const fast = store.refresh(r.spec);
        r.slots[1].resolve(ok('good'));
        await fast;
        r.slots[0].reject(new Error('HTTP 500'));
        await slow;
        const e = store.peek<string>('k');
        expect(e.data).toBe('good');
        expect(e.error).toBeNull();
        expect(e.fetching).toBe(false);
    });

    it('cancel: the in-flight completion publishes nothing and fetching clears', async () => {
        const store = new ResourceStore();
        const r = slotted<string>('k');
        const p = store.refresh(r.spec);
        expect(store.peek('k').fetching).toBe(true);
        store.cancel('k');
        expect(store.peek('k').fetching).toBe(false);
        expect(r.slots[0].signal.aborted).toBe(true);
        r.slots[0].resolve(ok('late'));
        await p;
        expect(store.peek('k').hasData).toBe(false);
    });

    it('setData (a save) supersedes every read that began before it (#325, #218, #220)', async () => {
        const store = new ResourceStore();
        const r = slotted<string>('file:s1:/a');
        const prefetch = store.ensure(r.spec);           // began before the save
        store.setData('file:s1:/a', 'saved');            // the write landed
        r.slots[0].resolve(ok('pre-save contents'));     // the prefetch's read lands late
        await prefetch;
        expect(store.peek<string>('file:s1:/a').data).toBe('saved');
        // A read that starts AFTER the save is a new generation and does land.
        const after = store.refresh(r.spec);
        r.slots[1].resolve(ok('on disk now'));
        await after;
        expect(store.peek<string>('file:s1:/a').data).toBe('on disk now');
    });

    it('remove drops the value and orphans what is in flight', async () => {
        const store = new ResourceStore();
        const r = slotted<string>('k');
        const p = store.refresh(r.spec);
        store.remove('k');
        r.slots[0].resolve(ok('late'));
        await p;
        expect(store.peek('k').hasData).toBe(false);
        expect(store.keys()).not.toContain('k');
    });

    it('remove by prefix clears a whole session', async () => {
        const store = new ResourceStore();
        store.setData('file:s1:/a', 'a');
        store.setData('file:s1:/b', 'b');
        store.setData('file:s2:/a', 'c');
        store.remove('file:s1:', { prefix: true });
        expect(store.keys().sort()).toEqual(['file:s2:/a']);
    });
});

describe('resource store — error, authoritative empty, unavailable and last-good are distinct', () => {
    it('a failed refetch keeps the last good value and reports the error', async () => {
        const store = new ResourceStore();
        const r = slotted<string[]>('k');
        const first = store.refresh(r.spec);
        r.slots[0].resolve(ok(['a']));
        await first;
        const second = store.refresh(r.spec);
        r.slots[1].reject(new Error('boom'));
        await second;
        const e = store.peek<string[]>('k');
        expect(e.data).toEqual(['a']);
        expect(e.error).toBe('boom');
        expect(e.unavailable).toBeNull();
    });

    it('an error OUTCOME (the resource refused) is an error too, not retried', async () => {
        const store = new ResourceStore();
        let calls = 0;
        const spec: ResourceSpec<string> = { key: 'k', retry: { attempts: 3, delayMs: 0 }, fetch: async () => { calls++; return failed('git_failed: bad ownership'); } };
        await store.refresh(spec);
        expect(calls).toBe(1);
        expect(store.peek('k').error).toBe('git_failed: bad ownership');
    });

    it('an authoritative empty result (null / []) REPLACES the last good value', async () => {
        const store = new ResourceStore();
        const r = slotted<string[] | null>('k');
        const first = store.refresh(r.spec);
        r.slots[0].resolve(ok(['a']));
        await first;
        const second = store.refresh(r.spec);
        r.slots[1].resolve(ok(null));
        await second;
        const e = store.peek<string[] | null>('k');
        expect(e.hasData).toBe(true);
        expect(e.data).toBeNull();
        expect(e.error).toBeNull();
    });

    it('unavailable keeps the last good value, sets no error, and clears on the next ok', async () => {
        const store = new ResourceStore();
        const r = slotted<string>('k');
        const first = store.refresh(r.spec);
        r.slots[0].resolve(ok('good'));
        await first;
        const second = store.refresh(r.spec);
        r.slots[1].resolve(unavailable('no machine context'));
        await second;
        let e = store.peek<string>('k');
        expect(e.data).toBe('good');
        expect(e.unavailable).toBe('no machine context');
        expect(e.error).toBeNull();
        const third = store.refresh(r.spec);
        r.slots[2].resolve(ok('better'));
        await third;
        e = store.peek<string>('k');
        expect(e.data).toBe('better');
        expect(e.unavailable).toBeNull();
    });

    it('a value never fetched is neither empty nor an error', () => {
        const store = new ResourceStore();
        const e = store.peek('never');
        expect(e).toMatchObject({ hasData: false, data: undefined, error: null, unavailable: null, fetching: false });
    });

    it('an equal refetch keeps the previous reference and dataUpdatedAt', async () => {
        let now = 1000;
        const store = new ResourceStore({ now: () => now });
        const r = slotted<{ files: string[] }>('k');
        const first = store.refresh(r.spec);
        r.slots[0].resolve(ok({ files: ['a'] }));
        await first;
        const ref = store.peek<{ files: string[] }>('k').data;
        now = 2000;
        const second = store.refresh(r.spec);
        r.slots[1].resolve(ok({ files: ['a'] }));
        await second;
        const e = store.peek<{ files: string[] }>('k');
        expect(e.data).toBe(ref);
        expect(e.dataUpdatedAt).toBe(1000);
        expect(e.checkedAt).toBe(2000);
    });
});

describe('resource store — ensure, staleness, version and coalescing', () => {
    it('ensure coalesces with the request in flight', async () => {
        const store = new ResourceStore();
        const r = slotted<string>('k');
        const p1 = store.ensure(r.spec);
        const p2 = store.ensure(r.spec);
        expect(r.slots.length).toBe(1);
        r.slots[0].resolve(ok('v'));
        expect((await p1).data).toBe('v');
        expect((await p2).data).toBe('v');
    });

    it('ensure with a fresh value does not fetch; a stale one does', async () => {
        let now = 0;
        const store = new ResourceStore({ now: () => now });
        const r = slotted<string>('k', { staleTime: 1000 });
        const p = store.ensure(r.spec);
        r.slots[0].resolve(ok('v'));
        await p;
        now = 500;
        await store.ensure(r.spec);
        expect(r.slots.length).toBe(1);
        now = 1500;
        const p2 = store.ensure(r.spec);
        expect(r.slots.length).toBe(2);
        r.slots[1].resolve(ok('v2'));
        await p2;
        expect(store.peek<string>('k').data).toBe('v2');
    });

    it('staleTime Infinity (a prefetch) fetches only when nothing is cached', async () => {
        const store = new ResourceStore();
        const r = slotted<string>('k');
        const p = store.ensure(r.spec, { staleTime: Infinity });
        r.slots[0].resolve(ok('v'));
        await p;
        await store.ensure(r.spec, { staleTime: Infinity });
        expect(r.slots.length).toBe(1);
    });

    it('a new version makes the entry stale while the last good value stays; a failed fetch does not record the version (#199, #200)', async () => {
        const store = new ResourceStore();
        const v1 = slotted<string>('diff:s:/a', { version: 'r1', staleTime: Infinity });
        const p1 = store.ensure(v1.spec);
        v1.slots[0].resolve(ok('diff@r1'));
        await p1;
        const v2 = slotted<string>('diff:s:/a', { version: 'r2', staleTime: Infinity });
        expect(store.isStale(v2.spec)).toBe(true);
        const p2 = store.ensure(v2.spec);
        expect(store.peek<string>('diff:s:/a').data).toBe('diff@r1'); // shown meanwhile
        v2.slots[0].reject(new Error('read failed'));
        await p2;
        expect(store.peek<string>('diff:s:/a').dataVersion).toBe('r1');
        expect(store.isStale(v2.spec)).toBe(true); // retried on the next ensure
        const p3 = store.ensure(v2.spec);
        v2.slots[1].resolve(ok('diff@r2'));
        await p3;
        expect(store.peek<string>('diff:s:/a')).toMatchObject({ data: 'diff@r2', dataVersion: 'r2', error: null });
        expect(store.isStale(v2.spec)).toBe(false);
    });

    it('invalidate marks stale; an observed key refetches at once, an unobserved one on its next ensure', async () => {
        const store = new ResourceStore();
        const r = slotted<string>('k', { staleTime: Infinity });
        const p = store.ensure(r.spec);
        r.slots[0].resolve(ok('v'));
        await p;
        store.invalidate('k');
        expect(r.slots.length).toBe(1);
        expect(store.peek('k').invalidated).toBe(true);
        const unsub = store.subscribe('k', () => {});
        store.invalidate('k');
        expect(r.slots.length).toBe(2);
        r.slots[1].resolve(ok('v2'));
        await tick();
        expect(store.peek<string>('k')).toMatchObject({ data: 'v2', invalidated: false });
        unsub();
    });

    it('invalidate by prefix with refetch:true reaches unobserved keys too', async () => {
        const store = new ResourceStore();
        const a = slotted<string>('git:m:/a', { staleTime: Infinity });
        const b = slotted<string>('git:m:/b', { staleTime: Infinity });
        const pa = store.ensure(a.spec); a.slots[0].resolve(ok('a')); await pa;
        const pb = store.ensure(b.spec); b.slots[0].resolve(ok('b')); await pb;
        store.invalidate('git:m:', { prefix: true, refetch: true });
        expect(a.slots.length).toBe(2);
        expect(b.slots.length).toBe(2);
    });
});

describe('resource store — focus and reconnect are per-resource policies', () => {
    it('focus refetches observed entries that opted in, and nothing else', async () => {
        const store = new ResourceStore();
        const yes = slotted<string>('yes', { refetchOnFocus: true });
        const no = slotted<string>('no');
        const idle = slotted<string>('idle', { refetchOnFocus: true }); // not observed
        const p1 = store.ensure(yes.spec); yes.slots[0].resolve(ok('y')); await p1;
        const p2 = store.ensure(no.spec); no.slots[0].resolve(ok('n')); await p2;
        const p3 = store.ensure(idle.spec); idle.slots[0].resolve(ok('i')); await p3;
        const u1 = store.subscribe('yes', () => {});
        const u2 = store.subscribe('no', () => {});
        store.onFocus();
        expect(yes.slots.length).toBe(2);
        expect(no.slots.length).toBe(1);
        expect(idle.slots.length).toBe(1);
        u1(); u2();
    });

    it('reconnect refetches observed entries that opted in', async () => {
        const store = new ResourceStore();
        const r = slotted<string>('k', { refetchOnReconnect: true });
        const p = store.ensure(r.spec); r.slots[0].resolve(ok('v')); await p;
        const u = store.subscribe('k', () => {});
        store.onReconnect();
        expect(r.slots.length).toBe(2);
        u();
        store.onReconnect(); // unobserved now: nothing
        expect(r.slots.length).toBe(2);
    });

    it('a focus refetch never doubles a request already in flight', async () => {
        const store = new ResourceStore();
        const r = slotted<string>('k', { refetchOnFocus: true });
        const u = store.subscribe('k', () => {});
        void store.ensure(r.spec);
        store.onFocus();
        expect(r.slots.length).toBe(1);
        u();
    });
});

describe('resource store — abort is consumed, retry is bounded', () => {
    it('a fetcher that honours the signal (withTimeout) settles without publishing an error for a superseded request', async () => {
        const store = new ResourceStore();
        const hang = deferred<string>();
        const spec: ResourceSpec<string> = {
            key: 'k',
            fetch: async ({ signal }) => ok(await withTimeout(hang.promise, 10_000, signal)),
        };
        const first = store.refresh(spec);
        const second = store.refresh({ ...spec, fetch: async () => ok('second') });
        await second;
        await first; // rejected with 'aborted' inside, but superseded → no publish
        expect(store.peek<string>('k')).toMatchObject({ data: 'second', error: null });
    });

    it('withTimeout rejects on time and is cancelled by the signal', async () => {
        const never = new Promise<string>(() => {});
        await expect(withTimeout(never, 5, undefined, 'probe timeout')).rejects.toThrow('probe timeout');
        const c = new AbortController();
        const p = withTimeout(never, 10_000, c.signal);
        c.abort();
        await expect(p).rejects.toThrow('aborted');
    });

    it('thrown errors retry up to the bound, then publish the error', async () => {
        const store = new ResourceStore();
        let calls = 0;
        const spec: ResourceSpec<string> = { key: 'k', retry: { attempts: 2, delayMs: 0 }, fetch: async () => { calls++; throw new Error(`fail ${calls}`); } };
        await store.refresh(spec);
        expect(calls).toBe(3);
        expect(store.peek('k').error).toBe('fail 3');
    });

    it('a retry loop stops as soon as the request is superseded', async () => {
        const store = new ResourceStore();
        let calls = 0;
        const spec: ResourceSpec<string> = { key: 'k', retry: { attempts: 5, delayMs: 1 }, fetch: async () => { calls++; throw new Error('x'); } };
        const p = store.refresh(spec);
        store.setData('k', 'mutated');
        await p;
        expect(calls).toBe(1);
        expect(store.peek<string>('k')).toMatchObject({ data: 'mutated', error: null });
    });
});

describe('resource store — family budgets', () => {
    it('evicts least-recently-touched unobserved members over the budget', async () => {
        let now = 0;
        const store = new ResourceStore({ now: () => now });
        store.defineFamily('file', { maxBytes: 10, size: (d) => (d as string).length });
        const spec = (key: string, value: string): ResourceSpec<string> => ({ key, family: 'file', fetch: async () => ok(value) });
        await store.refresh(spec('a', 'aaaa')); now = 1;
        await store.refresh(spec('b', 'bbbb')); now = 2;
        const u = store.subscribe('a', () => {});
        await store.refresh(spec('c', 'cccc')); // 12 > 10: evict the oldest unobserved (b)
        expect(store.keys().sort()).toEqual(['a', 'c']);
        u();
    });
});
