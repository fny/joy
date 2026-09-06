/**
 * Card opener under the NATIVE libsodium argument contract (every typed-array
 * argument = its whole backing store — sodiumNativeContract): the byte-
 * ownership sweep after #305/#307. openCard forwarded the caller's key view
 * and `.slice()`d the envelope straight into sodium, so a valid card opened
 * with an owned 32-byte key but failed with an equal 32-byte view into a
 * larger buffer (Astra, waveE8c sodium-extra).
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import _sodium from 'libsodium-wrappers';

vi.mock('@/encryption/libsodium.lib', async () => {
    const s = (await import('libsodium-wrappers')).default;
    await s.ready;
    const { withNativeBufferContract } = await import('@/encryption/sodiumNativeContract.testutil');
    return { default: withNativeBufferContract(s) };
});

let mod: typeof import('./card');
beforeAll(async () => {
    await _sodium.ready;
    mod = await import('./card');
});

const KEY = new Uint8Array(32).fill(1);

// The daemon's sealer (nucleusLane.sealCard): nonce24 ‖ secretbox(json).
function sealCard(metadata: Record<string, unknown>, key: Uint8Array): string {
    const nonce = new Uint8Array(24).fill(2);
    const ct = _sodium.crypto_secretbox_easy(new TextEncoder().encode(JSON.stringify({ v: 1, t: 'card', metadata })), nonce, key);
    const raw = new Uint8Array(24 + ct.length);
    raw.set(nonce); raw.set(ct, 24);
    return 'v2e1:' + _sodium.to_base64(raw, _sodium.base64_variants.ORIGINAL);
}

describe('sync/v2/card under the native buffer contract', () => {
    it('opens with a key that is an exact 32-byte view into a larger buffer', () => {
        const wire = sealCard({ id: 'A' }, KEY);
        const parent = new Uint8Array(40);
        parent.set(KEY, 4);
        const view = parent.subarray(4, 36);
        expect(mod.openCard(wire, KEY)).toEqual({ id: 'A' });
        expect(mod.openCard(wire, view)).toEqual({ id: 'A' });
        expect(mod.openCard(wire, Buffer.from(parent.buffer, 4, 32))).toEqual({ id: 'A' });
    });

    it('openCardDebug reaches the parsed stage with the same key view', () => {
        const wire = sealCard({ id: 'A', cwd: '/x' }, KEY);
        const parent = new Uint8Array(40);
        parent.set(KEY, 4);
        expect(mod.openCardDebug(wire, parent.subarray(4, 36))).toMatchObject({ stage: 'parsed', t: 'card', keys: 2 });
    });

    it('still refuses the wrong key (the copy is exact, not permissive)', () => {
        const wire = sealCard({ id: 'A' }, KEY);
        expect(mod.openCard(wire, new Uint8Array(32).fill(9))).toBeNull();
    });
});
