/**
 * Round-trip + safety for the app's own v2 content codec (sources/sync/v2/
 * crypto.ts). Uses libsodium-wrappers under vitest (the react-native lib is
 * shimmed for tests the same way the AES web tests are).
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import _sodium from 'libsodium-wrappers';

// Point the codec's sodium import at the node-loadable wrappers build.
vi.mock('@/encryption/libsodium.lib', async () => {
    await _sodium.ready;
    return { default: _sodium };
});

let sealV2Content: typeof import('./crypto').sealV2Content;
let openV2Content: typeof import('./crypto').openV2Content;
beforeAll(async () => {
    await _sodium.ready;
    const mod = await import('./crypto');
    sealV2Content = mod.sealV2Content;
    openV2Content = mod.openV2Content;
});

describe('app v2 content codec', () => {
    it('seals and opens with a key', () => {
        const key = _sodium.randombytes_buf(32);
        const ct = sealV2Content('hello 世界', key);
        expect(ct.startsWith('v2e1:')).toBe(true);
        expect(openV2Content(ct, key)).toBe('hello 世界');
    });

    it('no key → plaintext envelope, readable by open with any/no key', () => {
        const ct = sealV2Content('plain', null);
        expect(ct.startsWith('v2e1:')).toBe(false);
        expect(openV2Content(ct, null)).toBe('plain');
    });

    it('sealed content REFUSES to open without the key (returns null, not plaintext)', () => {
        const key = _sodium.randombytes_buf(32);
        const ct = sealV2Content('secret', key);
        expect(openV2Content(ct, null)).toBeNull();
    });

    it('wrong key → null, never a throw', () => {
        const key = _sodium.randombytes_buf(32);
        const wrong = _sodium.randombytes_buf(32);
        expect(openV2Content(sealV2Content('x', key), wrong)).toBeNull();
    });

    it('foreign/garbage ciphertext → a marker, never a crash', () => {
        expect(openV2Content('not-our-format', null)).toContain('payload');
        expect(openV2Content(null, null)).toBeNull();
    });
});
