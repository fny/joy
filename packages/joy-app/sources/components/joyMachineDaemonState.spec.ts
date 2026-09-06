import { describe, expect, it } from 'vitest';
import { resolveDaemonRow, resolveDaemonRowFromResource, resolveEnvErrorRow } from './joyMachineDaemonState';

const ok = { ok: true, pid: 42, version: '1.2.3' };

describe('resolveDaemonRow (#228)', () => {
    it('a successful current-machine probe while online reads running', () => {
        const row = resolveDaemonRow({ probe: { machineId: 'A', status: ok }, machineId: 'A', online: true, failed: false });
        expect(row).toMatchObject({ running: true, detail: 'running', loading: false });
        expect(row.status).toBe(ok);
    });

    it('the machine going offline clears the cached running status', () => {
        const row = resolveDaemonRow({ probe: { machineId: 'A', status: ok }, machineId: 'A', online: false, failed: true });
        expect(row).toMatchObject({ running: false, detail: 'offline', status: null, loading: false });
    });

    it('a probe from another machine is never shown for the current one', () => {
        // switched from A to B; B's probe failed
        const failedOnB = resolveDaemonRow({ probe: { machineId: 'A', status: ok }, machineId: 'B', online: true, failed: true });
        expect(failedOnB).toMatchObject({ running: false, detail: 'unreachable', status: null, loading: false });
        // switched from A to B; B's probe still pending
        const pendingOnB = resolveDaemonRow({ probe: { machineId: 'A', status: ok }, machineId: 'B', online: true, failed: false });
        expect(pendingOnB).toMatchObject({ status: null, loading: true });
    });

    it('a current probe reporting ok:false is unreachable but still shows its details', () => {
        const status = { ok: false, version: '1.0.0' };
        const row = resolveDaemonRow({ probe: { machineId: 'A', status }, machineId: 'A', online: true, failed: false });
        expect(row).toMatchObject({ running: false, detail: 'unreachable', loading: false });
        expect(row.status).toBe(status);
    });

    it('no probe yet while online is the loading state', () => {
        expect(resolveDaemonRow({ probe: null, machineId: 'A', online: true, failed: false }).loading).toBe(true);
        expect(resolveDaemonRow({ probe: null, machineId: 'A', online: true, failed: true }).loading).toBe(false);
    });
});

describe('resolveEnvErrorRow (#227)', () => {
    it('renders nothing while there is no error', () => {
        expect(resolveEnvErrorRow(null)).toBeNull();
    });

    it('a missing machine key (daemon or local) is the locked row', () => {
        expect(resolveEnvErrorRow('no_machine_key')).toEqual({ kind: 'no_key' });
        expect(resolveEnvErrorRow('no_ctx')).toEqual({ kind: 'no_key' });
    });

    it('offline, timeout and HTTP failures all get a visible failure row', () => {
        expect(resolveEnvErrorRow('offline')).toEqual({ kind: 'failure', detail: 'offline' });
        expect(resolveEnvErrorRow('Request timed out')).toEqual({ kind: 'failure', detail: 'Request timed out' });
        expect(resolveEnvErrorRow('http_502')).toEqual({ kind: 'failure', detail: 'http_502' });
    });
});

describe('resolveDaemonRowFromResource (shared joy-status entry)', () => {
    type Status = { ok?: boolean; pid?: number; version?: string };
    const entry = (over: Partial<{ data: Status; hasData: boolean; error: string | null; unavailable: string | null }> = {}) => ({
        data: undefined as Status | undefined, hasData: false, error: null as string | null, unavailable: null as string | null, ...over,
    });

    it('offline reads offline whatever the cache holds', () => {
        const row = resolveDaemonRowFromResource({ entry: entry({ data: ok, hasData: true }), online: false, contextTimedOut: false });
        expect(row).toMatchObject({ running: false, detail: 'offline', status: null, loading: false, failed: true });
    });

    it('an ok status while online reads running', () => {
        const row = resolveDaemonRowFromResource({ entry: entry({ data: ok, hasData: true }), online: true, contextTimedOut: false });
        expect(row).toMatchObject({ running: true, detail: 'running', loading: false, failed: false });
        expect(row.status).toBe(ok);
    });

    it('a failed newest probe is unreachable and hides the last good status', () => {
        const row = resolveDaemonRowFromResource({ entry: entry({ data: ok, hasData: true, error: 'timeout' }), online: true, contextTimedOut: false });
        expect(row).toMatchObject({ running: false, detail: 'unreachable', status: null, loading: false, failed: true });
    });

    it('no machine context is loading until the wait times out, then unreachable', () => {
        const waiting = resolveDaemonRowFromResource({ entry: entry({ unavailable: 'no machine context' }), online: true, contextTimedOut: false });
        expect(waiting).toMatchObject({ loading: true, failed: false, status: null });
        const gaveUp = resolveDaemonRowFromResource({ entry: entry({ unavailable: 'no machine context' }), online: true, contextTimedOut: true });
        expect(gaveUp).toMatchObject({ loading: false, detail: 'unreachable', failed: true, status: null });
    });

    it('ok:false is unreachable but still shows its details, and nothing yet is loading', () => {
        const status: Status = { ok: false, version: '1.0.0' };
        const row = resolveDaemonRowFromResource({ entry: entry({ data: status, hasData: true }), online: true, contextTimedOut: false });
        expect(row).toMatchObject({ running: false, detail: 'unreachable', loading: false, failed: false });
        expect(row.status).toBe(status);
        expect(resolveDaemonRowFromResource({ entry: entry(), online: true, contextTimedOut: false })).toMatchObject({ loading: true, failed: false });
    });
});
