import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as React from 'react';
import { act, create } from 'react-test-renderer';

// The machine page's Daemon row reads the SAME joy-status entry the sessions
// settings screen observes (sync/machineResources.joyStatusSpec). These tests
// render the real hook against the real store with a controllable probe: one
// probe serves every consumer of a machine, a late answer after unmount
// touches no component, and the four resource states drive the row.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Answer = { status: number; data: unknown };
const pending: Array<{ machineId: string; resolve: (a: Answer) => void; reject: (e: unknown) => void }> = [];
let ctxFor: (machineId: string) => unknown = (machineId) => ({ machineId });
vi.mock('@/sync/sync', () => ({ sync: { machineOnlyCtx: (id: string) => ctxFor(id) } }));
vi.mock('@/sync/v2/machine', () => ({
    machineStatusOnly: vi.fn((ctx: { machineId: string }) => new Promise<Answer>((resolve, reject) => { pending.push({ machineId: ctx.machineId, resolve, reject }); })),
    machineHarnessModels: vi.fn(), machineEnvList: vi.fn(), machineListSessions: vi.fn(), machineHistoryLogs: vi.fn(), machineOpencodeSessions: vi.fn(),
}));
vi.mock('react-native', () => ({ AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) } }));
vi.mock('expo-router', () => ({ useFocusEffect: (cb: () => void | (() => void)) => React.useEffect(cb, [cb]) }));
vi.mock('@/sync/storage', () => ({ storage: { getState: () => ({ socketStatus: 'connected' }), subscribe: () => () => {} } }));

import { machineStatusOnly } from '@/sync/v2/machine';
import { resources } from '@/sync/resource';
import { joyStatusSpec, type JoyStatus } from '@/sync/machineResources';
import { useDaemonStatus } from './useDaemonStatus';

const running = (pid = 42): Answer => ({ status: 200, data: { ok: true, pid, version: '1.2.3' } });
const asked = async (n: number) => { while (pending.length < n) await new Promise((r) => setTimeout(r, 0)); };
const cached = (machineId: string) => resources.peek<JoyStatus>(joyStatusSpec(machineId).key);

let n = 0;
const machine = () => `dm${++n}`;

type View = ReturnType<typeof useDaemonStatus>;
async function mount(machineId: string, online = true) {
    const seen: View[] = [];
    let renders = 0;
    function Host({ machineId, online }: { machineId: string; online: boolean }) {
        renders++;
        seen.push(useDaemonStatus(machineId, online));
        return null;
    }
    let root!: ReturnType<typeof create>;
    await act(async () => { root = create(React.createElement(Host, { machineId, online })); });
    return {
        view: () => seen[seen.length - 1],
        renders: () => renders,
        update: (next: { machineId?: string; online?: boolean }) => act(async () => {
            root.update(React.createElement(Host, { machineId: next.machineId ?? machineId, online: next.online ?? online }));
        }),
        unmount: () => act(async () => { root.unmount(); }),
    };
}

beforeEach(() => { pending.length = 0; ctxFor = (machineId) => ({ machineId }); vi.mocked(machineStatusOnly).mockClear(); });
afterEach(() => { for (const p of pending.splice(0)) p.resolve({ status: 500, data: null }); });

describe('useDaemonStatus — the machine page shares the joy-status entry', () => {
    it('two consumers of the same machine share one probe', async () => {
        const m = machine();
        const page = await mount(m);
        const settings = await mount(m);
        await asked(1);
        expect(machineStatusOnly).toHaveBeenCalledTimes(1);
        expect(page.view().row.loading).toBe(true);
        expect(page.view().failed).toBe(false);

        await act(async () => { pending[0].resolve(running(7)); });
        expect(page.view().row).toMatchObject({ running: true, detail: 'running', loading: false });
        expect(page.view().row.status?.pid).toBe(7);
        expect(settings.view().probe.data).toBe(page.view().probe.data);
        expect(machineStatusOnly).toHaveBeenCalledTimes(1);

        await page.unmount();
        await settings.unmount();
    });

    it('a late probe answer after unmount does not reach the component; it lands in the cache only', async () => {
        const m = machine();
        const errors: string[] = [];
        const origError = console.error;
        console.error = (...a: unknown[]) => {
            const line = a.map(String).join(' ');
            if (!line.includes('react-test-renderer is deprecated')) errors.push(line);
        };
        try {
            const page = await mount(m);
            await asked(1);
            const rendersBefore = page.renders();
            await page.unmount();
            await act(async () => { pending[0].resolve(running(9)); });
            expect(page.renders()).toBe(rendersBefore);
            expect(page.view().row.loading).toBe(true);
            expect(errors).toEqual([]);
            expect(cached(m).data?.pid).toBe(9);
        } finally {
            console.error = origError;
        }
    });

    it('switching machines renders the new machine\'s entry; the old probe lands under its own key', async () => {
        const a = machine();
        const b = machine();
        const page = await mount(a);
        await asked(1);
        await page.update({ machineId: b });
        await asked(2);
        await act(async () => { pending[0].resolve(running(1)); });
        expect(page.view().probe.key).toBe(joyStatusSpec(b).key);
        expect(page.view().row.loading).toBe(true);
        expect(page.view().row.status).toBeNull();
        expect(cached(a).data?.pid).toBe(1);

        await act(async () => { pending[1].resolve(running(2)); });
        expect(page.view().row.status?.pid).toBe(2);
        await page.unmount();
    });

    it('a daemon refusal is unreachable + failed, and the last good status is not shown under it', async () => {
        const m = machine();
        const page = await mount(m);
        await asked(1);
        await act(async () => { pending[0].resolve(running(3)); });
        expect(page.view().row.running).toBe(true);

        await act(async () => { void page.view().probe.refresh(); });
        await asked(2);
        await act(async () => { pending[1].resolve({ status: 500, data: { error: 'boom' } }); });
        expect(page.view().row).toMatchObject({ running: false, detail: 'unreachable', loading: false, status: null });
        expect(page.view().failed).toBe(true);
        await page.unmount();
    });

    it('offline never probes and reads offline; coming online starts the shared probe', async () => {
        const m = machine();
        const page = await mount(m, false);
        expect(machineStatusOnly).not.toHaveBeenCalled();
        expect(page.view().row).toMatchObject({ detail: 'offline', loading: false, status: null });
        expect(page.view().failed).toBe(true);

        await page.update({ online: true });
        await asked(1);
        expect(page.view().row.loading).toBe(true);
        await page.unmount();
    });

    it('no machine context yet is still loading (the key may arrive), not unreachable', async () => {
        ctxFor = () => null;
        const page = await mount(machine());
        expect(page.view().probe.unavailable).toBe('no machine context');
        expect(page.view().row.loading).toBe(true);
        expect(page.view().failed).toBe(false);
        expect(machineStatusOnly).not.toHaveBeenCalled();
        await page.unmount();
    });
});
