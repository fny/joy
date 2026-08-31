/**
 * Tunnel crypto interop: the app (libsodium) must seal/open exactly what the
 * daemon (node:crypto) does. Mirrors the daemon's implementation inline and
 * cross-checks both directions — a nonce/derivation drift here would break
 * every machine-plane call at runtime, so it is pinned.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import _sodium from 'libsodium-wrappers';
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';

vi.mock('@/encryption/libsodium.lib', async () => { await _sodium.ready; return { default: _sodium }; });
vi.mock('@/encryption/hmac_sha512', () => ({
    hmac_sha512: async (key: Uint8Array, data: Uint8Array) =>
        new Uint8Array(createHmac('sha512', Buffer.from(key)).update(Buffer.from(data)).digest()),
}));

// ── daemon-side implementation (copied from sealedStream.ts) ───────────────
const hmac512 = (k: Uint8Array, d: Uint8Array) => createHmac('sha512', Buffer.from(k)).update(Buffer.from(d)).digest();
function daemonDeriveTunnelKey(master: Uint8Array, machineId: string): Uint8Array {
    const I = hmac512(new TextEncoder().encode('Joy Tunnel Master Seed'), master);
    const chain = I.subarray(32);
    const I2 = hmac512(chain, Buffer.concat([Buffer.from([0x00]), Buffer.from(machineId, 'utf8')]));
    return new Uint8Array(I2.subarray(0, 32));
}
function daemonStreamKey(tunnelKey: Uint8Array, streamId: Uint8Array): Buffer {
    return hmac512(tunnelKey, Buffer.concat([Buffer.from('stream'), Buffer.from(streamId)])).subarray(0, 32);
}
function nonceFor(counter: bigint): Buffer {
    const n = Buffer.alloc(12); n.writeBigUInt64BE(counter, 4); return n;
}
/** Daemon seals a response stream (head + body). */
function daemonSealResponse(tunnelKey: Uint8Array, head: unknown, body: Uint8Array): Uint8Array {
    const streamId = new Uint8Array(randomBytes(16));
    const key = daemonStreamKey(tunnelKey, streamId);
    const parts: Buffer[] = [Buffer.from(streamId)];
    let counter = 0n;
    const push = (plain: Uint8Array, final: boolean) => {
        const c = createCipheriv('chacha20-poly1305', key, nonceFor(counter), { authTagLength: 16 });
        const tagged = Buffer.concat([Buffer.from([final ? 1 : 0]), Buffer.from(plain)]);
        const ct = Buffer.concat([c.update(tagged), c.final(), c.getAuthTag()]);
        counter += 1n;
        const f = Buffer.alloc(4 + ct.length); f.writeUInt32BE(ct.length, 0); ct.copy(f, 4);
        parts.push(f);
    };
    const headBytes = new TextEncoder().encode(JSON.stringify(head));
    push(headBytes, body.length === 0);
    if (body.length > 0) push(body, true);
    return new Uint8Array(Buffer.concat(parts));
}
/** Daemon opens a request stream the app sealed. */
function daemonOpenRequest(tunnelKey: Uint8Array, wire: Uint8Array): { head: any; body: Uint8Array } {
    const streamId = wire.subarray(0, 16);
    const key = daemonStreamKey(tunnelKey, streamId);
    let off = 16, counter = 0n; let head: any = null; const body: Buffer[] = [];
    while (off + 4 <= wire.length) {
        const len = Buffer.from(wire.buffer, wire.byteOffset + off, 4).readUInt32BE(0); off += 4;
        const ct = Buffer.from(wire.subarray(off, off + len)); off += len;
        const d = createDecipheriv('chacha20-poly1305', key, nonceFor(counter), { authTagLength: 16 });
        d.setAuthTag(ct.subarray(ct.length - 16));
        const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
        counter += 1n;
        const final = plain[0] === 1; const chunk = plain.subarray(1);
        if (head === null) head = JSON.parse(chunk.toString('utf8')); else body.push(chunk);
        if (final) break;
    }
    return { head, body: new Uint8Array(Buffer.concat(body)) };
}

describe('tunnel crypto interop (app libsodium ↔ daemon node:crypto)', () => {
    beforeAll(async () => { await _sodium.ready; });

    it('derives the SAME tunnel key on both sides', async () => {
        const { deriveTunnelKey } = await import('./tunnel');
        const master = new Uint8Array(randomBytes(32));
        const appKey = await deriveTunnelKey(master, 'machine-abc');
        const daemonKey = daemonDeriveTunnelKey(master, 'machine-abc');
        expect(Buffer.from(appKey).toString('hex')).toBe(Buffer.from(daemonKey).toString('hex'));
    });

    it('daemon opens a request the APP sealed (head + body intact)', async () => {
        const mod = await import('./tunnel');
        const master = new Uint8Array(randomBytes(32));
        const key = await mod.deriveTunnelKey(master, 'm1');
        // reach the private sealer through a real fetch stub
        const bodyOut = new TextEncoder().encode(JSON.stringify({ hello: 'world' }));
        let captured: Uint8Array | null = null;
        const origFetch = globalThis.fetch;
        globalThis.fetch = (async (_u: unknown, init: { body?: Uint8Array }) => {
            captured = init.body as Uint8Array;
            // reply with a daemon-sealed response so tunnelFetch completes
            const resp = daemonSealResponse(key, { s: 200, h: { 'content-type': 'application/json' } }, new TextEncoder().encode('{"ok":true}'));
            return { ok: true, headers: { get: () => 'application/octet-stream' }, arrayBuffer: async () => resp.buffer } as never;
        }) as never;
        const r = await mod.tunnelFetch({
            relayUrl: 'https://relay.test', accountToken: 'tok', machineKey: master, machineId: 'm1',
            method: 'PUT', path: '/v2/sessions/s1/files/content', headers: { 'content-type': 'application/json' }, body: bodyOut,
        });
        globalThis.fetch = origFetch;
        expect(captured).not.toBeNull();
        const opened = daemonOpenRequest(key, captured!);
        expect(opened.head.m).toBe('PUT');
        expect(opened.head.p).toBe('/v2/sessions/s1/files/content');
        expect(new TextDecoder().decode(opened.body)).toBe(JSON.stringify({ hello: 'world' }));
        // and the app opened the daemon's sealed response
        expect(r.status).toBe(200);
        expect(new TextDecoder().decode(r.body)).toBe('{"ok":true}');
    });

    it('a truncated response stream is rejected, never silently empty', async () => {
        const mod = await import('./tunnel');
        const master = new Uint8Array(randomBytes(32));
        const key = await mod.deriveTunnelKey(master, 'm2');
        const full = daemonSealResponse(key, { s: 200, h: {} }, new TextEncoder().encode('body'));
        const cut = full.subarray(0, full.length - 10); // lose the FINAL frame tail
        const origFetch = globalThis.fetch;
        globalThis.fetch = (async () => ({
            ok: true, headers: { get: () => 'application/octet-stream' }, arrayBuffer: async () => cut.buffer.slice(cut.byteOffset, cut.byteOffset + cut.length),
        }) as never) as never;
        await expect(mod.tunnelFetch({
            relayUrl: 'https://relay.test', accountToken: 't', machineKey: master, machineId: 'm2',
            method: 'GET', path: '/v2/status',
        })).rejects.toThrow();
        globalThis.fetch = origFetch;
    });
});
