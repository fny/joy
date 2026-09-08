import { describe, it, expect } from 'vitest';
import { tightestLimit, limitWindowName, limitResetLabel } from '@/utils/limitsFormat';
import type { LimitRow } from '@/utils/limitsFormat';

const row = (o: Partial<LimitRow>): LimitRow => ({ id: 'r', usedPercent: 0, ...o });

describe('tightestLimit', () => {
    it('picks the window closest to running out', () => {
        const rows = [row({ id: 'week', usedPercent: 40 }), row({ id: '5h', usedPercent: 91 })];
        expect(tightestLimit(rows)?.id).toBe('5h');
    });

    it('breaks ties toward the shorter window — it bites sooner', () => {
        const rows = [
            row({ id: 'week', usedPercent: 90, windowMinutes: 10_080 }),
            row({ id: '5h', usedPercent: 90, windowMinutes: 300 }),
        ];
        expect(tightestLimit(rows)?.id).toBe('5h');
    });

    it('is null when there is nothing to report', () => {
        expect(tightestLimit([])).toBeNull();
        expect(tightestLimit(undefined)).toBeNull();
    });
});

describe('limitWindowName', () => {
    it('names windows by duration', () => {
        expect(limitWindowName(row({ windowMinutes: 300 }))).toBe('5-hour window');
        expect(limitWindowName(row({ windowMinutes: 10_080 }))).toBe('Weekly window');
        expect(limitWindowName(row({ windowMinutes: 43_200 }))).toBe('30-day window');
    });

    it('marks a model-scoped row as that model, not the account', () => {
        expect(limitWindowName(row({ windowMinutes: 10_080, scope: 'Fable' }))).toBe('Fable · Weekly window');
        expect(limitWindowName(row({ windowMinutes: 300, scope: 'account' }))).toBe('5-hour window');
    });

    it('falls back to the row id when the window is unlabelled', () => {
        expect(limitWindowName(row({ id: 'odd_window' }))).toBe('odd_window');
    });
});

describe('limitResetLabel', () => {
    it('accepts ISO strings and unix seconds alike', () => {
        const inTwoHours = Date.now() + 2 * 3600_000;
        expect(limitResetLabel(new Date(inTwoHours).toISOString())).toMatch(/^resets in 2h/);
        expect(limitResetLabel(Math.floor(inTwoHours / 1000))).toMatch(/^resets in 2h/);
    });

    it('never prints 60 minutes — the hour rolls over', () => {
        // 1h 59m 45s: flooring hours and rounding the remainder separately gave
        // "1h 60m" here, which the limits page has always been able to show.
        expect(limitResetLabel(Date.now() + 3600_000 + 59 * 60_000 + 45_000)).toBe('resets in 2h 0m');
    });

    it('handles past, missing and unparseable times without throwing', () => {
        expect(limitResetLabel(Date.now() - 1000)).toBe('resets soon');
        expect(limitResetLabel(null)).toBeNull();
        expect(limitResetLabel(undefined)).toBeNull();
        expect(limitResetLabel('not a date')).toBeNull();
    });
});
