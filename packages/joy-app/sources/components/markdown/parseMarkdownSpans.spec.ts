import { describe, it, expect } from 'vitest';
import { parseMarkdownSpans } from './parseMarkdownSpans';
import { PARSE_INPUT_CAP } from '@/utils/parseBudget';

const text = (md: string) => parseMarkdownSpans(md, false).map(s => s.text).join('');

describe('parseMarkdownSpans — bounded bracket matching', () => {
    it('50k unclosed "[" parse in well under 100 ms and come back as plain text', () => {
        const md = '['.repeat(50_000);
        const t0 = performance.now();
        const spans = parseMarkdownSpans(md, false);
        expect(performance.now() - t0).toBeLessThan(100);
        expect(spans.map(s => s.text).join('')).toBe(md);
        expect(spans.every(s => s.url === null)).toBe(true);
    });

    it('20k "[x](" fragments (unclosed URL part) are linear too', () => {
        const md = '[x]('.repeat(20_000);
        const t0 = performance.now();
        expect(text(md)).toBe(md);
        expect(performance.now() - t0).toBeLessThan(100);
    });

    it('still parses ordinary links, links with one level of parentheses, and nested links', () => {
        expect(parseMarkdownSpans('see [docs](https://x.y/z) now', false)).toEqual([
            { styles: [], text: 'see ', url: null },
            { styles: [], text: 'docs', url: 'https://x.y/z' },
            { styles: [], text: ' now', url: null },
        ]);
        expect(parseMarkdownSpans('[wiki](https://en.wikipedia.org/wiki/Foo_(bar))', false)).toEqual([
            { styles: [], text: 'wiki', url: 'https://en.wikipedia.org/wiki/Foo_(bar)' },
        ]);
        expect(parseMarkdownSpans('**[ENG-1](https://linear.app/e/1)**', false)).toEqual([
            { styles: ['bold'], text: 'ENG-1', url: 'https://linear.app/e/1' },
        ]);
    });

    it('an incomplete link keeps its brackets as plain text', () => {
        expect(parseMarkdownSpans('a [b] c', false)).toEqual([
            { styles: [], text: 'a ', url: null },
            { styles: [], text: '[b]', url: null },
            { styles: [], text: ' c', url: null },
        ]);
    });

    it('past the input cap the paragraph is one plain span', () => {
        const md = '**b** '.repeat(Math.ceil((PARSE_INPUT_CAP + 1) / 6));
        expect(parseMarkdownSpans(md, false)).toEqual([{ styles: [], text: md, url: null }]);
    });
});

describe('parseMarkdownSpans — parentheses in link destinations (#266)', () => {
    const wiki = 'https://en.wikipedia.org/wiki/Function_(mathematics)';

    it('an explicit link keeps its balanced parenthesis', () => {
        expect(parseMarkdownSpans(`[page](${wiki})`, false)).toEqual([{ styles: [], text: 'page', url: wiki }]);
    });

    it('inside bold too', () => {
        expect(parseMarkdownSpans(`**[page](${wiki})**`, false)).toEqual([{ styles: ['bold'], text: 'page', url: wiki }]);
    });

    it('a bare URL keeps a matched closing parenthesis and sheds an unmatched one', () => {
        expect(parseMarkdownSpans(`see ${wiki}.`, false)).toEqual([
            { styles: [], text: 'see ', url: null },
            { styles: [], text: wiki, url: wiki },
            { styles: [], text: '.', url: null },
        ]);
        expect(parseMarkdownSpans(`(see ${wiki})`, false)).toEqual([
            { styles: [], text: '(see ', url: null },
            { styles: [], text: wiki, url: wiki },
            { styles: [], text: ')', url: null },
        ]);
        expect(parseMarkdownSpans('(https://example.com)', false)).toEqual([
            { styles: [], text: '(', url: null },
            { styles: [], text: 'https://example.com', url: 'https://example.com' },
            { styles: [], text: ')', url: null },
        ]);
    });

    it('escaped parentheses in a destination are unescaped', () => {
        expect(parseMarkdownSpans('[x](https://a/b\\(c\\))', false)).toEqual([{ styles: [], text: 'x', url: 'https://a/b(c)' }]);
    });
});
