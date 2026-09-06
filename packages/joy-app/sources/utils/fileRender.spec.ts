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

describe('parseDelimited — record boundaries', () => {
    it('a final quoted empty record is one empty field (#431)', () => {
        expect(parseDelimited('""', ',').rows).toEqual([['']]);
        expect(parseDelimited('header\n""', ',').rows).toEqual([['header'], ['']]);
        expect(parseDelimited('a\t""', '\t').rows).toEqual([['a', '']]);
    });

    it('a carriage return inside a quoted field is data (#432)', () => {
        expect(parseDelimited('a\n"carriage\r"\n', ',').rows).toEqual([['a'], ['carriage\r']]);
        expect(parseDelimited('a\r\n"x\r\ny"\r\n', ',').rows).toEqual([['a'], ['x\r\ny']]);
    });

    it('a complete table exactly at the row limit is not truncated (#433)', () => {
        expect(parseDelimited('one\ntwo\n', ',', 2)).toEqual({ rows: [['one'], ['two']], truncated: false });
        expect(parseDelimited('one\ntwo', ',', 2)).toEqual({ rows: [['one'], ['two']], truncated: false });
        expect(parseDelimited('one\ntwo\n\n', ',', 2).truncated).toBe(false);
        expect(parseDelimited('one\ntwo\nthree', ',', 2)).toEqual({ rows: [['one'], ['two']], truncated: true });
        expect(parseDelimited('one\ntwo\n"three"\n', ',', 2).truncated).toBe(true);
    });

    it('empty input has no rows', () => {
        expect(parseDelimited('', ',')).toEqual({ rows: [], truncated: false });
    });
});

describe('fileRenderKind — extensionless names (#422)', () => {
    it('a root file named "png" or "md" is not an image or markdown', () => {
        expect(fileRenderKind('png')).toBeNull();
        expect(fileRenderKind('dir/md')).toBeNull();
        expect(isRasterImagePath('png')).toBe(false);
        expect(imageDataUri('png', { base64: 'AAAA' })).toBeNull();
    });
});
