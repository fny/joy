// The file viewer's `?path=` parameter. `btoa(path)` threw InvalidCharacterError
// for any code point above U+00FF (résumé.md, a CJK folder, an emoji) — a dead
// tap on web and an uncaught exception on native (#16). Encode UTF-8 bytes as
// base64url; decode accepts the old plain-base64 links too.
import { encodeBase64, decodeBase64 } from '@/encryption/base64';

export function encodePathParam(path: string): string {
    return encodeBase64(new TextEncoder().encode(path), 'base64url');
}

export function decodePathParam(encoded: string): string {
    if (!encoded) return '';
    try {
        // fatal: a legacy btoa('résumé.md') link must fail here and reach the
        // atob fallback instead of decoding to "r�sum�.md".
        return new TextDecoder('utf-8', { fatal: true }).decode(decodeBase64(encoded, 'base64url'));
    } catch {
        try { return atob(encoded); } catch { return ''; }
    }
}
