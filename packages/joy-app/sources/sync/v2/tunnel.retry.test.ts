/**
 * tunnel.ts against a scripted relay (fetch stubbed): the 503 busy family is
 * retried per retry-after (bounded, re-sealed each time), daemon_offline is
 * not, and a response cut after its verified head is `connection_slow` — a
 * GET re-asked once, a write surfaced as is. machine.ts words the codes.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import _sodium from 'libsodium-wrappers';
import { createHmac, randomBytes } from 'node:crypto';

vi.mock('@/encryption/libsodium.lib', async () => { await _sodium.ready; return { default: _sodium }; });
vi.mock('@/encryption/hmac_sha512', () => ({
    hmac_sha512: async (key: Uint8Array, data: Uint8Array) =>
        new Uint8Array(createHmac('sha512', Buffer.from(key)).update(Buffer.from(data)).digest()),
}));
vi.mock('@/text', () => ({ t: (k: string) => ({ 'errors.relayBusy': 'RELAY BUSY', 'errors.machineBusy': 'MACHINE BUSY', 'errors.connectionTooSlow': 'TOO SLOW', 'newSession.machineOffline': 'OFFLINE' } as Record<string, string>)[k] ?? k }));

const hmac512 = (k: Uint8Array, d: Uint8Array) => createHmac('sha512', Buffer.from(k)).update(Buffer.from(d)).digest();
const streamKey = (tk: Uint8Array, sid: Uint8Array) => hmac512(tk, Buffer.concat([Buffer.from('stream'), Buffer.from(sid)])).subarray(0, 32);
const nonceFor = (c: bigint) => { const n = Buffer.alloc(24); n.writeBigUInt64BE(c, 16); return n; };
const bindingOf = (w: Uint8Array) => Buffer.from(w.subarray(0, 16)).toString('hex');
/** Daemon-side seal; `cut` drops the FINAL body frame (the relay destroyed the stream mid-body). */
function daemonSeal(tk: Uint8Array, head: unknown, body: Uint8Array, cut = false): Uint8Array {
    const sid = new Uint8Array(randomBytes(16)); const key = streamKey(tk, sid);
    const parts: Buffer[] = [Buffer.from(sid)]; let c = 0n;
    const push = (p: Uint8Array, fin: boolean) => {
        const tagged = Buffer.concat([Buffer.from([fin ? 1 : 0]), Buffer.from(p)]);
        const ct = Buffer.from(_sodium.crypto_secretbox_easy(tagged, nonceFor(c), key)); c += 1n;
        const f = Buffer.alloc(4 + ct.length); f.writeUInt32BE(ct.length, 0); ct.copy(f, 4); parts.push(f);
    };
    push(new TextEncoder().encode(JSON.stringify(head)), false);
    push(body.subarray(0, Math.ceil(body.length / 2)), false);
    if (!cut) push(body.subarray(Math.ceil(body.length / 2)), true);
    return new Uint8Array(Buffer.concat(parts));
}

type Step =
    | { kind: 'json'; status: number; error: string; retryAfter?: string }
    | { kind: 'ok'; body: string }
    | { kind: 'cut'; body: string }
    | { kind: 'dead' }; // 200 headers, then arrayBuffer() rejects (socket destroyed)
const bodies: Uint8Array[] = [];
const times: number[] = [];
function relay(script: Step[]) {
    bodies.length = 0; times.length = 0;
    return (async (_u: unknown, init: { body: Uint8Array }) => {
        const step = script.shift() ?? { kind: 'json', status: 500, error: 'unscripted' } as Step;
        bodies.push(init.body); times.push(Date.now());
        if (step.kind === 'json') {
            return {
                ok: false, status: step.status,
                headers: { get: (h: string) => (h === 'content-type' ? 'application/json' : h === 'retry-after' ? step.retryAfter ?? null : null) },
                json: async () => ({ error: step.error }),
            } as never;
        }
        const key = await (await import('./tunnel')).deriveTunnelKey(master, 'm1');
        const wire = step.kind === 'dead' ? new Uint8Array(0)
            : daemonSeal(key, { s: 200, h: {}, r: bindingOf(init.body) }, new TextEncoder().encode(step.body), step.kind === 'cut');
        return {
            ok: true, status: 200, headers: { get: (h: string) => (h === 'content-type' ? 'application/octet-stream' : null) },
            arrayBuffer: async () => { if (step.kind === 'dead') throw new TypeError('Network request failed'); return wire.buffer.slice(wire.byteOffset, wire.byteOffset + wire.length); },
        } as never;
    }) as never;
}

const master = new Uint8Array(randomBytes(32));
const ctx = { relayUrl: 'https://r', accountToken: 'tok', machineKey: master, machineId: 'm1' };
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

describe('tunnel.ts retry and cut-stream handling', () => {
    beforeAll(async () => { await _sodium.ready; });

    it('retryAfterMs: seconds → ms, missing/garbage → 1s, capped at 5s', async () => {
        const { retryAfterMs } = await import('./tunnel');
        expect(retryAfterMs('1')).toBe(1000); expect(retryAfterMs('0')).toBe(0);
        expect(retryAfterMs(null)).toBe(1000); expect(retryAfterMs('x')).toBe(1000); expect(retryAfterMs('99')).toBe(5000);
    });

    it('503 relay_busy then daemon_busy are retried per retry-after; each attempt is a fresh sealed request', async () => {
        const { tunnelFetch } = await import('./tunnel');
        const orig = globalThis.fetch;
        globalThis.fetch = relay([{ kind: 'json', status: 503, error: 'relay_busy', retryAfter: '0' }, { kind: 'json', status: 503, error: 'daemon_busy', retryAfter: '0' }, { kind: 'ok', body: 'third time' }]);
        const r = await tunnelFetch({ ...ctx, method: 'GET', path: '/v2/status' });
        globalThis.fetch = orig;
        expect(r.status).toBe(200); expect(dec(r.body)).toBe('third time');
        expect(bodies.length).toBe(3);
        expect(new Set(bodies.map(bindingOf)).size).toBe(3); // re-sealed: distinct stream ids, never a byte replay
    });

    it('still busy after 3 attempts → TunnelError with the relay code; machine.ts words it', async () => {
        const { tunnelFetch, TUNNEL_MAX_ATTEMPTS } = await import('./tunnel');
        const { machineStatusOnly } = await import('./machine');
        const orig = globalThis.fetch;
        globalThis.fetch = relay(Array.from({ length: 6 }, () => ({ kind: 'json', status: 503, error: 'relay_busy', retryAfter: '0' } as Step)));
        await expect(tunnelFetch({ ...ctx, method: 'GET', path: '/v2/status' })).rejects.toMatchObject({ status: 503, code: 'relay_busy' });
        expect(bodies.length).toBe(TUNNEL_MAX_ATTEMPTS);
        globalThis.fetch = relay(Array.from({ length: 6 }, () => ({ kind: 'json', status: 503, error: 'daemon_busy', retryAfter: '0' } as Step)));
        await expect(machineStatusOnly(ctx)).rejects.toMatchObject({ code: 'daemon_busy', message: 'MACHINE BUSY' });
        globalThis.fetch = relay(Array.from({ length: 6 }, () => ({ kind: 'json', status: 503, error: 'relay_busy', retryAfter: '0' } as Step)));
        await expect(machineStatusOnly(ctx)).rejects.toMatchObject({ code: 'relay_busy', message: 'RELAY BUSY' });
        globalThis.fetch = orig;
    });

    it('retry-after paces the retry', async () => {
        const { tunnelFetch } = await import('./tunnel');
        const orig = globalThis.fetch;
        globalThis.fetch = relay([{ kind: 'json', status: 503, error: 'daemon_busy', retryAfter: '0.2' }, { kind: 'ok', body: 'ok' }]);
        await tunnelFetch({ ...ctx, method: 'GET', path: '/v2/status' });
        globalThis.fetch = orig;
        expect(times[1] - times[0]).toBeGreaterThanOrEqual(180);
    });

    it('503 daemon_offline is not retried (one attempt) and reads as offline', async () => {
        const { machineStatusOnly } = await import('./machine');
        const orig = globalThis.fetch;
        globalThis.fetch = relay([{ kind: 'json', status: 503, error: 'daemon_offline', retryAfter: '1' }, { kind: 'ok', body: 'never' }]);
        await expect(machineStatusOnly(ctx)).rejects.toMatchObject({ code: 'daemon_offline', message: 'OFFLINE' });
        globalThis.fetch = orig;
        expect(bodies.length).toBe(1);
    });

    it('a stream cut after its verified head is connection_slow, not tamper; a GET is re-asked once', async () => {
        const { tunnelFetch } = await import('./tunnel');
        const { machineStatusOnly } = await import('./machine');
        const orig = globalThis.fetch;
        globalThis.fetch = relay([{ kind: 'cut', body: 'partial' }, { kind: 'ok', body: 'whole' }]);
        const r = await tunnelFetch({ ...ctx, method: 'GET', path: '/v2/status' });
        expect(dec(r.body)).toBe('whole'); expect(bodies.length).toBe(2);
        // cut twice → surfaced, worded by machine.ts
        globalThis.fetch = relay([{ kind: 'cut', body: 'a' }, { kind: 'cut', body: 'b' }]);
        await expect(machineStatusOnly(ctx)).rejects.toMatchObject({ code: 'connection_slow', status: 502, message: 'TOO SLOW' });
        expect(bodies.length).toBe(2);
        // a body that dies under arrayBuffer() (socket destroyed) is the same condition
        globalThis.fetch = relay([{ kind: 'dead' }, { kind: 'ok', body: 'recovered' }]);
        expect(dec((await tunnelFetch({ ...ctx, method: 'GET', path: '/v2/status' })).body)).toBe('recovered');
        globalThis.fetch = orig;
    });

    it('a cut write (POST) is NOT re-asked — connection_slow after one attempt', async () => {
        const { tunnelFetch } = await import('./tunnel');
        const orig = globalThis.fetch;
        globalThis.fetch = relay([{ kind: 'cut', body: 'partial' }, { kind: 'ok', body: 'never' }]);
        await expect(tunnelFetch({ ...ctx, method: 'POST', path: '/v2/send', body: new TextEncoder().encode('{}') })).rejects.toMatchObject({ code: 'connection_slow' });
        globalThis.fetch = orig;
        expect(bodies.length).toBe(1);
    });

    it('a response with no readable head at all still fails closed as before (never connection_slow)', async () => {
        const { tunnelFetch } = await import('./tunnel');
        const orig = globalThis.fetch;
        globalThis.fetch = (async () => ({ ok: true, status: 200, headers: { get: () => 'application/octet-stream' }, arrayBuffer: async () => new Uint8Array(8).buffer })) as never;
        await expect(tunnelFetch({ ...ctx, method: 'GET', path: '/v2/status' })).rejects.toMatchObject({ code: 'short_stream' });
        globalThis.fetch = orig;
    });
});
