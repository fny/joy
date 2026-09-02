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
let openV2Message: typeof import('./crypto').openV2Message;
let openV2Payload: typeof import('./crypto').openV2Payload;
let sealV2Bytes: typeof import('./crypto').sealV2Bytes;
let openV2Bytes: typeof import('./crypto').openV2Bytes;
beforeAll(async () => {
    await _sodium.ready;
    const mod = await import('./crypto');
    sealV2Content = mod.sealV2Content;
    openV2Content = mod.openV2Content;
    openV2Message = mod.openV2Message;
    openV2Payload = mod.openV2Payload;
    sealV2Bytes = mod.sealV2Bytes;
    openV2Bytes = mod.openV2Bytes;
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

    it('attachment citations ride inside the sealed message', () => {
        const key = _sodium.randombytes_buf(32);
        const atts = [{ id: 'att-1', name: 'paste.png', size: 12, mime: 'image/png', width: 4, height: 3, thumbhash: 'abc' }];
        const ct = sealV2Content('look', key, atts);
        expect(openV2Message(ct, key)).toEqual({ text: 'look', attachments: atts });
        // text-only reads still work, and a message without attachments has none
        expect(openV2Content(ct, key)).toBe('look');
        expect(openV2Message(sealV2Content('bare', key), key)).toEqual({ text: 'bare', attachments: [] });
        // malformed entries are dropped, never thrown on
        expect(openV2Message(JSON.stringify({ v: 1, t: 'plain', text: 'x', attachments: [{ id: 1 }, { id: 'ok', name: 'n' }] }), null))
            .toEqual({ text: 'x', attachments: [{ id: 'ok', name: 'n', size: 0 }] });
    });

    it('attachment bytes round-trip under the session key and refuse the wrong one', () => {
        const key = _sodium.randombytes_buf(32);
        const bytes = _sodium.randombytes_buf(1000);
        const sealed = sealV2Bytes(bytes, key);
        expect(sealed.length).toBe(bytes.length + 24 + 16);
        expect(openV2Bytes(sealed, key)).toEqual(bytes);
        expect(openV2Bytes(sealed, _sodium.randombytes_buf(32))).toBeNull();
        expect(openV2Bytes(new Uint8Array(5), key)).toBeNull();
        // plaintext sessions pass bytes through untouched
        expect(sealV2Bytes(bytes, null)).toBe(bytes);
        expect(openV2Bytes(bytes, null)).toBe(bytes);
    });

    it('forwarded adapter records open as records, never as text', () => {
        const key = _sodium.randombytes_buf(32);
        const record = { role: 'session', content: { type: 'session', data: { id: 'e1', time: 5, role: 'agent', turn: 't', ev: { t: 'tool-call-start', call: 'c', name: 'Read', title: 'Read', description: '', args: {} } } }, meta: { sentFrom: 'joy' } };
        const json = JSON.stringify({ v: 1, t: 'record', record });
        const nonce = _sodium.randombytes_buf(24);
        const ct = 'v2e1:' + _sodium.to_base64(new Uint8Array([...nonce, ..._sodium.crypto_secretbox_easy(_sodium.from_string(json), nonce, key)]), _sodium.base64_variants.ORIGINAL);
        expect(openV2Payload(ct, key)).toEqual({ t: 'record', record });
        expect(openV2Message(ct, key)).toBeNull();
        expect(openV2Content(ct, key)).toBeNull();
        expect(openV2Payload(ct, null)).toBeNull();
        expect(openV2Payload(sealV2Content('plain', key), key)).toEqual({ t: 'plain', message: { text: 'plain', attachments: [] } });
        expect(openV2Payload(JSON.stringify({ v: 1, t: 'record', record: { role: 'session' } }), null)).toBeNull();
    });
});
