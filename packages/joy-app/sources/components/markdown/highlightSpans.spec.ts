import { describe, it, expect } from 'vitest';
import { highlightSpans } from './highlightSpans';
import type { MarkdownSpan } from './parseMarkdown';

const span = (text: string, styles: MarkdownSpan['styles'] = [], url: string | null = null): MarkdownSpan =>
    ({ text, styles, url });

describe('highlightSpans', () => {
    it('returns the spans untouched without a query', () => {
        const spans = [span('hello world')];
        expect(highlightSpans(spans, undefined)).toBe(spans);
        expect(highlightSpans(spans, '   ')).toBe(spans);
    });

    it('splits a hit out of its span and marks only that part', () => {
        const out = highlightSpans([span('the queue is wedged')], 'queue');
        expect(out.map((s) => [s.text, s.highlighted ?? false])).toEqual([
            ['the ', false],
            ['queue', true],
            [' is wedged', false],
        ]);
    });

    it('marks every occurrence, not just the first', () => {
        const out = highlightSpans([span('queue, then queue again')], 'queue');
        expect(out.filter((s) => s.highlighted).length).toBe(2);
    });

    it('matches case-insensitively but preserves the original casing', () => {
        const out = highlightSpans([span('The Queue')], 'queue');
        expect(out.find((s) => s.highlighted)?.text).toBe('Queue');
    });

    it('keeps the styling of the span it split', () => {
        const out = highlightSpans([span('a queue here', ['bold'], 'http://x')], 'queue');
        for (const s of out) {
            expect(s.styles).toEqual(['bold']);
            expect(s.url).toBe('http://x');
        }
    });

    it('marks a hit that sits in a styled run among plain ones', () => {
        const out = highlightSpans([span('run the '), span('queue', ['code']), span(' now')], 'queue');
        const hit = out.find((s) => s.highlighted);
        expect(hit?.text).toBe('queue');
        expect(hit?.styles).toEqual(['code']);
    });

    it('leaves a hit straddling a span boundary unmarked rather than mangling it', () => {
        // "queue" is split across two runs by formatting; neither run contains
        // it, so neither is marked. The row still scrolls into view.
        const out = highlightSpans([span('qu'), span('eue', ['bold'])], 'queue');
        expect(out.some((s) => s.highlighted)).toBe(false);
        expect(out.map((s) => s.text).join('')).toBe('queue');
    });

    it('does not drop or duplicate text', () => {
        const out = highlightSpans([span('aXbXc')], 'x');
        expect(out.map((s) => s.text).join('')).toBe('aXbXc');
    });

    it('handles a hit at the very start and very end', () => {
        expect(highlightSpans([span('xyz')], 'xyz').map((s) => s.highlighted)).toEqual([true]);
        expect(highlightSpans([span('abcxyz')], 'xyz').map((s) => s.text)).toEqual(['abc', 'xyz']);
    });
});
