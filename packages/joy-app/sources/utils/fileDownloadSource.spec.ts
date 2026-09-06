import { describe, it, expect } from 'vitest';
import { pickDownloadPayload } from './fileDownloadSource';

describe('pickDownloadPayload (#164)', () => {
    it('downloads the original bytes, never the UTF-8 re-encoding of a lossy decode', () => {
        // "café" in Latin-1: 63 61 66 e9 → base64 "Y2Fm6Q=="
        const latin1 = 'Y2Fm6Q==';
        const decoded = new TextDecoder().decode(Uint8Array.from(atob(latin1), (c) => c.charCodeAt(0)));
        expect(decoded).toBe('caf�'); // what the viewer shows
        const payload = pickDownloadPayload({ imageBase64: null, rawBase64: latin1, isBinary: false, displayText: decoded, canRefetch: true });
        expect(payload).toEqual({ kind: 'base64', base64: latin1 });
    });

    it('re-reads the machine when only cached text is in memory', () => {
        expect(pickDownloadPayload({ imageBase64: null, rawBase64: null, isBinary: false, displayText: 'cached', canRefetch: true }))
            .toEqual({ kind: 'refetch' });
        expect(pickDownloadPayload({ imageBase64: null, rawBase64: null, isBinary: true, displayText: '', canRefetch: true }))
            .toEqual({ kind: 'refetch' });
    });

    it('an image downloads its own base64', () => {
        expect(pickDownloadPayload({ imageBase64: 'iVBOR', rawBase64: null, isBinary: true, displayText: null, canRefetch: true }))
            .toEqual({ kind: 'base64', base64: 'iVBOR' });
    });

    it('falls back to the displayed text only when there is nothing to re-read', () => {
        expect(pickDownloadPayload({ imageBase64: null, rawBase64: null, isBinary: false, displayText: 'x', canRefetch: false }))
            .toEqual({ kind: 'utf8', text: 'x' });
        expect(pickDownloadPayload({ imageBase64: null, rawBase64: null, isBinary: true, displayText: null, canRefetch: false }))
            .toEqual({ kind: 'base64', base64: '' });
    });
});
