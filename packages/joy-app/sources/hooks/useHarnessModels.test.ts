import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as React from 'react';
import { act, create } from 'react-test-renderer';

// The chat's model chip (SessionView), the hand-off sheet (JoySessionInfo)
// and the new-session picker all read a harness catalog through ONE shared
// resource entry per machine + harness. These tests render the real hook
// against the real store with a controllable daemon answer: one fetch serves
// every consumer of a key, and a consumer that is gone (or moved to another
// machine) never receives a late answer — it lands in its own cache only.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Answer = { status: number; data: unknown };
const pending: Array<{ machineId: string; harness: string; resolve: (a: Answer) => void }> = [];
let ctxFor: (machineId: string) => unknown = (machineId) => ({ machineId });
vi.mock('@/sync/sync', () => ({ sync: { machineOnlyCtx: (id: string) => ctxFor(id) } }));
vi.mock('@/sync/v2/machine', () => ({
    machineHarnessModels: vi.fn((ctx: { machineId: string }, harness: string) => new Promise<Answer>((resolve) => { pending.push({ machineId: ctx.machineId, harness, resolve }); })),
    machineStatusOnly: vi.fn(), machineEnvList: vi.fn(), machineListSessions: vi.fn(), machineHistoryLogs: vi.fn(), machineOpencodeSessions: vi.fn(),
}));
// Component binding boundaries: the hook's focus/foreground policies run
// against a screen that is always focused and an app that is always active.
vi.mock('react-native', () => ({ AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) } }));
vi.mock('expo-router', () => ({ useFocusEffect: (cb: () => void | (() => void)) => React.useEffect(cb, [cb]) }));
vi.mock('@/sync/storage', () => ({ storage: { getState: () => ({ socketStatus: 'connected' }), subscribe: () => () => {} } }));

import { machineHarnessModels } from '@/sync/v2/machine';
import { resources } from '@/sync/resource';
import { harnessModelsSpec, type HarnessModel } from '@/sync/machineResources';
import { loadHarnessModels, useHarnessModels } from './useHarnessModels';

const catalog = (...ids: string[]): Answer => ({ status: 200, data: { ok: true, models: ids.map((id) => ({ id, displayName: id.toUpperCase() })) } });
const asked = async (n: number) => { while (pending.length < n) await new Promise((r) => setTimeout(r, 0)); };
const cached = (machineId: string, harness = 'opencode') => resources.peek<HarnessModel[]>(harnessModelsSpec(machineId, harness).key).data;

let n = 0;
const machine = () => `hm${++n}`;

type View = ReturnType<typeof useHarnessModels>;
async function mount(machineId: string | null, harness = 'opencode') {
    const seen: View[] = [];
    let renders = 0;
    function Host({ machineId, harness }: { machineId: string | null; harness: string }) {
        renders++;
        seen.push(useHarnessModels(machineId, harness));
        return null;
    }
    let root!: ReturnType<typeof create>;
    await act(async () => { root = create(React.createElement(Host, { machineId, harness })); });
    return {
        view: () => seen[seen.length - 1],
        renders: () => renders,
        update: (next: string | null) => act(async () => { root.update(React.createElement(Host, { machineId: next, harness })); }),
        unmount: () => act(async () => { root.unmount(); }),
    };
}

beforeEach(() => { pending.length = 0; ctxFor = (machineId) => ({ machineId }); vi.mocked(machineHarnessModels).mockClear(); });
afterEach(() => { for (const p of pending.splice(0)) p.resolve({ status: 500, data: null }); });

describe('useHarnessModels — one shared entry per machine + harness', () => {
    it('two consumers of the same key share one fetch, and the imperative reader answers from it', async () => {
        const m = machine();
        const chip = await mount(m);
        const picker = await mount(m);
        await asked(1);
        expect(machineHarnessModels).toHaveBeenCalledTimes(1);
        expect(chip.view().isLoading).toBe(true);
        expect(picker.view().isLoading).toBe(true);

        await act(async () => { pending[0].resolve(catalog('sonnet', 'opus')); });
        expect(chip.view().data?.map((x) => x.id)).toEqual(['sonnet', 'opus']);
        expect(picker.view().data).toBe(chip.view().data);

        // The hand-off sheet reads the same key: fresh (5 min staleTime) → no request.
        const models = await loadHarnessModels(m, 'opencode');
        expect(models).toBe(chip.view().data);
        expect(machineHarnessModels).toHaveBeenCalledTimes(1);

        await chip.unmount();
        await picker.unmount();
    });

    it('a late answer after unmount does not reach the component; it lands in the cache only', async () => {
        const m = machine();
        const errors: string[] = [];
        const origError = console.error;
        console.error = (...a: unknown[]) => {
            const line = a.map(String).join(' ');
            if (!line.includes('react-test-renderer is deprecated')) errors.push(line);
        };
        try {
            const chip = await mount(m);
            await asked(1);
            const rendersBefore = chip.renders();
            await chip.unmount();
            await act(async () => { pending[0].resolve(catalog('late')); });
            expect(chip.renders()).toBe(rendersBefore);
            expect(chip.view().hasData).toBe(false);
            expect(errors).toEqual([]);
            // The store still owns the result for the next consumer of the key.
            expect(cached(m)?.map((x) => x.id)).toEqual(['late']);
        } finally {
            console.error = origError;
        }
    });

    it('a consumer that moved to another machine never renders the first machine\'s late catalog', async () => {
        const a = machine();
        const b = machine();
        const chip = await mount(a);
        await asked(1);
        await chip.update(b);
        await asked(2);
        expect(pending.map((p) => p.machineId)).toEqual([a, b]);

        await act(async () => { pending[0].resolve(catalog('for-a')); });
        expect(chip.view().key).toBe(harnessModelsSpec(b, 'opencode').key);
        expect(chip.view().hasData).toBe(false);
        expect(chip.view().isLoading).toBe(true);
        expect(cached(a)?.map((x) => x.id)).toEqual(['for-a']);

        await act(async () => { pending[1].resolve(catalog('for-b')); });
        expect(chip.view().data?.map((x) => x.id)).toEqual(['for-b']);
        await chip.unmount();
    });

    it('no machine or no harness is the idle entry and makes no request', async () => {
        const none = await mount(null);
        expect(none.view().isLoading).toBe(false);
        expect(none.view().hasData).toBe(false);
        expect(machineHarnessModels).not.toHaveBeenCalled();
        await none.unmount();
    });

    it('loadHarnessModels never throws: a daemon that cannot answer is an empty catalog', async () => {
        const m = machine();
        const p = loadHarnessModels(m, 'codex');
        await asked(1);
        pending[0].resolve({ status: 500, data: { error: 'boom' } });
        await expect(p).resolves.toEqual([]);

        ctxFor = () => null;
        await expect(loadHarnessModels(machine(), 'codex')).resolves.toEqual([]);
    });
});
