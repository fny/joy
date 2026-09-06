/**
 * BoxEncryption under the NATIVE libsodium argument contract: the caller-
 * provided seed is a slice of derived key material, and the native module
 * reads a view's whole backing store — a 32-byte view over 64 bytes of HMAC
 * output must still derive the pair from exactly those 32 bytes (#305/#307
 * sweep).
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import _sodium from 'libsodium-wrappers';
import { webcrypto } from 'node:crypto';

vi.mock('@/encryption/libsodium.lib', async () => {
    const s = (await import('libsodium-wrappers')).default;
    await s.ready;
    const { withNativeBufferContract } = await import('@/encryption/sodiumNativeContract.testutil');
    return { default: withNativeBufferContract(s) };
});
vi.mock('rn-encryption', () => ({}));
vi.mock('expo-crypto', () => ({
    getRandomBytes: (n: number) => webcrypto.getRandomValues(new Uint8Array(n)),
    randomUUID: () => webcrypto.randomUUID(),
}));

import { BoxEncryption } from './encryptor';

describe('BoxEncryption seed ownership (native contract)', () => {
    beforeAll(async () => { await _sodium.ready; });

    it('derives from a seed VIEW exactly as from a standalone copy, and round-trips', async () => {
        const material = new Uint8Array(64);
        for (let i = 0; i < 64; i++) material[i] = i;
        const seedView = material.subarray(0, 32);
        const seedCopy = new Uint8Array(seedView);

        const fromView = new BoxEncryption(seedView);
        const fromCopy = new BoxEncryption(seedCopy);
        const [sealed] = await fromView.encrypt([{ hello: 'world' }]);
        // The copy-seeded instance holds the SAME private key, so it opens it.
        expect(await fromCopy.decrypt([sealed])).toEqual([{ hello: 'world' }]);
        expect(await fromView.decrypt([sealed])).toEqual([{ hello: 'world' }]);
    });

    it('accepts a Buffer seed (pooled backing store)', async () => {
        const seed = Buffer.alloc(32, 3); // small Buffers share a pool
        const box = new BoxEncryption(seed);
        const [sealed] = await box.encrypt([{ n: 1 }]);
        expect(await box.decrypt([sealed])).toEqual([{ n: 1 }]);
    });
});
