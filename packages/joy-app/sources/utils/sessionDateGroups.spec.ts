// Runs under a DST-observing zone so the 23-hour day is real, not simulated.
// Node re-reads TZ when process.env.TZ changes, so set it before any Date use.
process.env.TZ = 'America/Los_Angeles';

import { describe, it, expect } from 'vitest';
import { calendarDayDiff, dateHeaderFor, localDayKey } from './sessionDateGroups';

const hasDst = new Date(2026, 0, 15).getTimezoneOffset() !== new Date(2026, 6, 15).getTimezoneOffset();

describe('sessionDateGroups (#166)', () => {
    it('counts calendar days, not 24-hour blocks', () => {
        expect(calendarDayDiff(new Date(2026, 2, 8, 23, 59), new Date(2026, 2, 9, 0, 1))).toBe(1);
        expect(calendarDayDiff(new Date(2026, 2, 9, 12), new Date(2026, 2, 9, 18))).toBe(0);
        expect(calendarDayDiff(new Date(2026, 1, 27), new Date(2026, 2, 2))).toBe(3);
        expect(calendarDayDiff(new Date(2026, 2, 9), new Date(2026, 2, 8))).toBe(-1);
    });

    it.skipIf(!hasDst)('the day after spring-forward (March 9, 2026, LA) still calls March 8 "yesterday"', () => {
        const now = new Date(2026, 2, 9, 10, 0);
        // Sanity: this zone really jumped — March 8 midnight to March 9 midnight is 23 h.
        expect(new Date(2026, 2, 9).getTime() - new Date(2026, 2, 8).getTime()).toBe(23 * 3_600_000);
        expect(dateHeaderFor(new Date(2026, 2, 8, 15, 0), now)).toEqual({ kind: 'yesterday' });
        expect(dateHeaderFor(new Date(2026, 2, 7, 15, 0), now)).toEqual({ kind: 'daysAgo', days: 2 });
        expect(dateHeaderFor(new Date(2026, 2, 1, 15, 0), now)).toEqual({ kind: 'daysAgo', days: 8 });
    });

    it.skipIf(!hasDst)('the day after fall-back (November 2, 2026, LA) does not overcount', () => {
        const now = new Date(2026, 10, 2, 10, 0);
        expect(new Date(2026, 10, 2).getTime() - new Date(2026, 10, 1).getTime()).toBe(25 * 3_600_000);
        expect(dateHeaderFor(new Date(2026, 10, 1, 15, 0), now)).toEqual({ kind: 'yesterday' });
        expect(dateHeaderFor(new Date(2026, 9, 31, 15, 0), now)).toEqual({ kind: 'daysAgo', days: 2 });
    });

    it('labels today / yesterday / N days ago from calendar dates', () => {
        const now = new Date(2026, 5, 10, 9, 0);
        expect(dateHeaderFor(new Date(2026, 5, 10, 0, 0, 1), now)).toEqual({ kind: 'today' });
        expect(dateHeaderFor(new Date(2026, 5, 9, 23, 59), now)).toEqual({ kind: 'yesterday' });
        expect(dateHeaderFor(new Date(2026, 5, 3, 12), now)).toEqual({ kind: 'daysAgo', days: 7 });
        // A future-dated session (clock skew) is "today", never a negative count.
        expect(dateHeaderFor(new Date(2026, 5, 11), now)).toEqual({ kind: 'today' });
    });

    it('localDayKey groups by local calendar day', () => {
        expect(localDayKey(new Date(2026, 2, 8, 0, 30))).toBe(localDayKey(new Date(2026, 2, 8, 23, 30)));
        expect(localDayKey(new Date(2026, 2, 8, 23, 59))).not.toBe(localDayKey(new Date(2026, 2, 9, 0, 0)));
    });
});
