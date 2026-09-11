import { describe, it, expect } from 'vitest';
import { SESSION_STALE_AFTER_MS, isFreshAt, msUntilNextSessionStale } from './sessionLiveness';

describe('session freshness boundary', () => {
    const now = 1_000_000;

    it('is fresh strictly inside the window and stale at the edge', () => {
        expect(isFreshAt({ activeAt: now - SESSION_STALE_AFTER_MS + 1 }, now)).toBe(true);
        expect(isFreshAt({ activeAt: now - SESSION_STALE_AFTER_MS }, now)).toBe(false);
    });

    it('names the earliest expiry among the fresh sessions and ignores stale ones', () => {
        const sessions = [
            { activeAt: now - 10_000 },                    // expires in 80 s
            { activeAt: now - 60_000 },                    // expires in 30 s  ← earliest
            { activeAt: now - SESSION_STALE_AFTER_MS - 5 }, // already stale: not a boundary
        ];
        expect(msUntilNextSessionStale(sessions, now)).toBe(SESSION_STALE_AFTER_MS - 60_000);
    });

    it('answers null when nothing is fresh (no timer to arm)', () => {
        expect(msUntilNextSessionStale([], now)).toBeNull();
        expect(msUntilNextSessionStale([{ activeAt: now - SESSION_STALE_AFTER_MS }], now)).toBeNull();
    });

    it('never answers a negative delay', () => {
        expect(msUntilNextSessionStale([{ activeAt: now - SESSION_STALE_AFTER_MS + 1 }], now)).toBe(1);
    });
});
