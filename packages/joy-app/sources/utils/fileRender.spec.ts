import { describe, it, expect } from 'vitest';
import { parseDelimited, fileRenderKind, imageDataUri, isRasterImagePath } from '../utils/fileRender';

describe('fileRenderKind', () => {
    it('classifies by extension', () => {
        expect(fileRenderKind('a/b/readme.md')).toBe('markdown');
        expect(fileRenderKind('index.HTML'.toLowerCase())).toBe('html');
        expect(fileRenderKind('data.csv')).toBe('csv');
        expect(fileRenderKind('data.tsv')).toBe('tsv');
        expect(fileRenderKind('pic.png')).toBe('image');
        expect(fileRenderKind('icon.svg')).toBe('image');
        expect(fileRenderKind('main.ts')).toBeNull();
    });
    it.each(['data.__proto__', 'data.constructor', 'x.toString', 'x.hasOwnProperty'])(
        'does not classify the prototype-named extension of %s as an image (#434)',
        (path) => {
            expect(fileRenderKind(path)).toBeNull();
            expect(isRasterImagePath(path)).toBe(false);
            expect(imageDataUri(path, { base64: 'AAAA' })).toBeNull();
        },
    );
});

describe('parseDelimited', () => {
    it('parses simple csv', () => {
        expect(parseDelimited('a,b\n1,2\n', ',').rows).toEqual([['a', 'b'], ['1', '2']]);
    });
    it('handles quoted cells with commas, escaped quotes, and newlines', () => {
        const { rows } = parseDelimited('name,note\n"Smith, John","said ""hi""\nthen left"\n', ',');
        expect(rows).toEqual([['name', 'note'], ['Smith, John', 'said "hi"\nthen left']]);
    });
    it('handles CRLF and tsv', () => {
        expect(parseDelimited('a\tb\r\n1\t2\r\n', '\t').rows).toEqual([['a', 'b'], ['1', '2']]);
    });
    it('truncates at the row cap', () => {
        const big = Array.from({ length: 600 }, (_, i) => `${i},x`).join('\n');
        const r = parseDelimited(big, ',');
        expect(r.truncated).toBe(true);
        expect(r.rows.length).toBe(500);
    });
});

describe('imageDataUri', () => {
    it('raster via base64, svg via utf8', () => {
        expect(imageDataUri('a.png', { base64: 'AAAA' })).toBe('data:image/png;base64,AAAA');
        expect(imageDataUri('a.svg', { utf8: '<svg/>' })).toContain('data:image/svg+xml');
        expect(imageDataUri('a.png', {})).toBeNull();
    });
});
