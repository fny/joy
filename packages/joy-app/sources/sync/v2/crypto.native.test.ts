/**
 * The v2 content codec under the NATIVE libsodium argument contract (every
 * typed-array argument = its whole backing store — sodiumNativeContract):
 * the byte-ownership sweep after #305/#307. The file's former local
 * `standalone` helper used `.slice()`, which a Buffer overrides to return
 * another VIEW of its pool, so a Buffer view [1,2] inside [9,1,2,9] sealed
 * all four bytes and an authentic ciphertext handed over as a Buffer failed
 * to open.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import _sodium from 'libsodium-wrappers';

vi.mock('@/encryption/libsodium.lib', async () => {
    const s = (await import('libsodium-wrappers')).default;
    await s.ready;
    const { withNativeBufferContract } = await import('@/encryption/sodiumNativeContract.testutil');
    return { default: withNativeBufferContract(s) };
});

let mod: typeof import('./crypto');
beforeAll(async () => {
    await _sodium.ready;
    mod = await import('./crypto');
});

const KEY = new Uint8Array(32).fill(1);

describe('sync/v2/crypto under the native buffer contract', () => {
    it('sealV2Bytes seals exactly the Buffer view, not its neighbours', () => {
        const data = Buffer.from(new Uint8Array([9, 1, 2, 9]).buffer, 1, 2);
        const sealed = mod.sealV2Bytes(data, KEY);
        expect(Array.from(mod.openV2Bytes(sealed, KEY)!)).toEqual([1, 2]);
    });

    it('openV2Bytes opens an authentic ciphertext supplied as a Buffer', () => {
        const sealed = mod.sealV2Bytes(new Uint8Array([1, 2, 3]), KEY);
        expect(Array.from(mod.openV2Bytes(Buffer.from(sealed), KEY)!)).toEqual([1, 2, 3]);
    });

    it('a key that is a view over larger key material still seals and opens', () => {
        const material = new Uint8Array(64).fill(7);
        const keyView = material.subarray(0, 32);
        const bufKey = Buffer.from(material.buffer, 32, 32);
        expect(mod.openV2Content(mod.sealV2Content('hi', keyView), keyView)).toBe('hi');
        expect(mod.openV2Content(mod.sealV2Content('hi', bufKey), bufKey)).toBe('hi');
        expect(Array.from(mod.openV2Bytes(mod.sealV2Bytes(new Uint8Array([5]), keyView), keyView)!)).toEqual([5]);
    });
});
