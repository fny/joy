import { describe, it, expect, vi, beforeAll } from 'vitest';
import sodium from 'libsodium-wrappers';

// Mock expo-crypto to use Node.js crypto
vi.mock('expo-crypto', () => ({
    getRandomBytes: (n: number) => {
        const { randomBytes } = require('crypto');
        return new Uint8Array(randomBytes(n));
    },
}));

// Mock the libsodium.lib import to use the Node.js libsodium-wrappers, but
// under the NATIVE argument contract (every arg = its whole backing store):
// that is what makes leaked views/Buffers fail here the way they do on iOS (#305).
vi.mock('@/encryption/libsodium.lib', async () => {
    const s = (await import('libsodium-wrappers')).default;
    const { withNativeBufferContract } = await import('./sodiumNativeContract.testutil');
    return { default: withNativeBufferContract(s) };
});

import { encryptBlob, decryptBlob } from './blob';

// 32-byte key for crypto_secretbox (NaCl symmetric encryption)
const TEST_KEY = new Uint8Array(32);
for (let i = 0; i < 32; i++) TEST_KEY[i] = i;

beforeAll(async () => {
    await sodium.ready;
});

describe('blob encryption', () => {
    it('should encrypt and decrypt a small blob', () => {
        const data = new Uint8Array([1, 2, 3, 4, 5]);
        const encrypted = encryptBlob(data, TEST_KEY);
        const decrypted = decryptBlob(encrypted, TEST_KEY);

        expect(decrypted).not.toBeNull();
        expect(new Uint8Array(decrypted!)).toEqual(data);
    });

    it('should encrypt and decrypt an empty blob', () => {
        const data = new Uint8Array(0);
        const encrypted = encryptBlob(data, TEST_KEY);
        const decrypted = decryptBlob(encrypted, TEST_KEY);

        expect(decrypted).not.toBeNull();
        expect(new Uint8Array(decrypted!)).toEqual(data);
    });

    it('should encrypt and decrypt a large blob (1MB)', () => {
        const data = new Uint8Array(1024 * 1024);
        for (let i = 0; i < data.length; i++) data[i] = i % 256;

        const encrypted = encryptBlob(data, TEST_KEY);
        const decrypted = decryptBlob(encrypted, TEST_KEY);

        expect(decrypted).not.toBeNull();
        // Fast byte-compare: vitest's toEqual on a 1M-element typed array does an
        // element-by-element structural diff that takes seconds and trips the
        // default test timeout — Buffer.compare is a single native memcmp.
        expect(decrypted!.length).toBe(data.length);
        expect(Buffer.compare(Buffer.from(decrypted!), Buffer.from(data))).toBe(0);
    });

    it('should handle binary data with null bytes', () => {
        const data = new Uint8Array([0, 0, 0, 255, 0, 128, 0]);
        const encrypted = encryptBlob(data, TEST_KEY);
        const decrypted = decryptBlob(encrypted, TEST_KEY);

        expect(decrypted).not.toBeNull();
        expect(new Uint8Array(decrypted!)).toEqual(data);
    });

    it('should produce different ciphertexts for same plaintext (random nonce)', () => {
        const data = new Uint8Array([1, 2, 3]);
        const encrypted1 = encryptBlob(data, TEST_KEY);
        const encrypted2 = encryptBlob(data, TEST_KEY);

        // Nonces differ, so ciphertexts should differ
        expect(encrypted1).not.toEqual(encrypted2);

        // But both decrypt to the same plaintext
        expect(new Uint8Array(decryptBlob(encrypted1, TEST_KEY)!)).toEqual(data);
        expect(new Uint8Array(decryptBlob(encrypted2, TEST_KEY)!)).toEqual(data);
    });

    it('should return null for wrong key', () => {
        const data = new Uint8Array([1, 2, 3]);
        const encrypted = encryptBlob(data, TEST_KEY);

        const wrongKey = new Uint8Array(32);
        wrongKey.fill(99);

        const decrypted = decryptBlob(encrypted, wrongKey);
        expect(decrypted).toBeNull();
    });

    it('should return null for corrupted ciphertext', () => {
        const data = new Uint8Array([1, 2, 3]);
        const encrypted = encryptBlob(data, TEST_KEY);

        // Corrupt a byte in the ciphertext (after the nonce)
        const corrupted = new Uint8Array(encrypted);
        corrupted[encrypted.length - 1] ^= 0xff;

        const decrypted = decryptBlob(corrupted, TEST_KEY);
        expect(decrypted).toBeNull();
    });

    it('should return null for truncated data', () => {
        const data = new Uint8Array([1, 2, 3]);
        const encrypted = encryptBlob(data, TEST_KEY);

        // Truncate to just 5 bytes (less than nonce)
        const truncated = encrypted.slice(0, 5);
        const decrypted = decryptBlob(truncated, TEST_KEY);
        expect(decrypted).toBeNull();
    });

    it('encrypted blob should be larger than original (nonce + auth tag overhead)', () => {
        const data = new Uint8Array([1, 2, 3, 4, 5]);
        const encrypted = encryptBlob(data, TEST_KEY);

        // crypto_secretbox: 24-byte nonce + 16-byte auth tag + plaintext
        expect(encrypted.length).toBe(data.length + 24 + 16);
    });

    it('#305: a Buffer view over a larger pool encrypts only its own bytes', () => {
        const backing = Buffer.from([9, 1, 2, 9]);
        const view = backing.subarray(1, 3); // Buffer: still a view, .slice() would be too
        const encrypted = encryptBlob(view, TEST_KEY);
        expect(Array.from(decryptBlob(encrypted, TEST_KEY)!)).toEqual([1, 2]);
    });

    it('#305: a Buffer ciphertext decrypts (nonce/ciphertext slices own their bytes)', () => {
        const data = new Uint8Array([4, 5, 6]);
        const encrypted = encryptBlob(data, TEST_KEY);
        const asBuffer = Buffer.from(Array.from(encrypted)); // pooled → shares a backing store
        expect(Array.from(decryptBlob(asBuffer, TEST_KEY)!)).toEqual([4, 5, 6]);
    });

    it('#305: a 32-byte key view over a 64-byte buffer works for both directions', () => {
        const wide = new Uint8Array(64);
        wide.set(TEST_KEY, 16);
        const keyView = wide.subarray(16, 48);
        const bufferKeyView = Buffer.from(wide.buffer, 16, 32);
        const encrypted = encryptBlob(new Uint8Array([7]), keyView);
        expect(Array.from(decryptBlob(encrypted, TEST_KEY)!)).toEqual([7]);
        expect(Array.from(decryptBlob(encrypted, bufferKeyView)!)).toEqual([7]);
    });
});
