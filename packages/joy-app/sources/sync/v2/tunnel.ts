/**
 * App-side sealed tunnel client — reaches the DAEMON's machine plane
 * (/v2/* on the daemon: files, git, terminal, usage, harness config …)
 * through the relay, which forwards opaque frames and can read nothing.
 *
 * Wire protocol mirrors packages/joy-daemon/src/tunnel/{sealedStream,wire}.ts:
 *   stream       : streamId(16) ‖ frames[ len(u32 BE) ‖ ciphertext+tag16 ]
 *   frame plain  : tagByte(0=MSG,1=FINAL) ‖ chunk           (chunk ≤ 128KB)
 *   request      : frame0 = JSON { m, p, h }, then body frames
 *   response     : frame0 = JSON { s, h }, then body frames
 *   AEAD         : ChaCha20-Poly1305 (IETF, 12-byte nonce = counter u64 BE
 *                  in the low 8 bytes) under a per-stream subkey
 *                  HMAC-SHA512(tunnelKey, "stream" ‖ streamId)[0..32]
 *   tunnel key   : deriveKey(masterSecret, 'Joy Tunnel', [machineId]) — the
 *                  SAME key-tree shape the daemon computes, so neither end
 *                  ever transmits it and the relay never holds it.
 */
import sodium from '@/encryption/libsodium.lib';
import { hmac_sha512 } from '@/encryption/hmac_sha512';
import { deriveKey } from '@/encryption/deriveKey';

const CHUNK_MAX = 128 * 1024;
const TAG_MESSAGE = 0x00;
const TAG_FINAL = 0x01;

export class TunnelError extends Error {
    constructor(public status: number, public code: string) {
        super(`tunnel: ${status} ${code}`);
        this.name = 'TunnelError';
    }
}

export interface TunnelResponse { status: number; headers: Record<string, string>; body: Uint8Array }

/** Tunnel key for one machine — mirrors the daemon's deriveTunnelKey. */
export async function deriveTunnelKey(masterSecret: Uint8Array, machineId: string): Promise<Uint8Array> {
    return deriveKey(masterSecret, 'Joy Tunnel', [machineId]);
}

async function streamKey(tunnelKey: Uint8Array, streamId: Uint8Array): Promise<Uint8Array> {
    const data = new Uint8Array(6 + streamId.length);
    data.set(new TextEncoder().encode('stream'), 0);
    data.set(streamId, 6);
    const mac = await hmac_sha512(tunnelKey, data);
    return mac.slice(0, 32);
}

function nonceFor(counter: bigint): Uint8Array {
    const n = new Uint8Array(12);
    new DataView(n.buffer).setBigUint64(4, counter, false); // big-endian, low 8 bytes
    return n;
}

function concat(parts: Uint8Array[]): Uint8Array {
    let len = 0; for (const p of parts) len += p.length;
    const out = new Uint8Array(len);
    let off = 0; for (const p of parts) { out.set(p, off); off += p.length; }
    return out;
}

/** Seal a head + body into one complete request stream. */
async function sealRequest(tunnelKey: Uint8Array, head: unknown, body: Uint8Array): Promise<Uint8Array> {
    const streamId = sodium.randombytes_buf(16);
    const key = await streamKey(tunnelKey, streamId);
    const parts: Uint8Array[] = [streamId];
    let counter = 0n;

    const pushFrame = (plain: Uint8Array, final: boolean) => {
        const tagged = new Uint8Array(1 + plain.length);
        tagged[0] = final ? TAG_FINAL : TAG_MESSAGE;
        tagged.set(plain, 1);
        const ct = sodium.crypto_aead_chacha20poly1305_ietf_encrypt(tagged, null, null, nonceFor(counter), key);
        counter += 1n;
        const frame = new Uint8Array(4 + ct.length);
        new DataView(frame.buffer).setUint32(0, ct.length, false);
        frame.set(ct, 4);
        parts.push(frame);
    };

    const headBytes = new TextEncoder().encode(JSON.stringify(head));
    pushFrame(headBytes, body.length === 0);
    for (let off = 0; off < body.length; off += CHUNK_MAX) {
        const end = Math.min(off + CHUNK_MAX, body.length);
        pushFrame(body.subarray(off, end), end === body.length);
    }
    return concat(parts);
}

/** Open a complete response stream: returns the head JSON and the body. */
async function openResponse<T>(tunnelKey: Uint8Array, wire: Uint8Array): Promise<{ head: T; body: Uint8Array }> {
    if (wire.length < 16) throw new TunnelError(502, 'short_stream');
    const streamId = wire.subarray(0, 16);
    const key = await streamKey(tunnelKey, streamId);
    let off = 16;
    let counter = 0n;
    let head: T | null = null;
    const bodyParts: Uint8Array[] = [];
    let sawFinal = false;

    while (off + 4 <= wire.length) {
        const len = new DataView(wire.buffer, wire.byteOffset + off, 4).getUint32(0, false);
        off += 4;
        if (off + len > wire.length) throw new TunnelError(502, 'truncated_frame');
        const ct = wire.subarray(off, off + len);
        off += len;
        let plain: Uint8Array;
        try {
            plain = sodium.crypto_aead_chacha20poly1305_ietf_decrypt(null, ct, null, nonceFor(counter), key);
        } catch {
            throw new TunnelError(502, 'tamper');
        }
        counter += 1n;
        const final = plain[0] === TAG_FINAL;
        const chunk = plain.subarray(1);
        if (head === null) head = JSON.parse(new TextDecoder().decode(chunk)) as T;
        else bodyParts.push(chunk);
        if (final) { sawFinal = true; break; }
    }
    // No FINAL tag ⇒ the stream was cut; never treat a truncation as success.
    if (!sawFinal || head === null) throw new TunnelError(502, 'stream_truncated');
    return { head, body: concat(bodyParts) };
}

export interface TunnelFetchOpts {
    relayUrl: string;
    accountToken: string;
    masterSecret: Uint8Array;
    machineId: string;
    method: string;
    /** Daemon-local path, e.g. /v2/sessions/abc/git/status */
    path: string;
    headers?: Record<string, string>;
    body?: Uint8Array;
}

/**
 * One sealed request/response exchange with a machine's daemon.
 * Relay-level failures (offline daemon, auth, timeout) throw TunnelError;
 * the daemon's own status arrives INSIDE the sealed envelope.
 */
export async function tunnelFetch(opts: TunnelFetchOpts): Promise<TunnelResponse> {
    const key = await deriveTunnelKey(opts.masterSecret, opts.machineId);
    const wire = await sealRequest(key, { m: opts.method, p: opts.path, h: opts.headers ?? {} }, opts.body ?? new Uint8Array(0));

    const res = await fetch(`${opts.relayUrl}/joy/v2/machines/${encodeURIComponent(opts.machineId)}/http`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${opts.accountToken}`, 'Content-Type': 'application/octet-stream' },
        body: wire as unknown as BodyInit,
    });
    if (res.headers.get('content-type')?.includes('application/json')) {
        const j = await res.json().catch(() => ({ error: 'relay_error' })) as { error?: string };
        throw new TunnelError(res.status, j.error ?? 'relay_error');
    }
    if (!res.ok) throw new TunnelError(res.status, 'relay_error');
    const buf = new Uint8Array(await res.arrayBuffer());
    const { head, body } = await openResponse<{ s: number; h: Record<string, string> }>(key, buf);
    return { status: head.s, headers: head.h, body };
}

/** JSON convenience: sealed request, parsed daemon response. */
export async function tunnelJson<T>(
    opts: Omit<TunnelFetchOpts, 'body'> & { json?: unknown },
): Promise<{ status: number; data: T | null }> {
    const body = opts.json === undefined ? undefined : new TextEncoder().encode(JSON.stringify(opts.json));
    const r = await tunnelFetch({
        ...opts,
        headers: { ...(opts.headers ?? {}), ...(body ? { 'content-type': 'application/json' } : {}) },
        body,
    });
    const text = new TextDecoder().decode(r.body);
    let data: T | null = null;
    try { data = text ? JSON.parse(text) as T : null; } catch { data = null; }
    return { status: r.status, data };
}
