import { describe, expect, it, vi } from 'vitest';
import { SyncInitGate, SyncInitUnavailableError } from './initGate';

describe('SyncInitGate (#88 #190 #189)', () => {
    it('runs init once and skips every later attempt while the engine is up', async () => {
        const gate = new SyncInitGate();
        const init = vi.fn(async () => {});
        expect(await gate.run(init)).toBe('ran');
        expect(gate.status).toBe('ready');
        expect(await gate.run(init)).toBe('skipped');
        expect(init).toHaveBeenCalledTimes(1);
    });

    it('a failed restore refuses the following login instead of pretending it succeeded', async () => {
        // Reviewer #88/#190: syncRestore throws on boot, the login screen
        // appears, the user logs in — syncCreate used to be a silent no-op
        // against the consumed one-shot flag and the app "authenticated".
        const gate = new SyncInitGate();
        const restore = vi.fn(async () => { throw new Error('no WebCrypto'); });
        await expect(gate.run(restore)).rejects.toThrow('no WebCrypto');
        expect(gate.status).toBe('failed');
        expect(gate.reloadRequired).toBe(true);

        const create = vi.fn(async () => {});
        await expect(gate.run(create)).rejects.toBeInstanceOf(SyncInitUnavailableError);
        expect(create).not.toHaveBeenCalled();
    });

    it('a logout that could not reload stops the engine for good: the next login is refused, not bound to the old account', async () => {
        // Reviewer #189: Updates.reloadAsync rejected after logout(A); login(B)
        // used to return early from syncCreate with A's engine still bound.
        const gate = new SyncInitGate();
        await gate.run(async () => {});
        gate.markStopped();
        const create = vi.fn(async () => {});
        await expect(gate.run(create)).rejects.toMatchObject({ name: 'SyncInitUnavailableError', status: 'stopped' });
        expect(create).not.toHaveBeenCalled();
        expect(gate.reloadRequired).toBe(true);
    });

    it('a second init requested while the first is still starting is skipped, not double-run', async () => {
        const gate = new SyncInitGate();
        let release!: () => void;
        const first = gate.run(() => new Promise<void>((resolve) => { release = resolve; }));
        expect(gate.status).toBe('starting');
        const init = vi.fn(async () => {});
        expect(await gate.run(init)).toBe('skipped');
        release();
        expect(await first).toBe('ran');
        expect(init).not.toHaveBeenCalled();
    });
});
