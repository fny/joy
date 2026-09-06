/**
 * machine.ts turns protocol-level refusals into words every screen can show
 * (#418): a reply with no request binding means an out-of-date daemon, and
 * `e.message` — what JoyMachineView / pane / agent-config alert — must say so
 * without any per-screen change. Also pins that every request carries `t`.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import _sodium from 'libsodium-wrappers';
import { createHmac, randomBytes } from 'node:crypto';

vi.mock('@/encryption/libsodium.lib', async () => { await _sodium.ready; return { default: _sodium }; });
vi.mock('@/encryption/hmac_sha512', () => ({
    hmac_sha512: async (key: Uint8Array, data: Uint8Array) =>
        new Uint8Array(createHmac('sha512', Buffer.from(key)).update(Buffer.from(data)).digest()),
}));
// @/text pulls expo-localization; the wording itself is not under test here.
vi.mock('@/text', () => ({ t: (k: string) => (k === 'errors.daemonOutdated' ? 'DAEMON OUT OF DATE' : k) }));

const hmac512 = (k: Uint8Array, d: Uint8Array) => createHmac('sha512', Buffer.from(k)).update(Buffer.from(d)).digest();
const streamKey = (tk: Uint8Array, sid: Uint8Array) => hmac512(tk, Buffer.concat([Buffer.from('stream'), Buffer.from(sid)])).subarray(0, 32);
const nonceFor = (c: bigint) => { const n = Buffer.alloc(24); n.writeBigUInt64BE(c, 16); return n; };
const bindingOf = (w: Uint8Array) => Buffer.from(w.subarray(0, 16)).toString('hex');
function daemonSeal(tk: Uint8Array, head: unknown, body: Uint8Array): Uint8Array {
    const sid = new Uint8Array(randomBytes(16)); const key = streamKey(tk, sid);
    const parts: Buffer[] = [Buffer.from(sid)]; let c = 0n;
    const push = (p: Uint8Array, fin: boolean) => {
        const tagged = Buffer.concat([Buffer.from([fin ? 1 : 0]), Buffer.from(p)]);
        const ct = Buffer.from(_sodium.crypto_secretbox_easy(tagged, nonceFor(c), key)); c += 1n;
        const f = Buffer.alloc(4 + ct.length); f.writeUInt32BE(ct.length, 0); ct.copy(f, 4); parts.push(f);
    };
    const hb = new TextEncoder().encode(JSON.stringify(head)); push(hb, body.length === 0); if (body.length) push(body, true);
    return new Uint8Array(Buffer.concat(parts));
}
function daemonOpenHead(tk: Uint8Array, wire: Uint8Array): Record<string, unknown> {
    const key = streamKey(tk, wire.subarray(0, 16));
    const len = Buffer.from(wire.buffer, wire.byteOffset + 16, 4).readUInt32BE(0);
    const plain = Buffer.from(_sodium.crypto_secretbox_open_easy(Buffer.from(wire.subarray(20, 20 + len)), nonceFor(0n), key));
    return JSON.parse(plain.subarray(1).toString('utf8'));
}
const stub = (mk: (init: { body?: Uint8Array }) => Uint8Array) => (async (_u: unknown, init: { body?: Uint8Array }) => {
    const b = mk(init);
    return { ok: true, headers: { get: () => 'application/octet-stream' }, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.length) } as never;
}) as never;

describe('machine.ts user-facing tunnel refusals', () => {
    beforeAll(async () => { await _sodium.ready; });
    const master = new Uint8Array(randomBytes(32));
    const ctx = { relayUrl: 'https://r', accountToken: 'tok', machineKey: master, machineId: 'm1' };

    it('an unbound reply (pre-binding daemon) surfaces as the translated "daemon out of date" message, code kept for logs', async () => {
        const { deriveTunnelKey } = await import('./tunnel');
        const { machineStatusOnly, TunnelError } = await import('./machine');
        const key = await deriveTunnelKey(master, 'm1');
        const orig = globalThis.fetch;
        globalThis.fetch = stub(() => daemonSeal(key, { s: 200, h: {} }, new TextEncoder().encode('{}')));
        let err: unknown; try { await machineStatusOnly(ctx); } catch (e) { err = e; }
        globalThis.fetch = orig;
        expect(err).toBeInstanceOf(TunnelError);
        expect((err as Error).message).toBe('DAEMON OUT OF DATE');
        expect((err as InstanceType<typeof TunnelError>).code).toBe('unbound_response');
        expect((err as InstanceType<typeof TunnelError>).status).toBe(502);
    });

    it('a reflected/garbage head (bad_response_head) gets the same wording; other codes keep their raw message', async () => {
        const { machineStatusOnly } = await import('./machine');
        const orig = globalThis.fetch;
        globalThis.fetch = stub((init) => init.body!); // relay reflects our request
        await expect(machineStatusOnly(ctx)).rejects.toMatchObject({ code: 'bad_response_head', message: 'DAEMON OUT OF DATE' });
        globalThis.fetch = (async () => ({ ok: false, status: 503, headers: { get: () => 'application/json' }, json: async () => ({ error: 'daemon_offline' }) })) as never;
        await expect(machineStatusOnly(ctx)).rejects.toMatchObject({ code: 'daemon_offline', message: 'tunnel: 503 daemon_offline' });
        globalThis.fetch = orig;
    });

    it('a bound reply passes through, and the sealed request head carries a fresh client timestamp `t`', async () => {
        const { deriveTunnelKey } = await import('./tunnel');
        const { machineStatusOnly } = await import('./machine');
        const key = await deriveTunnelKey(master, 'm1');
        const orig = globalThis.fetch;
        let sentHead: Record<string, unknown> | null = null;
        globalThis.fetch = stub((init) => { sentHead = daemonOpenHead(key, init.body!); return daemonSeal(key, { s: 200, h: {}, r: bindingOf(init.body!) }, new TextEncoder().encode('{"ok":true}')); });
        const before = Date.now();
        const r = await machineStatusOnly(ctx);
        globalThis.fetch = orig;
        expect(r.status).toBe(200); expect(r.data).toEqual({ ok: true });
        expect(sentHead!.m).toBe('GET'); expect(sentHead!.p).toBe('/v2/status');
        expect(typeof sentHead!.t).toBe('number');
        expect(sentHead!.t as number).toBeGreaterThanOrEqual(before); expect(sentHead!.t as number).toBeLessThanOrEqual(Date.now());
    });
});
