/**
 * v2 crypto interop — the SCARIEST seam: the daemon seals with tweetnacl
 * (packages/joy-daemon/src/relay/nucleusLane.ts), the app opens with
 * libsodium-wrappers (this package). Two independent NaCl implementations on
 * the same wire; this test pins that they interoperate in BOTH directions and
 * that the wire formats (v2sk1: envelope, v2e1: content) stay stable.
 *
 * Proven live once (app opened the daemon's real envelope over the deployed
 * relay); this makes it a regression fence.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import _sodium from 'libsodium-wrappers';
import nacl from 'tweetnacl';

let sodium: typeof _sodium;
beforeAll(async () => { await _sodium.ready; sodium = _sodium; });

// ── the daemon's exact seal (mirrored from nucleusLane.ts, tweetnacl) ───────
function daemonSealSessionKey(sessionKey: Uint8Array, accountPub: Uint8Array): string {
    const eph = nacl.box.keyPair();
    const nonce = nacl.randomBytes(nacl.box.nonceLength);
    const ct = nacl.box(sessionKey, nonce, accountPub, eph.secretKey);
    return 'v2sk1:' + Buffer.concat([Buffer.from(eph.publicKey), Buffer.from(nonce), Buffer.from(ct)]).toString('base64');
}
function daemonEncodeContent(text: string, key: Uint8Array | null): string {
    const json = JSON.stringify({ v: 1, t: 'plain', text });
    if (!key) return json;
    const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
    const ct = nacl.secretbox(new Uint8Array(Buffer.from(json, 'utf8')), nonce, key);
    return 'v2e1:' + Buffer.concat([Buffer.from(nonce), Buffer.from(ct)]).toString('base64');
}
function daemonDecodeContent(ciphertext: string, key: Uint8Array): string | null {
    const raw = Buffer.from(ciphertext.slice(5), 'base64');
    const n = nacl.secretbox.nonceLength;
    const pt = nacl.secretbox.open(new Uint8Array(raw.subarray(n)), new Uint8Array(raw.subarray(0, n)), key);
    if (!pt) return null;
    return JSON.parse(Buffer.from(pt).toString('utf8')).text;
}

// ── the app's exact codec (mirrored from crypto.ts / encryption.ts, libsodium) ──
function appOpenSessionKey(envelope: string, contentPriv: Uint8Array): Uint8Array | null {
    if (!envelope.startsWith('v2sk1:')) return null;
    const raw = sodium.from_base64(envelope.slice(6), sodium.base64_variants.ORIGINAL);
    const epk = raw.slice(0, 32);
    const nonce = raw.slice(32, 56);
    const ct = raw.slice(56);
    try { return sodium.crypto_box_open_easy(ct, nonce, epk, contentPriv); } catch { return null; }
}
function appSealContent(text: string, key: Uint8Array): string {
    const json = JSON.stringify({ v: 1, t: 'plain', text });
    const nonce = sodium.randombytes_buf(24);
    const ct = sodium.crypto_secretbox_easy(sodium.from_string(json), nonce, key);
    const buf = new Uint8Array(nonce.length + ct.length);
    buf.set(nonce, 0); buf.set(ct, nonce.length);
    return 'v2e1:' + sodium.to_base64(buf, sodium.base64_variants.ORIGINAL);
}
function appOpenContent(ciphertext: string, key: Uint8Array): string | null {
    const raw = sodium.from_base64(ciphertext.slice(5), sodium.base64_variants.ORIGINAL);
    try {
        const pt = sodium.crypto_secretbox_open_easy(raw.slice(24), raw.slice(0, 24), key);
        return JSON.parse(sodium.to_string(pt)).text;
    } catch { return null; }
}

describe('v2 crypto interop (daemon tweetnacl ↔ app libsodium)', () => {
    it('session-key envelope: daemon seals → app opens the exact key', () => {
        // Account content keypair (app side). Daemon holds only the public key.
        const account = nacl.box.keyPair();
        const sessionKey = nacl.randomBytes(32);
        const envelope = daemonSealSessionKey(sessionKey, account.publicKey);
        expect(envelope.startsWith('v2sk1:')).toBe(true);
        const opened = appOpenSessionKey(envelope, account.secretKey);
        expect(opened).not.toBeNull();
        expect(Buffer.from(opened!).toString('hex')).toBe(Buffer.from(sessionKey).toString('hex'));
    });

    it('content: daemon seals (output) → app opens', () => {
        const key = nacl.randomBytes(32);
        const sealed = daemonEncodeContent('agent output ✓ 日本語', key);
        expect(sealed.startsWith('v2e1:')).toBe(true);
        expect(appOpenContent(sealed, key)).toBe('agent output ✓ 日本語');
    });

    it('content: app seals (prompt) → daemon opens', () => {
        const key = nacl.randomBytes(32);
        const sealed = appSealContent('user prompt ✓ 日本語', key);
        expect(sealed.startsWith('v2e1:')).toBe(true);
        expect(daemonDecodeContent(sealed, key)).toBe('user prompt ✓ 日本語');
    });

    it('wrong key never opens (tamper/mismatch is a clean null, not a crash)', () => {
        const key = nacl.randomBytes(32);
        const wrong = nacl.randomBytes(32);
        expect(appOpenContent(daemonEncodeContent('secret', key), wrong)).toBeNull();
        const account = nacl.box.keyPair();
        const other = nacl.box.keyPair();
        expect(appOpenSessionKey(daemonSealSessionKey(nacl.randomBytes(32), account.publicKey), other.secretKey)).toBeNull();
    });
});
