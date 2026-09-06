import { describe, it, expect } from 'vitest';
import { exceedsInputBudget, parseBudget, PARSE_INPUT_CAP, PARSE_ITERATION_CAP } from './parseBudget';

describe('parseBudget — bounded work for UI-thread parsers', () => {
    it('spend() succeeds until the budget is gone, then stays exhausted', () => {
        const b = parseBudget(3);
        expect(b.spend()).toBe(true);
        expect(b.spend()).toBe(true);
        expect(b.exhausted).toBe(false);
        expect(b.spend()).toBe(true);
        expect(b.exhausted).toBe(true);
        expect(b.spend()).toBe(false);
        expect(b.spend()).toBe(false); // does not recover
    });

    it('a multi-unit charge that overshoots fails and exhausts', () => {
        const b = parseBudget(5);
        expect(b.spend(4)).toBe(true);
        expect(b.spend(4)).toBe(false);
        expect(b.exhausted).toBe(true);
    });

    it('a zero or negative budget is exhausted from the start', () => {
        expect(parseBudget(0).spend()).toBe(false);
        expect(parseBudget(-10).exhausted).toBe(true);
    });

    it('defaults to the shared iteration cap', () => {
        expect(parseBudget().limit).toBe(PARSE_ITERATION_CAP);
    });

    it('exceedsInputBudget compares against the shared input cap by default', () => {
        expect(exceedsInputBudget('x'.repeat(PARSE_INPUT_CAP))).toBe(false);
        expect(exceedsInputBudget('x'.repeat(PARSE_INPUT_CAP + 1))).toBe(true);
        expect(exceedsInputBudget('abcd', 3)).toBe(true);
        expect(exceedsInputBudget('abc', 3)).toBe(false);
    });
});
