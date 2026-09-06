import { describe, expect, it } from 'vitest';
import { serializeForLogs, truncateForLogs } from './truncateForLogs';

const long = 'x'.repeat(7000);

describe('truncateForLogs', () => {
    it('keeps short strings and truncates long ones around a marker', () => {
        expect(truncateForLogs('hello', 10)).toBe('hello');
        const out = truncateForLogs(long, 100) as string;
        expect(out.length).toBeLessThan(200);
        expect(out).toContain('[... TRUNCATED FOR LOGS]');
        expect(out.startsWith('x'.repeat(40))).toBe(true);
        expect(out.endsWith('x'.repeat(30))).toBe(true);
    });

    // #461: limits 0..3 gave suffixLen 0, and slice(-0) copied the WHOLE string.
    it('never retains the untruncated string for tiny limits (#461)', () => {
        for (const limit of [0, 1, 2, 3]) {
            const out = truncateForLogs(long, limit) as string;
            expect(out.length).toBeLessThan(40);
            expect(out).toContain('[... TRUNCATED FOR LOGS]');
        }
        expect((serializeForLogs(long, 1)).length).toBeLessThan(40);
        const nested = truncateForLogs({ a: [long] }, 2) as { a: string[] };
        expect(nested.a[0].length).toBeLessThan(40);
    });

    it('validates the limit before slicing', () => {
        expect((truncateForLogs(long, -5) as string).length).toBeLessThan(40);
        expect((truncateForLogs(long, Number.NaN) as string).length).toBeLessThan(40);
        expect((truncateForLogs(long, 10.9) as string).startsWith('xxxx [')).toBe(true);
    });
});
