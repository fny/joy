/**
 * Control-channel round-trip — comm-layer-spec / joy-daemon-spec §4.2.
 *
 * Spins up the real ControlServer on a real Unix domain socket and connects
 * a Node `net` client. Verifies:
 *  - hello/welcome handshake
 *  - typed CtlRequest/CtlResponse for `daemon.status`
 *  - unknown methods produce a structured error
 *  - bad client protocol version is rejected before any request runs
 */
import { afterEach, describe, expect, it } from 'vitest';
import { connect } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bindSingleton, releaseSingleton } from '../singleton';
import { ControlServer } from './server';
import { SessionManager } from '../sessionManager';
import { RelayClient } from '../relay/relayClient';
import { controlSocketPath } from '../util/paths';
import { CONTROL_PROTOCOL_VERSION, type DaemonStatusResult } from './protocol';

class FakeRelay {
    connect(): void { /* no-op */ }
    close(): void { /* no-op */ }
    subscribe(_s: string, _cb: () => void): () => void { return () => undefined; }
}

afterEach(() => {
    releaseSingleton();
    if (process.env.JOY_HOME?.includes('joy-test-')) {
        try { rmSync(process.env.JOY_HOME, { recursive: true, force: true }); } catch { /* ok */ }
    }
    delete process.env.JOY_HOME;
});

async function startServer(): Promise<{ server: ControlServer; sockPath: string; close: () => Promise<void> }> {
    process.env.JOY_HOME = mkdtempSync(join(tmpdir(), 'joy-test-'));
    const relay = new FakeRelay() as unknown as RelayClient;
    const sm = new SessionManager(relay);
    const server = new ControlServer({ sessionManager: sm, daemonId: 'd-test', daemonPid: process.pid });
    const netSrv = await bindSingleton((s) => server.accept(s));
    return {
        server,
        sockPath: controlSocketPath(),
        close: () => new Promise<void>((r) => netSrv.close(() => r())),
    };
}

interface RpcClient {
    send(obj: unknown): void;
    next(): Promise<unknown>;
    close(): void;
}

function rawClient(sockPath: string): Promise<RpcClient> {
    return new Promise((resolve, reject) => {
        const s = connect(sockPath);
        let buf = '';
        const queue: unknown[] = [];
        const waiters: Array<(v: unknown) => void> = [];
        s.setEncoding('utf8');
        s.on('connect', () => {
            resolve({
                send: (obj) => { s.write(JSON.stringify(obj) + '\n'); },
                next: () =>
                    new Promise<unknown>((res) => {
                        if (queue.length) res(queue.shift()!);
                        else waiters.push(res);
                    }),
                close: () => s.end(),
            });
        });
        s.on('data', (chunk: string) => {
            buf += chunk;
            let idx: number;
            while ((idx = buf.indexOf('\n')) >= 0) {
                const line = buf.slice(0, idx);
                buf = buf.slice(idx + 1);
                if (!line.trim()) continue;
                try {
                    const obj = JSON.parse(line);
                    if (waiters.length) waiters.shift()!(obj);
                    else queue.push(obj);
                } catch { /* ignore */ }
            }
        });
        s.on('error', reject);
    });
}

describe('control channel', () => {
    it('hello/welcome and daemon.status round-trip', async () => {
        const { sockPath, close } = await startServer();
        try {
            const c = await rawClient(sockPath);
            c.send({ type: 'hello', clientProtocolVersion: CONTROL_PROTOCOL_VERSION });
            const welcome = await c.next() as { type: string; daemonProtocolVersion: number };
            expect(welcome.type).toBe('welcome');
            expect(welcome.daemonProtocolVersion).toBe(CONTROL_PROTOCOL_VERSION);

            c.send({ requestId: 'r1', method: 'daemon.status', params: {} });
            const res = await c.next() as { requestId: string; ok: boolean; result?: DaemonStatusResult };
            expect(res.requestId).toBe('r1');
            expect(res.ok).toBe(true);
            expect(res.result?.protocolVersion).toBe(CONTROL_PROTOCOL_VERSION);
            expect(Array.isArray(res.result?.sessions)).toBe(true);
            c.close();
        } finally {
            await close();
        }
    });

    it('unknown method returns a structured error', async () => {
        const { sockPath, close } = await startServer();
        try {
            const c = await rawClient(sockPath);
            c.send({ type: 'hello', clientProtocolVersion: CONTROL_PROTOCOL_VERSION });
            await c.next(); // welcome
            c.send({ requestId: 'r2', method: 'no.such.method', params: {} });
            const res = await c.next() as { ok: boolean; error?: { code: string } };
            expect(res.ok).toBe(false);
            expect(res.error?.code).toBe('unknown-method');
            c.close();
        } finally {
            await close();
        }
    });

    it('mismatched protocol version is rejected before any request', async () => {
        const { sockPath, close } = await startServer();
        try {
            const c = await rawClient(sockPath);
            c.send({ type: 'hello', clientProtocolVersion: CONTROL_PROTOCOL_VERSION + 999 });
            const res = await c.next() as { ok: boolean; error?: { code: string } };
            expect(res.ok).toBe(false);
            expect(res.error?.code).toBe('version-mismatch');
            c.close();
        } finally {
            await close();
        }
    });
});
