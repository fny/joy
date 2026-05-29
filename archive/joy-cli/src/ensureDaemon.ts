/**
 * Ensure a joy-daemon is up. If not, launch it. Performs the version handshake
 * (joy-daemon-spec §4.4). If a daemon is up but the protocol version mismatches
 * what this CLI expects, surface a clear error (deterministic replace flow is
 * a future addition; for now we refuse to operate against a mismatched daemon
 * rather than silently mis-driving it).
 */
import { spawn } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
    PROTOCOL_VERSION,
    readPidFile,
    processAlive,
} from 'joy-daemon/src/singleton';
import { ControlClient, type ConnectResult } from './control/client';
import { CONTROL_PROTOCOL_VERSION } from 'joy-daemon/src/control/protocol';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Locate the joy-daemon bin shim from this package's node_modules layout. */
function findDaemonBin(): string {
    // packages/joy-cli/src/ → packages/joy-daemon/bin/joy-daemon.mjs
    const candidates = [
        resolve(__dirname, '../../joy-daemon/bin/joy-daemon.mjs'),
        resolve(__dirname, '../../../joy-daemon/bin/joy-daemon.mjs'),
        resolve(__dirname, '../node_modules/joy-daemon/bin/joy-daemon.mjs'),
    ];
    for (const c of candidates) if (existsSync(c)) return c;
    throw new Error('joy-cli: could not locate joy-daemon binary');
}

/** Locate the joy-agent bin shim. */
export function findAgentBin(): string {
    const candidates = [
        resolve(__dirname, '../../joy-agent/bin/joy-agent.mjs'),
        resolve(__dirname, '../../../joy-agent/bin/joy-agent.mjs'),
        resolve(__dirname, '../node_modules/joy-agent/bin/joy-agent.mjs'),
    ];
    for (const c of candidates) if (existsSync(c)) return c;
    throw new Error('joy-cli: could not locate joy-agent binary');
}

export interface EnsureResult {
    connect: ConnectResult;
    /** True if this invocation started the daemon (transient/foreground use). */
    started: boolean;
}

/**
 * Connect to the daemon. If absent, spawn it detached, wait for readiness,
 * then connect. The `foreground` option binds the daemon's lifetime to this
 * cli invocation (kill it on cli exit) — used for `joy <path>` one-shots.
 */
export async function ensureDaemon(opts: { foreground?: boolean } = {}): Promise<EnsureResult> {
    const client = new ControlClient();
    try {
        const c = await client.connect();
        client.close();
        if (c.daemonProtocolVersion !== CONTROL_PROTOCOL_VERSION) {
            throw new Error(`joy-cli: daemon protocol v${c.daemonProtocolVersion} != cli v${CONTROL_PROTOCOL_VERSION}. Restart the daemon.`);
        }
        return { connect: c, started: false };
    } catch (_e) {
        // Not connectable — launch.
    }

    const prior = readPidFile();
    if (prior && processAlive(prior.pid)) {
        if (prior.protocolVersion !== PROTOCOL_VERSION) {
            throw new Error(`joy-cli: daemon protocol v${prior.protocolVersion} != cli v${PROTOCOL_VERSION}. Restart the daemon.`);
        }
        // Live but the socket isn't accepting; rare race — give it a moment.
        await sleep(200);
    }

    const bin = findDaemonBin();
    const child = spawn(process.execPath, [bin], {
        detached: !opts.foreground,
        stdio: opts.foreground ? 'inherit' : 'ignore',
    });
    if (!opts.foreground) child.unref();
    if (opts.foreground) {
        process.on('exit', () => { try { child.kill('SIGTERM'); } catch { /* ok */ } });
        process.on('SIGINT', () => { try { child.kill('SIGINT'); } catch { /* ok */ } });
        process.on('SIGTERM', () => { try { child.kill('SIGTERM'); } catch { /* ok */ } });
    }

    // Wait for readiness by polling connect.
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
        await sleep(150);
        try {
            const c2 = new ControlClient();
            const res = await c2.connect();
            c2.close();
            return { connect: res, started: true };
        } catch {
            /* keep polling */
        }
    }
    throw new Error('joy-cli: timed out waiting for joy-daemon to become ready');
}

function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

// re-exports for command modules
export { join };
