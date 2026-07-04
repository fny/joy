import { describe, it, expect } from 'vitest';
import { splitJoyImgSegments, hasJoyImg, joyImgMime } from './joyImg';

describe('splitJoyImgSegments', () => {
    it('splits text around a tag on its own line', () => {
        const text = 'Here is the login page:\n\n<joy-img src="/u/.joy/sessions/ab/media/x.webp" width="854" height="480" alt="login" />\n\nLooks right to me.';
        const segs = splitJoyImgSegments(text);
        expect(segs).toEqual([
            { kind: 'md', text: 'Here is the login page:\n\n' },
            { kind: 'img', src: '/u/.joy/sessions/ab/media/x.webp', width: 854, height: 480, alt: 'login' },
            { kind: 'md', text: '\n\nLooks right to me.' },
        ]);
    });

    it('handles multiple tags and attribute order/no-slash variants', () => {
        const segs = splitJoyImgSegments('<joy-img width="10" src="/a.png" height="20"><joy-img src="/b.webp"/>');
        expect(segs).toEqual([
            { kind: 'img', src: '/a.png', width: 10, height: 20, alt: null },
            { kind: 'img', src: '/b.webp', width: null, height: null, alt: null },
        ]);
    });

    it('strips a malformed tag (no src) instead of rendering raw XML', () => {
        const segs = splitJoyImgSegments('before <joy-img width="10" /> after');
        expect(segs).toEqual([
            { kind: 'md', text: 'before ' },
            { kind: 'md', text: ' after' },
        ]);
    });

    it('ignores non-positive or junk dimensions', () => {
        const segs = splitJoyImgSegments('<joy-img src="/a.webp" width="0" height="nan" />');
        expect(segs[0]).toEqual({ kind: 'img', src: '/a.webp', width: null, height: null, alt: null });
    });

    it('plain text passes through as one md segment', () => {
        expect(splitJoyImgSegments('no images here')).toEqual([{ kind: 'md', text: 'no images here' }]);
        expect(hasJoyImg('no images here')).toBe(false);
    });
});

describe('joyImgMime', () => {
    it('maps extensions, defaults to webp', () => {
        expect(joyImgMime('/a/b.PNG')).toBe('image/png');
        expect(joyImgMime('x.jpeg')).toBe('image/jpeg');
        expect(joyImgMime('x.jpg')).toBe('image/jpeg');
        expect(joyImgMime('x.webp')).toBe('image/webp');
        expect(joyImgMime('noext')).toBe('image/webp');
    });
});
