/**
 * Singleton tests — comm-layer-spec §4.4.
 * Verifies that the control-socket bind is exclusive (the lock), and that
 * release cleans up.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bindSingleton, releaseSingleton, readPidFile } from './singleton';

afterEach(() => {
    releaseSingleton();
    if (process.env.JOY_HOME?.includes('joy-test-')) {
        try { rmSync(process.env.JOY_HOME, { recursive: true, force: true }); } catch { /* ok */ }
    }
    delete process.env.JOY_HOME;
});

describe('singleton', () => {
    it('first bind succeeds and writes a pidfile', async () => {
        process.env.JOY_HOME = mkdtempSync(join(tmpdir(), 'joy-test-'));
        const srv = await bindSingleton(() => undefined);
        const pf = readPidFile();
        expect(pf).not.toBeNull();
        expect(pf?.pid).toBe(process.pid);
        await new Promise<void>((r) => srv.close(() => r()));
    });

    it('second concurrent bind fails with already-running', async () => {
        process.env.JOY_HOME = mkdtempSync(join(tmpdir(), 'joy-test-'));
        const srv = await bindSingleton(() => undefined);
        await expect(bindSingleton(() => undefined)).rejects.toThrow(/already running/);
        await new Promise<void>((r) => srv.close(() => r()));
    });

    it('release cleans up pidfile + socket', async () => {
        process.env.JOY_HOME = mkdtempSync(join(tmpdir(), 'joy-test-'));
        const srv = await bindSingleton(() => undefined);
        await new Promise<void>((r) => srv.close(() => r()));
        releaseSingleton();
        const pidPath = join(process.env.JOY_HOME!, 'run', 'daemon.pid');
        const sockPath = join(process.env.JOY_HOME!, 'run', 'control.sock');
        expect(existsSync(pidPath)).toBe(false);
        // socket may already be gone after close on Linux; tolerate either.
        expect(existsSync(sockPath)).toBe(false);
    });
});
