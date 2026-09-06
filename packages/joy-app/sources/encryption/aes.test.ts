import { describe, it, expect, vi } from 'vitest';
import { webcrypto } from 'node:crypto';

// Stand-in for rn-encryption's native AES-GCM: UTF-8 string in/out, base64
// key, base64 nonce(12)+ciphertext+tag(16) — the iOS AES.GCM.seal combined
// format. Failures reject, as the native promise does. The unit test must
// never load the real native module.
vi.mock('rn-encryption', () => {
    const b64 = (u: Uint8Array) => Buffer.from(u).toString('base64');
    const unb64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'));
    const key = async (k: string, usage: KeyUsage) =>
        webcrypto.subtle.importKey('raw', unb64(k), { name: 'AES-GCM' }, false, [usage]);
    return {
        encryptAsyncAES: async (data: string, key64: string) => {
            const iv = webcrypto.getRandomValues(new Uint8Array(12));
            const ct = new Uint8Array(await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv }, await key(key64, 'encrypt'), new TextEncoder().encode(data)));
            const out = new Uint8Array(12 + ct.length);
            out.set(iv); out.set(ct, 12);
            return b64(out);
        },
        decryptAsyncAES: async (data: string, key64: string) => {
            const bundle = unb64(data);
            const pt = await webcrypto.subtle.decrypt({ name: 'AES-GCM', iv: bundle.subarray(0, 12) }, await key(key64, 'decrypt'), bundle.subarray(12));
            return new TextDecoder().decode(pt);
        },
    };
});

import { decryptAESGCM, decryptAESGCMString, encryptAESGCM, encryptAESGCMString } from './aes';

const KEY = Buffer.from(new Uint8Array(32).map((_, i) => i)).toString('base64');

describe('aes (native wrapper) against a string-only AES-GCM bridge', () => {
    it('#302: leading/trailing whitespace in the plaintext survives decryption', async () => {
        const sealed = await encryptAESGCMString('  keep indentation\n', KEY);
        expect(await decryptAESGCMString(sealed, KEY)).toBe('  keep indentation\n');
    });

    it('#303: arbitrary bytes (invalid UTF-8) and a BOM round-trip exactly', async () => {
        for (const bytes of [[255, 128, 0, 65], [0xef, 0xbb, 0xbf, 0x41]]) {
            const sealed = await encryptAESGCM(new Uint8Array(bytes), KEY);
            expect(Array.from((await decryptAESGCM(sealed, KEY))!)).toEqual(bytes);
        }
    });

    it('#304: an authenticated empty plaintext decrypts to an empty Uint8Array, not null', async () => {
        const sealed = await encryptAESGCM(new Uint8Array(0), KEY);
        const opened = await decryptAESGCM(sealed, KEY);
        expect(opened).toBeInstanceOf(Uint8Array);
        expect(opened!.length).toBe(0);
        expect(await decryptAESGCMString(await encryptAESGCMString('', KEY), KEY)).toBe('');
    });

    it('a wrong key yields null (parity with aes.web) instead of throwing', async () => {
        const other = Buffer.from(new Uint8Array(32).fill(9)).toString('base64');
        const sealed = await encryptAESGCM(new Uint8Array([1, 2, 3]), KEY);
        expect(await decryptAESGCM(sealed, other)).toBeNull();
        expect(await decryptAESGCMString(await encryptAESGCMString('x', KEY), other)).toBeNull();
    });
});
