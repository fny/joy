import { describe, it, expect, vi } from 'vitest';
import { SessionEncryption } from './sessionEncryption';
import { EncryptionCache } from './encryptionCache';
import type { Decryptor, Encryptor } from './encryptor';
import type { ApiMessage } from '../apiTypes';

// A decryptor that "opens" a ciphertext by decoding it as UTF-8 JSON, or
// returns null for anything it cannot parse — stands in for sodium.
function fakeEncryptor(opts: { failAll?: boolean } = {}): Encryptor & Decryptor & { calls: number } {
    const dec = new TextDecoder();
    return {
        calls: 0,
        async encrypt(data: unknown[]) { return data.map(d => new TextEncoder().encode(JSON.stringify(d))); },
        async decrypt(data: Uint8Array[]) {
            this.calls++;
            return data.map(item => {
                if (opts.failAll) return null;
                try { return JSON.parse(dec.decode(item)); } catch { return null; }
            });
        },
    };
}

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
const encryptedRow = (id: string, c: string): ApiMessage => ({
    id, seq: 1, localId: null, createdAt: 1, updatedAt: 1,
    content: { t: 'encrypted', c },
} as unknown as ApiMessage);

describe('SessionEncryption.decryptMessages — isolate the bad record', () => {
    it('one malformed base64 row does not prevent the rest of the page from decrypting (#355)', async () => {
        const enc = fakeEncryptor();
        const se = new SessionEncryption('s1', enc, new EncryptionCache());
        const out = await se.decryptMessages([
            encryptedRow('m1', b64('{"role":"user","content":{"type":"text","text":"hi"}}')),
            encryptedRow('m2', '%%%'),
            encryptedRow('m3', b64('{"role":"agent"}')),
        ]);
        expect(out[0]?.content).toEqual({ role: 'user', content: { type: 'text', text: 'hi' } });
        expect(out[1]?.content).toBeNull();
        expect(out[2]?.content).toEqual({ role: 'agent' });
        expect(enc.calls).toBe(1); // the valid rows still reached the decryptor
    });

    it('a failed decryption is not cached, so a repaired key makes the message readable (#356)', async () => {
        const cache = new EncryptionCache();
        const broken = new SessionEncryption('s1', fakeEncryptor({ failAll: true }), cache);
        const row = encryptedRow('m1', b64('{"ok":true}'));
        expect((await broken.decryptMessages([row]))[0]?.content).toBeNull();

        // Session encryption recreated with the correct key, SAME shared cache.
        const repaired = new SessionEncryption('s1', fakeEncryptor(), cache);
        expect((await repaired.decryptMessages([row]))[0]?.content).toEqual({ ok: true });
    });

    it('a successful decryption IS cached and reused', async () => {
        const enc = fakeEncryptor();
        const se = new SessionEncryption('s1', enc, new EncryptionCache());
        const row = encryptedRow('m1', b64('{"n":1}'));
        await se.decryptMessages([row]);
        await se.decryptMessages([row]);
        expect(enc.calls).toBe(1);
    });

    it('a v2 pre-unsealed row replaces an earlier failed placeholder', async () => {
        const cache = new EncryptionCache();
        const broken = new SessionEncryption('s1', fakeEncryptor({ failAll: true }), cache);
        const row = encryptedRow('m1', b64('{"x":1}'));
        await broken.decryptMessages([row]);
        const plainRow = { ...row, __v2Plain: { x: 1 } } as unknown as ApiMessage;
        const se = new SessionEncryption('s1', fakeEncryptor(), cache);
        expect((await se.decryptMessages([plainRow]))[0]?.content).toEqual({ x: 1 });
    });

    it('a retired instance no longer writes to the shared cache (#351)', async () => {
        const cache = new EncryptionCache();
        const se = new SessionEncryption('s1', fakeEncryptor(), cache);
        se.retire();
        await se.decryptMessages([encryptedRow('m9', b64('{"late":true}'))]);
        expect(cache.getCachedMessage('m9')).toBeNull();
    });

    it('malformed metadata base64 is a failed open, not a thrown page', async () => {
        const se = new SessionEncryption('s1', fakeEncryptor(), new EncryptionCache());
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        await expect(se.decryptMetadata(1, '%%%')).resolves.toBeNull();
        warn.mockRestore();
    });
});
