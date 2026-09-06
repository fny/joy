// Wall-clock bound: generous because the CI/dev box runs several suites at once; the point is linear vs quadratic, not 100 ms exactly.
const PERF_BUDGET_MS = Number(process.env.JOY_PERF_BUDGET_MS ?? 500);
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
        expect(performance.now() - t0).toBeLessThan(PERF_BUDGET_MS);
    });
});

import { replaceOutsideCode } from './codeRanges';

describe('findCodeRanges — closing fence whitespace (#436 residual)', () => {
    it('a closing fence followed by a CR or trailing spaces still closes the block', () => {
        for (const close of ['```\r', '```  ', '```\t \r']) {
            const text = '```xml\n<x/>\n' + close + '\nafter';
            expect(slices(text)).toEqual(['```xml\n<x/>\n' + close]);
        }
    });

    it('a closing fence with other trailing text is content, as in the block parser', () => {
        expect(slices('```\ninner\n``` x\n```\nout')).toEqual(['```\ninner\n``` x\n```']);
    });
});

describe('findCodeRanges — bounded inline scan', () => {
    it('one line of successively longer backtick runs is linear', () => {
        const text = 'prefix ' + Array.from({ length: 1200 }, (_, i) => '`'.repeat(i + 1)).join(' ');
        expect(text.length).toBeGreaterThan(700_000);
        const t0 = performance.now();
        expect(findCodeRanges(text)).toEqual([]);
        expect(performance.now() - t0).toBeLessThan(PERF_BUDGET_MS);
    });

    it('pairs each opener with the next run of equal length, skipping other lengths', () => {
        expect(slices('` `` ` ``` `` x')).toEqual(['` `` `']);
        expect(slices('`` ` `` ``` x ``` `y`')).toEqual(['`` ` ``', '``` x ```', '`y`']);
    });
});

describe('replaceOutsideCode', () => {
    it('rewrites matches outside code and leaves quoted ones alone', () => {
        const out = replaceOutsideCode('a <t>1</t> `<t>2</t>` b\n```\n<t>3</t>\n```\n<t>4</t>', /<t>(\d)<\/t>/g, m => `[${m[1]}]`);
        expect(out).toBe('a [1] `<t>2</t>` b\n```\n<t>3</t>\n```\n[4]');
    });

    it('returns the input untouched when nothing matches', () => {
        const text = 'no tags `here`';
        expect(replaceOutsideCode(text, /<t>/g, () => 'x')).toBe(text);
    });
});
