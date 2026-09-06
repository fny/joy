import { describe, it, expect } from 'vitest';
import { trimIdent } from './trimIdent';

describe('trimIdent', () => {
    it('drops leading/trailing blank lines and the common indentation', () => {
        expect(trimIdent('\n\n    a\n      b\n\n    c\n\n')).toBe('a\n  b\n\nc');
        expect(trimIdent('')).toBe('');
        expect(trimIdent('\n \n')).toBe('');
        expect(trimIdent('x')).toBe('x');
    });

    // #460: leading blank lines were removed with shift() one at a time —
    // quadratic — so 100k leading newlines (100 KB) blocked the app thread
    // for seconds before the indentation pass even began.
    it('a text with 100k leading blank lines trims in linear time', () => {
        const PERF_BUDGET_MS = Number(process.env.JOY_PERF_BUDGET_MS ?? 500);
        const text = '\n'.repeat(100_000) + '  content\n' + '\n'.repeat(100_000);
        const t0 = performance.now();
        expect(trimIdent(text)).toBe('content');
        expect(performance.now() - t0).toBeLessThan(PERF_BUDGET_MS);
    });
});
