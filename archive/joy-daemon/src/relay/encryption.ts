/**
 * Wire-format encryption — interop with the existing relay server's E2E scheme.
 *
 * Mirrors `packages/happy-cli/src/api/encryption.ts` (the canonical
 * implementation). Two variants used by the wire today:
 *   - 'legacy': tweetnacl secretbox (XSalsa20-Poly1305), wire = nonce|cipher
 *   - 'dataKey': AES-256-GCM, wire = version|nonce|cipher|tag
 *
 * The relay treats payloads opaquely; both peers must use the same variant.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import tweetnacl from 'tweetnacl';

export type EncryptionVariant = 'legacy' | 'dataKey';

export function randomBytesU8(n: number): Uint8Array {
    return new Uint8Array(randomBytes(n));
}

export function b64encode(buf: Uint8Array): string {
    return Buffer.from(buf).toString('base64');
}

export function b64decode(s: string): Uint8Array {
    return new Uint8Array(Buffer.from(s, 'base64'));
}

function encryptLegacy(data: unknown, key: Uint8Array): Uint8Array {
    const nonce = randomBytesU8(tweetnacl.secretbox.nonceLength);
    const pt = new TextEncoder().encode(JSON.stringify(data));
    const ct = tweetnacl.secretbox(pt, nonce, key);
    const out = new Uint8Array(nonce.length + ct.length);
    out.set(nonce);
    out.set(ct, nonce.length);
    return out;
}

function decryptLegacy(buf: Uint8Array, key: Uint8Array): unknown | null {
    const n = tweetnacl.secretbox.nonceLength;
    if (buf.length < n) return null;
    const nonce = buf.slice(0, n);
    const ct = buf.slice(n);
    const pt = tweetnacl.secretbox.open(ct, nonce, key);
    if (!pt) return null;
    try {
        return JSON.parse(new TextDecoder().decode(pt));
    } catch {
        return null;
    }
}

function encryptDataKey(data: unknown, key: Uint8Array): Uint8Array {
    const nonce = randomBytesU8(12);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    const pt = new TextEncoder().encode(JSON.stringify(data));
    const enc = Buffer.concat([cipher.update(pt), cipher.final()]);
    const tag = cipher.getAuthTag();
    const bundle = new Uint8Array(1 + 12 + enc.length + 16);
    bundle.set([0], 0);
    bundle.set(nonce, 1);
    bundle.set(new Uint8Array(enc), 13);
    bundle.set(new Uint8Array(tag), 13 + enc.length);
    return bundle;
}

function decryptDataKey(buf: Uint8Array, key: Uint8Array): unknown | null {
    if (buf.length < 1 + 12 + 16) return null;
    if (buf[0] !== 0) return null;
    const nonce = buf.slice(1, 13);
    const tag = buf.slice(buf.length - 16);
    const ct = buf.slice(13, buf.length - 16);
    try {
        const dec = createDecipheriv('aes-256-gcm', key, nonce);
        dec.setAuthTag(tag);
        const pt = Buffer.concat([dec.update(ct), dec.final()]);
        return JSON.parse(new TextDecoder().decode(pt));
    } catch {
        return null;
    }
}

export function encrypt(variant: EncryptionVariant, key: Uint8Array, data: unknown): Uint8Array {
    return variant === 'legacy' ? encryptLegacy(data, key) : encryptDataKey(data, key);
}

export function decrypt(variant: EncryptionVariant, key: Uint8Array, buf: Uint8Array): unknown | null {
    return variant === 'legacy' ? decryptLegacy(buf, key) : decryptDataKey(buf, key);
}

/**
 * Anonymous sealed-box (libsodium box_seal-compatible). Used to encrypt a
 * fresh per-session content key for the recipient (the user's account),
 * who decrypts via their private key on the mobile app.
 *
 * Wire: ephemeralPublicKey (32) | nonce (24) | tweetnacl.box ciphertext
 *
 * Ported from packages/happy-cli/src/api/encryption.ts:62.
 */
export function libsodiumEncryptForPublicKey(data: Uint8Array, recipientPublicKey: Uint8Array): Uint8Array {
    const ephemeralKeyPair = tweetnacl.box.keyPair();
    const nonce = randomBytesU8(tweetnacl.box.nonceLength);
    const ct = tweetnacl.box(data, nonce, recipientPublicKey, ephemeralKeyPair.secretKey);
    const out = new Uint8Array(ephemeralKeyPair.publicKey.length + nonce.length + ct.length);
    out.set(ephemeralKeyPair.publicKey, 0);
    out.set(nonce, ephemeralKeyPair.publicKey.length);
    out.set(ct, ephemeralKeyPair.publicKey.length + nonce.length);
    return out;
}
