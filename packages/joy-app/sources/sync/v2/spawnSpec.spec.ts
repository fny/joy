/**
 * Spawn-spec envelope (#107): the plain form must stay byte-identical to what
 * current daemons parse, and the sealed form must be the same 'v2e1:'
 * secretbox layout as content/cards so the daemon half needs no new codec.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import _sodium from 'libsodium-wrappers';
import { createHmac } from 'node:crypto';

vi.mock('@/encryption/libsodium.lib', async () => { await _sodium.ready; return { default: _sodium }; });
vi.mock('@/encryption/hmac_sha512', () => ({
    hmac_sha512: async (key: Uint8Array, data: Uint8Array) =>
        new Uint8Array(createHmac('sha512', Buffer.from(key)).update(Buffer.from(data)).digest()),
}));

import { deriveSpawnSpecKey, encodeSpawnSpec, openSpawnSpec, SPAWN_SPEC_KEY_USAGE } from './spawnSpec';
import { deriveKey } from '@/encryption/deriveKey';

beforeAll(async () => { await _sodium.ready; });

const spec = { cwd: '/home/u/proj', agent: 'claude', model: 'opus', extraArgs: '--flag' };

describe('encodeSpawnSpec', () => {
    it('without a key is exactly the pre-#107 plain JSON the daemon parses today', () => {
        const wire = encodeSpawnSpec(spec, null);
        expect(wire).toBe(JSON.stringify({ v: 1, t: 'spawn', ...spec }));
        expect(JSON.parse(wire).t).toBe('spawn');
        expect(openSpawnSpec(wire, null)).toEqual({ v: 1, t: 'spawn', ...spec });
    });

    it('with a key seals to v2e1 and leaves nothing of the spec readable', () => {
        const key = _sodium.randombytes_buf(32);
        const wire = encodeSpawnSpec(spec, key);
        expect(wire.startsWith('v2e1:')).toBe(true);
        expect(wire).not.toContain('/home/u/proj');
        expect(wire).not.toContain('--flag');
        expect(openSpawnSpec(wire, key)).toEqual({ v: 1, t: 'spawn', ...spec });
    });

    it('sealed envelope refuses the wrong key, no key, and tampering', () => {
        const key = _sodium.randombytes_buf(32);
        const wire = encodeSpawnSpec(spec, key);
        expect(openSpawnSpec(wire, _sodium.randombytes_buf(32))).toBeNull();
        expect(openSpawnSpec(wire, null)).toBeNull();
        const raw = _sodium.from_base64(wire.slice(5), _sodium.base64_variants.ORIGINAL);
        raw[raw.length - 1] ^= 1;
        expect(openSpawnSpec('v2e1:' + _sodium.to_base64(raw, _sodium.base64_variants.ORIGINAL), key)).toBeNull();
        expect(openSpawnSpec('v2e1:AAAA', key)).toBeNull();
    });

    it('rejects a payload that is not a spawn spec', () => {
        expect(openSpawnSpec(JSON.stringify({ v: 1, t: 'plain', text: 'x' }), null)).toBeNull();
        expect(openSpawnSpec(JSON.stringify({ v: 1, t: 'spawn' }), null)).toBeNull();
        expect(openSpawnSpec('not json', null)).toBeNull();
        expect(openSpawnSpec(null, null)).toBeNull();
    });
});

describe('deriveSpawnSpecKey', () => {
    it('is the dedicated "Joy Spawn Spec" leaf, distinct from the tunnel key', async () => {
        const master = new Uint8Array(32).fill(7);
        const key = await deriveSpawnSpecKey(master, 'm1');
        expect(key).toEqual(await deriveKey(master, SPAWN_SPEC_KEY_USAGE, ['m1']));
        expect(key).not.toEqual(await deriveKey(master, 'Joy Tunnel', ['m1']));
        expect(key).not.toEqual(await deriveSpawnSpecKey(master, 'm2'));
        expect(key.length).toBe(32);
    });
});
