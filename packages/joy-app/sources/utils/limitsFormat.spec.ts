import { describe, it, expect } from 'vitest';
import { tightestLimit, limitWindowName, limitResetLabel, relevantLimitRows } from '@/utils/limitsFormat';
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

    it('an unlabelled scoped row is its key alone — the key already names the model', () => {
        expect(limitWindowName(row({ id: 'weekly_scoped:fable', scope: 'Fable' }))).toBe('weekly_scoped:fable');
        expect(limitWindowName(row({ id: 'seven_day_opus', scope: 'Opus' }))).toBe('seven_day_opus');
    });
});

describe('relevantLimitRows', () => {
    const shared5h = row({ id: 'five_hour', usedPercent: 15 });
    const sharedWeek = row({ id: 'seven_day', usedPercent: 81 });
    const fable = row({ id: 'weekly_scoped:fable', usedPercent: 96, scope: 'Fable' });
    const opus = row({ id: 'seven_day_opus', usedPercent: 40, scope: 'Opus' });
    const sonnet = row({ id: 'seven_day_sonnet', usedPercent: 99, scope: 'Sonnet' });
    const all = [shared5h, sharedWeek, fable, opus, sonnet];

    it('keeps the shared windows and only the selected model\'s scoped window', () => {
        expect(relevantLimitRows(all, 'opus').map((r) => r.id)).toEqual(['five_hour', 'seven_day', 'seven_day_opus']);
        expect(relevantLimitRows(all, 'fable').map((r) => r.id)).toEqual(['five_hour', 'seven_day', 'weekly_scoped:fable']);
    });

    it('so the % left is this model\'s, not another model\'s worst window', () => {
        expect(tightestLimit(relevantLimitRows(all, 'opus'))?.id).toBe('seven_day');      // 81%, not Sonnet's 99%
        expect(tightestLimit(relevantLimitRows(all, 'fable'))?.id).toBe('weekly_scoped:fable');
        expect(tightestLimit(all)?.id).toBe('seven_day_sonnet');                          // what it used to show for everyone
    });

    it('a model with no scoped window is governed by the shared ones', () => {
        expect(relevantLimitRows(all, 'haiku').map((r) => r.id)).toEqual(['five_hour', 'seven_day']);
    });

    it('no model known: everything counts', () => {
        expect(relevantLimitRows(all, null)).toEqual(all);
        expect(relevantLimitRows(all, '')).toEqual(all);
        expect(relevantLimitRows(undefined, 'fable')).toEqual([]);
    });

    it('matching is case-insensitive and tolerates multi-word scopes', () => {
        const fable51 = row({ id: 'weekly_scoped:fable-5-1', usedPercent: 50, scope: 'Fable 5.1' });
        expect(relevantLimitRows([shared5h, fable51, opus], 'fable').map((r) => r.id)).toEqual(['five_hour', 'weekly_scoped:fable-5-1']);
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
