import { describe, it, expect } from 'vitest';
import { splitJoySegments, hasJoyTags, joyImgMime } from './joyImg';

describe('splitJoySegments', () => {
    it('splits text around a tag on its own line', () => {
        const text = 'Here is the login page:\n\n<joy-img src="/u/.joy/sessions/ab/media/x.webp" width="854" height="480" alt="login" />\n\nLooks right to me.';
        const segs = splitJoySegments(text);
        expect(segs).toEqual([
            { kind: 'md', text: 'Here is the login page:\n\n' },
            { kind: 'img', src: '/u/.joy/sessions/ab/media/x.webp', width: 854, height: 480, alt: 'login' },
            { kind: 'md', text: '\n\nLooks right to me.' },
        ]);
    });

    it('handles multiple tags and attribute order/no-slash variants', () => {
        const segs = splitJoySegments('<joy-img width="10" src="/a.png" height="20"><joy-img src="/b.webp"/>');
        expect(segs).toEqual([
            { kind: 'img', src: '/a.png', width: 10, height: 20, alt: null },
            { kind: 'img', src: '/b.webp', width: null, height: null, alt: null },
        ]);
    });

    it('strips a malformed tag (no src) instead of rendering raw XML', () => {
        const segs = splitJoySegments('before <joy-img width="10" /> after');
        expect(segs).toEqual([
            { kind: 'md', text: 'before ' },
            { kind: 'md', text: ' after' },
        ]);
    });

    it('ignores non-positive or junk dimensions', () => {
        const segs = splitJoySegments('<joy-img src="/a.webp" width="0" height="nan" />');
        expect(segs[0]).toEqual({ kind: 'img', src: '/a.webp', width: null, height: null, alt: null });
    });

    it('plain text passes through as one md segment', () => {
        expect(splitJoySegments('no images here')).toEqual([{ kind: 'md', text: 'no images here' }]);
        expect(hasJoyTags('no images here')).toBe(false);
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

describe('joy-file segments', () => {
    it('parses a joy-file tag into a file segment between markdown', () => {
        const segs = splitJoySegments('see <joy-file path="/repo/src/app.ts" line="42" /> for the fix');
        expect(segs).toEqual([
            { kind: 'md', text: 'see ' },
            { kind: 'file', path: '/repo/src/app.ts', line: 42, name: null },
            { kind: 'md', text: ' for the fix' },
        ]);
    });

    it('strips a joy-file tag with no path, keeps optional name', () => {
        expect(splitJoySegments('x <joy-file line="3" /> y')).toEqual([
            { kind: 'md', text: 'x ' },
            { kind: 'md', text: ' y' },
        ]);
        expect(splitJoySegments('<joy-file path="a/b.py" name="the parser" />')).toEqual([
            { kind: 'file', path: 'a/b.py', line: null, name: 'the parser' },
        ]);
    });

    it('strips an unterminated streaming joy-file tail', () => {
        expect(splitJoySegments('done <joy-file path="/x')).toEqual([
            { kind: 'md', text: 'done ' },
        ]);
    });
});

describe('splitJoySegments — bounded tag scanning', () => {
    it('20k unfinished "<joy-img " fragments split in well under 100 ms and stay plain text', () => {
        const text = '<joy-img '.repeat(20_000);
        const t0 = performance.now();
        const segs = splitJoySegments(text);
        expect(performance.now() - t0).toBeLessThan(100);
        expect(segs.every(s => s.kind === 'md')).toBe(true);
        // Only the trailing (streaming) fragment is stripped; the rest is kept verbatim.
        expect(segs.map(s => (s as { text: string }).text).join('')).toBe('<joy-img '.repeat(19_999));
    });

    it('an unfinished tag followed by a complete one does not swallow the complete one', () => {
        const segs = splitJoySegments('<joy-img src="/a <joy-img src="/b.png" />');
        expect(segs.some(s => s.kind === 'img' && s.src === '/b.png')).toBe(true);
    });
});

describe('splitJoySegments — ">" inside quoted attributes (#435)', () => {
    it('a > inside a quoted path does not end the tag', () => {
        expect(splitJoySegments('<joy-file path="/tmp/a>b.txt" name="file" />')).toEqual([
            { kind: 'file', path: '/tmp/a>b.txt', line: null, name: 'file' },
        ]);
    });

    it('alt="1 > 0" keeps the rest of the tag out of the message', () => {
        expect(splitJoySegments('x <joy-img src="/a.png" alt="1 > 0" /> y')).toEqual([
            { kind: 'md', text: 'x ' },
            { kind: 'img', src: '/a.png', width: null, height: null, alt: '1 > 0' },
            { kind: 'md', text: ' y' },
        ]);
    });

    it('a tag whose quote never closes is not a tag; a later well-formed one still is', () => {
        expect(splitJoySegments('<joy-img src="/a.png alt="x"> oops <joy-img src="/b.png" />')).toEqual([
            { kind: 'md', text: '<joy-img src="/a.png alt="x"> oops ' },
            { kind: 'img', src: '/b.png', width: null, height: null, alt: null },
        ]);
    });
});

describe('splitJoySegments — tags inside code are documentation (#436)', () => {
    it('a fenced example keeps its tag and its fence intact', () => {
        const text = 'Use it like this:\n```html\n<joy-img src="/tmp/example.png" />\n```\nDone.';
        expect(splitJoySegments(text)).toEqual([{ kind: 'md', text }]);
    });

    it('an inline-code example is not a tag; a real tag after it still is', () => {
        const text = 'The `<joy-file path="x" />` tag. <joy-file path="/repo/a.ts" />';
        expect(splitJoySegments(text)).toEqual([
            { kind: 'md', text: 'The `<joy-file path="x" />` tag. ' },
            { kind: 'file', path: '/repo/a.ts', line: null, name: null },
        ]);
    });

    it('an unclosed fence (streaming) protects everything after it', () => {
        const text = 'Example:\n```\n<joy-img src="/a.png" />';
        expect(splitJoySegments(text)).toEqual([{ kind: 'md', text }]);
    });
});
