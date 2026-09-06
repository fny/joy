/**
 * Round-trip tests for aes.web.ts running against the same crypto.subtle
 * that web-secure-encryption uses on the web build, so a successful round
 * trip here implies wire compatibility with what rn-encryption emits on
 * the native side (which uses the AES.GCM SealedBox combined-format:
 * 12-byte nonce + ciphertext + 16-byte tag).
 */
import { describe, it, expect } from 'vitest';
import {
    encryptAESGCMString,
    decryptAESGCMString,
    encryptAESGCM,
    decryptAESGCM,
} from './aes.web';
import { encodeBase64 } from './base64';

function randomKeyB64(): string {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    return encodeBase64(bytes);
}

describe('aes.web', () => {
    it('round-trips a string', async () => {
        const key = randomKeyB64();
        const plain = JSON.stringify({ msg: 'Hello, World!', n: 42 });
        const encrypted = await encryptAESGCMString(plain, key);
        expect(typeof encrypted).toBe('string');
        const decrypted = await decryptAESGCMString(encrypted, key);
        expect(decrypted).toBe(plain);
    });

    it('produces a fresh IV per call (no two ciphertexts equal)', async () => {
        const key = randomKeyB64();
        const a = await encryptAESGCMString('same', key);
        const b = await encryptAESGCMString('same', key);
        expect(a).not.toBe(b);
    });

    it('rejects ciphertext encrypted under a different key', async () => {
        const k1 = randomKeyB64();
        const k2 = randomKeyB64();
        const encrypted = await encryptAESGCMString('secret', k1);
        const result = await decryptAESGCMString(encrypted, k2);
        expect(result).toBeNull();
    });

    it('rejects truncated ciphertext gracefully', async () => {
        const key = randomKeyB64();
        const encrypted = await encryptAESGCMString('hello', key);
        const result = await decryptAESGCMString(encrypted.slice(0, 4), key);
        expect(result).toBeNull();
    });

    it('round-trips a Uint8Array via the bytes API', async () => {
        const key = randomKeyB64();
        const data = new TextEncoder().encode('Hello, World!');
        const encrypted = await encryptAESGCM(data, key);
        expect(encrypted).toBeInstanceOf(Uint8Array);
        const decrypted = await decryptAESGCM(encrypted, key);
        expect(decrypted).toBeInstanceOf(Uint8Array);
        expect(new TextDecoder().decode(decrypted!)).toBe('Hello, World!');
    });

    it('produces wire format: 12-byte IV prefix + ciphertext + 16-byte tag', async () => {
        const key = randomKeyB64();
        const encrypted = await encryptAESGCMString('a', key);
        // base64 payload = IV(12) + ciphertext("a" → 1 byte) + GCM tag(16) = 29 bytes
        // base64 encoded length for 29 bytes = ceil(29/3)*4 = 40 chars (with padding)
        const decoded = Uint8Array.from(atob(encrypted), (c) => c.charCodeAt(0));
        expect(decoded.length).toBe(12 + 1 + 16);
    });

    it('#303: the bytes API round-trips invalid UTF-8 and a BOM exactly', async () => {
        const key = randomKeyB64();
        for (const bytes of [[255, 128, 0, 65], [0xef, 0xbb, 0xbf, 0x41]]) {
            const sealed = await encryptAESGCM(new Uint8Array(bytes), key);
            expect(Array.from((await decryptAESGCM(sealed, key))!)).toEqual(bytes);
        }
    });

    it('#304: an empty plaintext decrypts to an empty Uint8Array, not null', async () => {
        const key = randomKeyB64();
        const opened = await decryptAESGCM(await encryptAESGCM(new Uint8Array(0), key), key);
        expect(opened).toBeInstanceOf(Uint8Array);
        expect(opened!.length).toBe(0);
    });

    it('#302: plaintext whitespace is preserved', async () => {
        const key = randomKeyB64();
        expect(await decryptAESGCMString(await encryptAESGCMString('  x\n', key), key)).toBe('  x\n');
    });
});

describe('aes.web byte envelope (#303)', () => {
    it('OLD unversioned byte ciphertext still decrypts to its raw bytes (real WebCrypto)', async () => {
        const key = encodeBase64(new Uint8Array(32).fill(1));
        // The reviewer's case: a pre-envelope blob whose bytes spell "QUJD"
        // came back as "ABC" once the byte API assumed base64.
        const old = await encryptAESGCMString('QUJD', key);
        const opened = await decryptAESGCM(new Uint8Array(Buffer.from(old, 'base64')), key);
        expect(new TextDecoder().decode(opened!)).toBe('QUJD');
        const oldText = await encryptAESGCMString('plain text, not base64', key);
        expect(new TextDecoder().decode((await decryptAESGCM(new Uint8Array(Buffer.from(oldText, 'base64')), key))!)).toBe('plain text, not base64');
    });

    it('new byte payloads are versioned by a carrier byte outside the ciphertext and round-trip arbitrary bytes', async () => {
        const key = encodeBase64(new Uint8Array(32).fill(2));
        const bytes = new Uint8Array([255, 128, 0, 65]);
        const sealed = await encryptAESGCM(bytes, key);
        expect(sealed[0]).toBe(0x01);
        expect(Array.from((await decryptAESGCM(sealed, key))!)).toEqual([255, 128, 0, 65]);
        // The GCM plaintext is bare base64: no reserved marker inside it.
        expect(await decryptAESGCMString(encodeBase64(sealed.subarray(1)), key)).toBe(encodeBase64(bytes));
    });

    it('#303 residual: legacy plaintext that begins with the old in-band marker decodes to that text, not to ABC (real WebCrypto)', async () => {
        const key = encodeBase64(new Uint8Array(32).fill(3));
        const old = await encryptAESGCMString('joy-aes-bytes-v1:QUJD', key);
        const opened = await decryptAESGCM(new Uint8Array(Buffer.from(old, 'base64')), key);
        expect(new TextDecoder().decode(opened!)).toBe('joy-aes-bytes-v1:QUJD');
    });

    it('a legacy blob whose nonce happens to start with 0x01 is still opened as legacy', async () => {
        const key = encodeBase64(new Uint8Array(32).fill(4));
        let legacy: Uint8Array;
        do {
            legacy = new Uint8Array(Buffer.from(await encryptAESGCMString('QUJD', key), 'base64'));
        } while (legacy[0] !== 0x01);
        expect(new TextDecoder().decode((await decryptAESGCM(legacy, key))!)).toBe('QUJD');
    });
});
