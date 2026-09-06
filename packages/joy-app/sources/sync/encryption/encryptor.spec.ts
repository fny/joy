import { describe, it, expect, beforeAll, vi } from 'vitest';
import _sodium from 'libsodium-wrappers';
import { webcrypto } from 'node:crypto';

// Point the sodium import at the node-loadable wrappers build (as
// sync/v2/crypto.test.ts does) and give expo-crypto a node RNG.
vi.mock('@/encryption/libsodium.lib', async () => {
    await _sodium.ready;
    return { default: _sodium };
});
// AES256Encryption's native backend is not needed for the box test.
vi.mock('rn-encryption', () => ({}));
vi.mock('expo-crypto', () => ({
    getRandomBytes: (n: number) => webcrypto.getRandomValues(new Uint8Array(n)),
    randomUUID: () => webcrypto.randomUUID(),
}));

import { BoxEncryption } from './encryptor';
import { encryptBox } from '@/encryption/libsodium';

describe('BoxEncryption.decrypt — one bad plaintext does not reject the batch (#352)', () => {
    beforeAll(async () => { await _sodium.ready; });

    it('returns null for the non-JSON item and keeps the valid items in place', async () => {
        const seed = new Uint8Array(32).fill(7);
        const box = new BoxEncryption(seed);
        const publicKey = _sodium.crypto_box_seed_keypair(seed).publicKey;

        const [good1, good2] = await box.encrypt([{ a: 1 }, { b: 2 }]);
        // Anyone holding the recipient public key can seal arbitrary bytes.
        const bad = encryptBox(new TextEncoder().encode('not JSON'), publicKey);
        const garbage = new Uint8Array(10); // not even a valid box

        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const out = await box.decrypt([good1, bad, good2, garbage]);
        warn.mockRestore();

        expect(out).toEqual([{ a: 1 }, null, { b: 2 }, null]);
    });
});
