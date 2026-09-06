import { describe, it, expect } from 'vitest';
import { findCodeRanges, isInsideCode } from './codeRanges';

const slices = (text: string) => findCodeRanges(text).map(r => text.slice(r.start, r.end));

describe('findCodeRanges', () => {
    it('finds a fenced block from its opening line through its closing fence', () => {
        const text = 'before\n```html\n<x/>\n```\nafter';
        expect(slices(text)).toEqual(['```html\n<x/>\n```']);
    });

    it('a longer fence closes only on a run at least as long (#263)', () => {
        const text = '````\n```js\ninner\n```\n````\ntail';
        expect(slices(text)).toEqual(['````\n```js\ninner\n```\n````']);
    });

    it('an unclosed fence runs to the end of the text (streaming)', () => {
        const text = 'a\n```\nstill open';
        expect(slices(text)).toEqual(['```\nstill open']);
    });

    it('finds inline code, including double-backtick spans, and ignores an unclosed backtick', () => {
        const text = 'use `a` and ``b ` c`` but not ` this';
        expect(slices(text)).toEqual(['`a`', '``b ` c``']);
    });

    it('isInsideCode answers by index', () => {
        const text = 'x `y` z';
        const ranges = findCodeRanges(text);
        expect(isInsideCode(ranges, 0)).toBe(false);
        expect(isInsideCode(ranges, 3)).toBe(true);
        expect(isInsideCode(ranges, 5)).toBe(false);
    });

    it('is linear on pathological input', () => {
        const text = ('` '.repeat(5000) + '\n').repeat(4) + '```\n'.repeat(2000);
        const t0 = performance.now();
        findCodeRanges(text);
        expect(performance.now() - t0).toBeLessThan(100);
    });
});
