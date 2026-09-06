import { describe, it, expect, vi, beforeEach } from 'vitest';

// The joy session list is a resource keyed by machine: request ORDER per
// key decides which list lands, not the mounted lifetime, and a failed poll
// keeps the last good list (#179, #322). These tests drive the real store
// with a controllable daemon answer.

type Answer = { status: number; data: unknown };
const pending: Array<{ machineId: string; resolve: (a: Answer) => void; reject: (e: unknown) => void }> = [];
let ctxFor: (machineId: string) => unknown = (machineId) => ({ machineId });
vi.mock('@/sync/sync', () => ({ sync: { machineOnlyCtx: (id: string) => ctxFor(id) } }));
vi.mock('@/sync/v2/machine', () => ({
    machineListSessions: (ctx: { machineId: string }) => new Promise<Answer>((resolve, reject) => { pending.push({ machineId: ctx.machineId, resolve, reject }); }),
    machineStatusOnly: vi.fn(), machineEnvList: vi.fn(), machineHarnessModels: vi.fn(), machineHistoryLogs: vi.fn(), machineOpencodeSessions: vi.fn(),
}));

import { resources } from '@/sync/resource';
import { joySessionsSpec } from '@/sync/machineResources';
import type { JoySession } from '@/joy/types';

const listOf = (...cwds: string[]): Answer => ({ status: 200, data: { sessions: cwds.map((cwd) => ({ id: cwd, cwd, status: 'active', started_at: 0, tmux_window: 'w' })) } });
const cwds = (machineId: string) => resources.peek<JoySession[]>(joySessionsSpec(machineId).key).data?.map((s) => s.cwd);
const entry = (machineId: string) => resources.peek<JoySession[]>(joySessionsSpec(machineId).key);
const asked = async (n: number) => { while (pending.length < n) await new Promise((r) => setTimeout(r, 0)); };

let n = 0;
const machine = () => `m${++n}`;
beforeEach(() => { pending.length = 0; ctxFor = (machineId) => ({ machineId }); });

describe('useJoyRpcSessions — request order, not just mounted lifetime, decides which list lands', () => {
    it('a list from an earlier request that resolves after a newer one is dropped', async () => {
        const m = machine();
        const p1 = resources.refresh(joySessionsSpec(m));
        const p2 = resources.refresh(joySessionsSpec(m));
        await asked(2);
        pending[1].resolve(listOf('new'));
        await p2;
        pending[0].resolve(listOf('old'));
        await p1;
        expect(cwds(m)).toEqual(['new']);
    });

    it('an error from an earlier request does not replace a newer success', async () => {
        const m = machine();
        const p1 = resources.refresh(joySessionsSpec(m));
        const p2 = resources.refresh(joySessionsSpec(m));
        await asked(2);
        pending[1].resolve(listOf('good'));
        await p2;
        pending[0].resolve({ status: 500, data: { error: 'boom' } });
        await p1;
        expect(cwds(m)).toEqual(['good']);
        expect(entry(m).error).toBeNull();
    });

    it('the newest request reports its error and the last good list is kept (#322)', async () => {
        const m = machine();
        const p1 = resources.refresh(joySessionsSpec(m));
        await asked(1);
        pending[0].resolve(listOf('kept'));
        await p1;
        const p2 = resources.refresh(joySessionsSpec(m));
        await asked(2);
        pending[1].resolve({ status: 500, data: { error: 'daemon exploded' } });
        await p2;
        expect(cwds(m)).toEqual(['kept']);
        expect(entry(m).error).toBe('list sessions failed: daemon exploded');
        const p3 = resources.refresh(joySessionsSpec(m));
        await asked(3);
        pending[2].resolve({ status: 200, data: { sessions: 'not a list' } });
        await p3;
        expect(cwds(m)).toEqual(['kept']);
        expect(entry(m).error).toBe('list sessions failed: HTTP 200');
    });

    it('keys are per machine: another machine\'s request does not supersede this one (#179)', async () => {
        const a = machine();
        const b = machine();
        const pa = resources.refresh(joySessionsSpec(a));
        const pb = resources.refresh(joySessionsSpec(b));
        await asked(2);
        pending[1].resolve(listOf('b'));
        await pb;
        pending[0].resolve(listOf('a'));
        await pa;
        expect(cwds(a)).toEqual(['a']);
        expect(cwds(b)).toEqual(['b']);
    });

    it('no machine context is unavailable, not an empty list', async () => {
        const m = machine();
        ctxFor = () => null;
        await resources.refresh(joySessionsSpec(m));
        expect(entry(m).hasData).toBe(false);
        expect(entry(m).unavailable).toBe('no machine context');
        expect(entry(m).error).toBeNull();
    });
});
