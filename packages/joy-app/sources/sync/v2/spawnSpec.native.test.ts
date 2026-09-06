/**
 * Spawn-spec envelope under the NATIVE libsodium argument contract (every
 * typed-array argument = its whole backing store — sodiumNativeContract):
 * the byte-ownership sweep after #305/#307. encodeSpawnSpec/openSpawnSpec
 * forwarded the caller's key view straight into sodium, so sealing with a
 * 32-byte view into a 40-byte buffer threw and opening returned null
 * (Astra, waveE8c sodium-extra).
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import _sodium from 'libsodium-wrappers';
import { createHmac } from 'node:crypto';

vi.mock('@/encryption/libsodium.lib', async () => {
    const s = (await import('libsodium-wrappers')).default;
    await s.ready;
    const { withNativeBufferContract } = await import('@/encryption/sodiumNativeContract.testutil');
    return { default: withNativeBufferContract(s) };
});
vi.mock('@/encryption/hmac_sha512', () => ({
    hmac_sha512: async (key: Uint8Array, data: Uint8Array) =>
        new Uint8Array(createHmac('sha512', Buffer.from(key)).update(Buffer.from(data)).digest()),
}));

let mod: typeof import('./spawnSpec');
beforeAll(async () => {
    await _sodium.ready;
    mod = await import('./spawnSpec');
});

const KEY = new Uint8Array(32).fill(1);
const spec = { cwd: '/x', agent: 'claude' };

function keyView(): Uint8Array {
    const parent = new Uint8Array(40);
    parent.set(KEY, 4);
    return parent.subarray(4, 36);
}

describe('sync/v2/spawnSpec under the native buffer contract', () => {
    it('seals and opens with a key that is an exact 32-byte view into a larger buffer', () => {
        const sealed = mod.encodeSpawnSpec(spec, keyView());
        expect(sealed.startsWith('v2e1:')).toBe(true);
        expect(mod.openSpawnSpec(sealed, KEY)?.cwd).toBe('/x');
        expect(mod.openSpawnSpec(sealed, keyView())?.cwd).toBe('/x');
    });

    it('opens an envelope sealed under the owned key with the view, and with a Buffer key', () => {
        const sealed = mod.encodeSpawnSpec(spec, KEY);
        expect(mod.openSpawnSpec(sealed, keyView())).toEqual({ v: 1, t: 'spawn', ...spec });
        const parent = new Uint8Array(40);
        parent.set(KEY, 4);
        expect(mod.openSpawnSpec(sealed, Buffer.from(parent.buffer, 4, 32))).toEqual({ v: 1, t: 'spawn', ...spec });
    });

    it('a derived key (view or not) round-trips end to end', async () => {
        const material = new Uint8Array(64).fill(7);
        const machineKeyView = material.subarray(0, 32);
        const key = await mod.deriveSpawnSpecKey(machineKeyView, 'm');
        const sealed = mod.encodeSpawnSpec(spec, key);
        expect(mod.openSpawnSpec(sealed, key)).toEqual({ v: 1, t: 'spawn', ...spec });
        expect(mod.openSpawnSpec(sealed, new Uint8Array(32).fill(9))).toBeNull();
    });
});
