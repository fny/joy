import { describe, expect, it } from 'vitest';
import { resolveDaemonRow, resolveEnvErrorRow } from './joyMachineDaemonState';

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
