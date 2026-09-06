import { describe, it, expect, vi, beforeAll } from 'vitest';
import realSodium from 'libsodium-wrappers';

vi.mock('expo-crypto', () => ({
    getRandomBytes: (n: number) => {
        const { randomBytes } = require('crypto');
        return new Uint8Array(randomBytes(n));
    },
}));

// Run against the NATIVE argument contract (whole backing store per arg),
// so these tests fail the way iOS does when a view leaks through (#307).
vi.mock('@/encryption/libsodium.lib', async () => {
    const s = (await import('libsodium-wrappers')).default;
    const { withNativeBufferContract } = await import('./sodiumNativeContract.testutil');
    return { default: withNativeBufferContract(s) };
});

import { boxKeyPairFromSeed, decryptBox, decryptSecretBox, encryptBox, encryptSecretBox } from './libsodium';

beforeAll(async () => {
    await realSodium.ready;
});

/** A 32-byte key that lives in the middle of a 64-byte buffer (HMAC-SHA512 output shape). */
function keyViewInsideLargerBuffer(fill: number): Uint8Array {
    const backing = new Uint8Array(64).fill(fill);
    return backing.subarray(16, 48);
}

describe('libsodium helpers under the native buffer contract', () => {
    it('#306: a bundle sealed to the seed-derived public key opens with the seed-derived private key', () => {
        const seed = new Uint8Array(32).fill(1);
        const { publicKey, privateKey } = boxKeyPairFromSeed(seed);
        const bundle = encryptBox(new Uint8Array([1, 2, 3]), publicKey);
        expect(Array.from(decryptBox(bundle, privateKey)!)).toEqual([1, 2, 3]);
        // The seed itself is NOT the private key — that mismatch was the bug.
        expect(decryptBox(bundle, seed)).toBeNull();
    });

    it('#306: boxKeyPairFromSeed accepts a seed that is a view over a larger buffer', () => {
        const backing = new Uint8Array(64).fill(7);
        const seedView = backing.subarray(8, 40);
        const fromView = boxKeyPairFromSeed(seedView);
        const fromCopy = boxKeyPairFromSeed(new Uint8Array(seedView));
        expect(fromView.publicKey).toEqual(fromCopy.publicKey);
    });

    it('#307: encryptBox seals only the plaintext view, not its backing neighbours', () => {
        const backing = new Uint8Array([9, 1, 2, 9]);
        const kp = realSodium.crypto_box_keypair();
        const bundle = encryptBox(backing.subarray(1, 3), kp.publicKey);
        expect(Array.from(decryptBox(bundle, kp.privateKey)!)).toEqual([1, 2]);
    });

    it('#307: box helpers accept key views over larger buffers and Buffer bundles', () => {
        const kp = realSodium.crypto_box_keypair();
        const pkBacking = new Uint8Array(64);
        pkBacking.set(kp.publicKey, 16);
        const skBacking = new Uint8Array(64);
        skBacking.set(kp.privateKey, 16);
        const bundle = encryptBox(new Uint8Array([5, 6, 7]), pkBacking.subarray(16, 48));
        // Buffer.from(ArrayBuffer-backed bytes) comes out of the shared pool → a view.
        const bufferBundle = Buffer.from(Array.from(bundle));
        expect(bufferBundle.byteOffset !== 0 || bufferBundle.buffer.byteLength !== bufferBundle.length).toBe(true);
        expect(Array.from(decryptBox(bufferBundle, skBacking.subarray(16, 48))!)).toEqual([5, 6, 7]);
    });

    it('#307: secretbox helpers accept a 32-byte key view over a 64-byte buffer, both ways', () => {
        const key = keyViewInsideLargerBuffer(3);
        const sealed = encryptSecretBox({ hello: 'world' }, key);
        expect(decryptSecretBox(sealed, key)).toEqual({ hello: 'world' });
        expect(decryptSecretBox(Buffer.from(Array.from(sealed)), key)).toEqual({ hello: 'world' });
    });

    it('rejects a wrong key and a truncated bundle with null, never a throw', () => {
        const key = new Uint8Array(32).fill(4);
        const sealed = encryptSecretBox('x', key);
        expect(decryptSecretBox(sealed, new Uint8Array(32).fill(5))).toBeNull();
        expect(decryptSecretBox(sealed.subarray(0, 10), key)).toBeNull();
        const kp = realSodium.crypto_box_keypair();
        expect(decryptBox(new Uint8Array(10), kp.privateKey)).toBeNull();
    });
});
