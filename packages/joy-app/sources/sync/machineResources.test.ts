import { describe, it, expect, vi, beforeEach } from 'vitest';

// The machine-level adapters honour the store's four states: a daemon
// refusal / malformed body is an error that keeps the last good value, a
// missing context is unavailable, an authoritative empty result needs an
// explicit successful "none". Driven through the real store with a
// controllable daemon.

type Answer = { status: number; data: unknown };
const { answers, requests, op, ctx } = vi.hoisted(() => {
    const answers: Record<string, Answer | ((...args: unknown[]) => Promise<Answer>)> = {};
    const requests: string[] = [];
    const ctx = { present: true };
    const op = (name: string) => (...args: unknown[]) => {
        requests.push(name);
        const a = answers[name];
        if (!a) throw new Error(`no answer for ${name}`);
        return typeof a === 'function' ? a(...args) : Promise.resolve(a);
    };
    return { answers, requests, op, ctx };
});
vi.mock('@/sync/sync', () => ({ sync: { machineOnlyCtx: (machineId: string) => (ctx.present ? { machineId } : null) } }));
vi.mock('@/sync/v2/machine', () => ({
    machineStatusOnly: op('status'), machineListSessions: op('sessions'), machineEnvList: op('env'),
    machineHarnessModels: op('models'), machineHistoryLogs: op('history'), machineOpencodeSessions: op('opencode'),
}));

import { resources } from '@/sync/resource';
import { harnessModelsSpec, joyMachinesSpec, joySessionsSpec, joyStatusSpec, machineEnvSpec, pastSessionsSpec } from '@/sync/machineResources';

let n = 0;
const machine = () => `m${++n}`;
beforeEach(() => { ctx.present = true; requests.length = 0; for (const k of Object.keys(answers)) delete answers[k]; });

describe('joy-daemon discovery (joyMachinesSpec)', () => {
    it('an HTTP 500 status probe is not a running machine', async () => {
        const m = machine();
        answers.status = { status: 500, data: { error: 'boom' } };
        const e = await resources.refresh(joyMachinesSpec([m]));
        expect(e.data).toEqual([]);
        expect(e.error).toBeNull();
    });

    it('a transport failure keeps the previous good discovery and sets error (after the declared retry)', async () => {
        const m = machine();
        answers.status = { status: 200, data: { ok: true } };
        await resources.refresh(joyMachinesSpec([m]));
        expect(resources.peek<string[]>(joyMachinesSpec([m]).key).data).toEqual([m]);
        answers.status = () => Promise.reject(new Error('down'));
        requests.length = 0;
        const e = await resources.refresh(joyMachinesSpec([m]));
        expect(e.data).toEqual([m]);
        expect(e.error).toContain('unreachable');
        expect(requests.filter((r) => r === 'status').length).toBe(2); // one retry
    }, 5000);

    it('a silent tunnel (probe timeout) is an absent daemon, not an error', async () => {
        const m = machine();
        answers.status = () => new Promise(() => {}); // never answers
        vi.useFakeTimers();
        try {
            const p = resources.refresh(joyMachinesSpec([m]));
            await vi.advanceTimersByTimeAsync(3100);
            const e = await p;
            expect(e).toMatchObject({ data: [], error: null });
        } finally {
            vi.useRealTimers();
        }
    });

    it('no machine context for any probed machine is unavailable, not a negative probe', async () => {
        const m = machine();
        ctx.present = false;
        const e = await resources.refresh(joyMachinesSpec([m]));
        expect(e).toMatchObject({ hasData: false, unavailable: 'no machine context' });
    });

    it('a running daemon beside a refusing one: only the running one is listed', async () => {
        const a = machine();
        const b = machine();
        answers.status = (ctx: unknown) => Promise.resolve((ctx as { machineId: string }).machineId === a ? { status: 200, data: { ok: true } } : { status: 503, data: {} });
        const e = await resources.refresh(joyMachinesSpec([a, b]));
        expect(e.data).toEqual([a]);
    });
});

describe('daemon status (joyStatusSpec)', () => {
    it('a non-200 or ok:false body is an error; a 200 body is the status', async () => {
        const m = machine();
        answers.status = { status: 200, data: { ok: true, version: '1' } };
        expect((await resources.refresh(joyStatusSpec(m))).data).toEqual({ ok: true, version: '1' });
        answers.status = { status: 500, data: { error: 'nope' } };
        const e = await resources.refresh(joyStatusSpec(m));
        expect(e.data).toEqual({ ok: true, version: '1' });
        expect(e.error).toBe('status failed: nope');
    });
});

describe('session list (joySessionsSpec)', () => {
    it('a 200 without a sessions array is an error that keeps the last good list', async () => {
        const m = machine();
        answers.sessions = { status: 200, data: { sessions: [{ id: 'x' }] } };
        await resources.refresh(joySessionsSpec(m));
        answers.sessions = { status: 200, data: { sessions: 'nope' } };
        const e = await resources.refresh(joySessionsSpec(m));
        expect(e.data).toEqual([{ id: 'x' }]);
        expect(e.error).toBe('list sessions failed: HTTP 200');
    });
});

describe('harness model catalogs (harnessModelsSpec)', () => {
    it('a catalog HTTP 500 keeps the valid model list, reports the error and does not stamp it fresh', async () => {
        const m = machine();
        const spec = harnessModelsSpec(m, 'opencode');
        answers.models = { status: 200, data: { ok: true, models: [{ id: 'M', displayName: 'model' }] } };
        const good = await resources.refresh(spec);
        answers.models = { status: 500, data: { error: 'temporary' } };
        const e = await resources.refresh(spec);
        expect(e.data).toEqual([{ id: 'M', displayName: 'model' }]);
        expect(e.error).toBe('models failed: temporary');
        expect(e.checkedAt).toBe(good.checkedAt);
        expect(e.revision).toBe(good.revision);
    });

    it('a 404 (older daemon / unknown harness) is an authoritative empty catalog; a malformed 200 is not', async () => {
        const m = machine();
        answers.models = { status: 404, data: { ok: false, error: 'unknown harness' } };
        expect(await resources.refresh(harnessModelsSpec(m, 'agy'))).toMatchObject({ data: [], error: null });
        answers.models = { status: 200, data: { ok: true } };
        expect(await resources.refresh(harnessModelsSpec(m, 'codex'))).toMatchObject({ hasData: false, error: 'models failed: HTTP 200' });
    });

    it('no context settles unavailable (no endless loading)', async () => {
        const m = machine();
        ctx.present = false;
        expect(await resources.refresh(harnessModelsSpec(m, 'codex'))).toMatchObject({ unavailable: 'no machine context', fetching: false });
    });
});

describe('key readiness — an entry left unavailable before the machine keys hydrated', () => {
    it('is read again once when the context arrives, with the socket connected all along', async () => {
        const m = machine();
        ctx.present = false;
        answers.env = { status: 200, data: { ok: true, names: ['KEY'] } };
        const spec = machineEnvSpec(m);
        const unsubscribe = resources.subscribe(spec.key, () => {});
        await resources.ensure(spec);
        expect(resources.peek(spec.key).unavailable).toBe('no_ctx');
        expect(requests.filter((r) => r === 'env').length).toBe(0);
        ctx.present = true; // sync.ts: machine keys decrypted → resources.onContextReady()
        resources.onContextReady();
        await new Promise((r) => setTimeout(r, 0));
        expect(requests.filter((r) => r === 'env').length).toBe(1);
        expect(resources.peek<string[]>(spec.key)).toMatchObject({ data: ['KEY'], unavailable: null });
        resources.onContextReady();
        await new Promise((r) => setTimeout(r, 0));
        expect(requests.filter((r) => r === 'env').length).toBe(1);
        unsubscribe();
    });
});

describe('sealed environment names (machineEnvSpec)', () => {
    it('validates status and shape; the daemon\'s own code stays the reason', async () => {
        const m = machine();
        answers.env = { status: 200, data: { ok: true, names: ['KEY'] } };
        expect((await resources.refresh(machineEnvSpec(m))).data).toEqual(['KEY']);
        answers.env = { status: 500, data: {} };
        expect(await resources.refresh(machineEnvSpec(m))).toMatchObject({ data: ['KEY'], error: 'http_500' });
        answers.env = { status: 200, data: { ok: false, error: 'no_machine_key' } };
        expect(await resources.refresh(machineEnvSpec(m))).toMatchObject({ data: ['KEY'], error: 'no_machine_key' });
        answers.env = { status: 200, data: { ok: true, names: 'KEY' } };
        expect(await resources.refresh(machineEnvSpec(m))).toMatchObject({ data: ['KEY'], error: 'http_200' });
    });
});

describe('past sessions (pastSessionsSpec)', () => {
    it('history: a non-200 or missing logs array is an error; a valid answer is the sorted rows', async () => {
        const m = machine();
        answers.history = { status: 200, data: { ok: true, logs: [{ sessionId: 'a', sizeBytes: 1, mtimeMs: 1 }, { sessionId: 'b', sizeBytes: 2, mtimeMs: 5 }] } };
        const e = await resources.refresh(pastSessionsSpec(m, '/p', 'claude'));
        expect(e.data?.map((r) => r.id)).toEqual(['b', 'a']);
        answers.history = { status: 500, data: { ok: true, logs: [] } };
        expect(await resources.refresh(pastSessionsSpec(m, '/p', 'claude'))).toMatchObject({ error: 'history failed: HTTP 500' });
        expect(resources.peek(pastSessionsSpec(m, '/p', 'claude').key).data).toEqual(e.data);
    });

    it('opencode: ok without a sessions array is an error', async () => {
        const m = machine();
        answers.opencode = { status: 200, data: { ok: true } };
        expect(await resources.refresh(pastSessionsSpec(m, '/p', 'opencode'))).toMatchObject({ hasData: false, error: 'opencode sessions failed: HTTP 200' });
    });
});
