import { describe, it, expect } from 'vitest';
import { parseToken } from './parseToken';
import { encodeBase64 } from '@/encryption/base64';
import { encodeUTF8 } from '@/encryption/text';

function segment(obj: unknown): string {
    return encodeBase64(encodeUTF8(JSON.stringify(obj)), 'base64url');
}

/** A payload whose base64url form contains the URL-safe characters, which
 *  standard-base64 atob rejects. In ASCII text only the 4th char of a
 *  base64 quantum can be 62/63 — a byte 0x3E ('>') or 0x3F ('?') in the
 *  third position of a triple — so three '?' in a row guarantee a hit. */
function urlSafePayload(): { payload: string; hasDash: boolean; hasUnderscore: boolean } {
    const payload = segment({ sub: 'user-123', name: '???' });
    return { payload, hasDash: payload.includes('-'), hasUnderscore: payload.includes('_') };
}

describe('parseToken', () => {
    const header = segment({ alg: 'EdDSA', typ: 'JWT' });

    it('accepts base64url payloads containing - or _ (#439)', () => {
        const { payload, hasDash, hasUnderscore } = urlSafePayload();
        expect(hasDash || hasUnderscore).toBe(true);
        expect(parseToken(`${header}.${payload}.sig`)).toBe('user-123');
    });

    it('accepts an unpadded payload (JWT segments carry no =)', () => {
        const payload = segment({ sub: 'abc' });
        expect(payload.endsWith('=')).toBe(false);
        expect(parseToken(`${header}.${payload}.sig`)).toBe('abc');
    });

    it('rejects a token without a string sub', () => {
        expect(() => parseToken(`${header}.${segment({ sub: 42 })}.sig`)).toThrow(/sub claim/);
    });

    it('rejects a malformed token shape', () => {
        expect(() => parseToken('a.b')).toThrow(/Invalid token format/);
        expect(() => parseToken(`${header}..sig`)).toThrow(/Invalid token format/);
    });

    it('reports an undecodable payload as invalid instead of leaking atob errors', () => {
        expect(() => parseToken(`${header}.%%%.sig`)).toThrow(/Invalid token/);
    });
});
