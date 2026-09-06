import { describe, it, expect, vi } from 'vitest';
import * as React from 'react';
import { act, create } from 'react-test-renderer';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The store's React binding, rendered for real (react-test-renderer): a
// version that changes while its read is active, a disabled subscription,
// and a key removed / recreated under a mounted subscriber.
vi.mock('react-native', () => ({ AppState: { addEventListener: () => ({ remove: () => {} }) } }));
vi.mock('expo-router', () => ({ useFocusEffect: () => {} }));
vi.mock('@/sync/storage', () => ({ storage: { getState: () => ({ socketStatus: 'connected' }), subscribe: () => () => {} } }));
vi.mock('./useActiveInterval', () => ({ useActiveInterval: () => {} }));

import { resources, type ResourceEntry, type ResourceOutcome, type ResourceSpec } from '@/sync/resource';
import { useResource, useResourceEntry, useResources } from './useResource';

const ok = <T,>(data: T): ResourceOutcome<T> => ({ kind: 'ok', data });
const tick = () => new Promise<void>((r) => setTimeout(r, 0));
type Root = ReturnType<typeof create>;

/** console.error during `fn`: React's snapshot / update-depth complaints land here. */
async function withConsoleErrors(fn: () => Promise<void>): Promise<string[]> {
    const messages: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { messages.push(args.map(String).join(' ')); });
    try { await fn(); } finally { spy.mockRestore(); }
    return messages;
}

describe('useResources — a version that changes while the read is active', () => {
    it('ends on the new version with exactly one read for it', async () => {
        let resolveOne!: (o: ResourceOutcome<string>) => void;
        let twoCalls = 0;
        const one: ResourceSpec<string> = { key: 'multi:version', version: 'one', staleTime: Infinity, fetch: () => new Promise((r) => { resolveOne = r; }) };
        const two: ResourceSpec<string> = { key: 'multi:version', version: 'two', staleTime: Infinity, fetch: async () => { twoCalls++; return ok('two'); } };
        let view: ResourceEntry<string>[] = [];
        function Multi({ specs }: { specs: ResourceSpec<string>[] }) { view = useResources(specs); return null; }
        let root!: Root;
        await act(async () => { root = create(React.createElement(Multi, { specs: [one] })); });
        await act(async () => { root.update(React.createElement(Multi, { specs: [two] })); });
        expect(twoCalls).toBe(0); // the active read is not doubled
        await act(async () => { resolveOne(ok('one')); });
        await act(async () => { await tick(); });
        expect(twoCalls).toBe(1);
        expect(view[0]).toMatchObject({ data: 'two', dataVersion: 'two', fetching: false });
        await act(async () => { root.unmount(); });
    });

    it('repairs a version the settlement did not meet (the read was superseded by a write)', async () => {
        let resolveOne!: (o: ResourceOutcome<string>) => void;
        let twoCalls = 0;
        const key = 'multi:repair';
        const one: ResourceSpec<string> = { key, version: 'one', staleTime: Infinity, fetch: () => new Promise((r) => { resolveOne = r; }) };
        const two: ResourceSpec<string> = { key, version: 'two', staleTime: Infinity, fetch: async () => { twoCalls++; return ok('two'); } };
        let view: ResourceEntry<string>[] = [];
        function Multi({ specs }: { specs: ResourceSpec<string>[] }) { view = useResources(specs); return null; }
        let root!: Root;
        await act(async () => { root = create(React.createElement(Multi, { specs: [one] })); });
        await act(async () => { root.update(React.createElement(Multi, { specs: [two] })); });
        // A write lands with no version: it answers the waiting requirement, but not for 'two'.
        await act(async () => { resources.setData(key, 'written'); await tick(); });
        expect(twoCalls).toBe(1); // the hook asked again for the version it still needs
        await act(async () => { await tick(); });
        expect(view[0]).toMatchObject({ data: 'two', dataVersion: 'two' });
        await act(async () => { resolveOne(ok('one')); await tick(); }); // the orphaned read: nothing
        expect(view[0].data).toBe('two');
        await act(async () => { root.unmount(); });
    });
});

describe('useResource — enabled: false is a passive subscription', () => {
    it('keeps the entry alive and never fetches on reconnect; re-enabling ensures again', async () => {
        let n = 0;
        const spec: ResourceSpec<number> = { key: 'hook:disabled', refetchOnReconnect: true, fetch: async () => ok(++n) };
        let view!: ResourceEntry<number>;
        function Hook({ enabled }: { enabled: boolean }) { view = useResource(spec, { enabled }); return null; }
        let root!: Root;
        await act(async () => { root = create(React.createElement(Hook, { enabled: true })); });
        expect(n).toBe(1);
        expect(view.data).toBe(1);
        await act(async () => { root.update(React.createElement(Hook, { enabled: false })); });
        await act(async () => { resources.onReconnect(); await tick(); });
        expect(n).toBe(1);
        expect(resources.isObserved(spec.key)).toBe(true);
        expect(view.data).toBe(1); // still seen
        await act(async () => { root.update(React.createElement(Hook, { enabled: true })); });
        expect(n).toBe(2);
        await act(async () => { root.unmount(); });
        expect(resources.isObserved(spec.key)).toBe(false);
    });
});

describe('removal and recreation under a mounted subscriber', () => {
    it('useResourceEntry: remove renders the idle entry without a snapshot loop; the recreated key is observed by onFocus', async () => {
        let count = 0;
        const spec: ResourceSpec<number> = { key: 'entry:removed', refetchOnFocus: true, fetch: async () => ok(++count) };
        await resources.refresh(spec);
        let view!: ResourceEntry<number>;
        function Passive() { view = useResourceEntry<number>(spec.key); return null; }
        let root!: Root;
        const errors = await withConsoleErrors(async () => {
            await act(async () => { root = create(React.createElement(Passive)); });
            expect(view.data).toBe(1);
            await act(async () => { resources.remove(spec.key); });
            expect(view).toMatchObject({ hasData: false, fetching: false });
            expect(resources.isObserved(spec.key)).toBe(true);
            await act(async () => { await resources.refresh(spec); });
            expect(view.data).toBe(2);
            await act(async () => { resources.onFocus(); await tick(); });
            expect(view.data).toBe(3);
        });
        expect(errors.filter((m) => /getSnapshot|Maximum update depth/.test(m))).toEqual([]);
        await act(async () => { root.unmount(); });
        expect(resources.isObserved(spec.key)).toBe(false);
    });

    it('useResource: remove while mounted keeps the subscription; refresh recreates the key under it', async () => {
        let count = 0;
        const spec: ResourceSpec<number> = { key: 'hook:removed', fetch: async () => ok(++count) };
        let view!: ReturnType<typeof useResource<number>>;
        function Hook() { view = useResource(spec); return null; }
        let root!: Root;
        const errors = await withConsoleErrors(async () => {
            await act(async () => { root = create(React.createElement(Hook)); });
            expect(view.data).toBe(1);
            await act(async () => { resources.remove(spec.key); });
            expect(view).toMatchObject({ hasData: false, isLoading: false });
            await act(async () => { await view.refresh(); });
            expect(view.data).toBe(2);
        });
        expect(errors.filter((m) => /getSnapshot|Maximum update depth/.test(m))).toEqual([]);
        await act(async () => { root.unmount(); });
    });

    it('a key never fetched renders a stable idle snapshot (no "getSnapshot should be cached" warning)', async () => {
        let view!: ResourceEntry<number>;
        function Passive() { view = useResourceEntry<number>('entry:never'); return null; }
        let root!: Root;
        const errors = await withConsoleErrors(async () => {
            await act(async () => { root = create(React.createElement(Passive)); });
            await act(async () => { root.update(React.createElement(Passive)); });
        });
        expect(view.hasData).toBe(false);
        expect(errors.filter((m) => /getSnapshot|Maximum update depth/.test(m))).toEqual([]);
        await act(async () => { root.unmount(); });
    });
});
