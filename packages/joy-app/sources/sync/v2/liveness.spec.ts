import { describe, it, expect } from 'vitest';
import { v2ActiveAt } from './liveness';
import { isSessionInActiveGroup, SESSION_STALE_AFTER_MS } from '../sessionLiveness';

const NOW = 1_800_000_000_000;
const LONG_AGO = NOW - 10 * SESSION_STALE_AFTER_MS;

describe('v2ActiveAt — lease liveness as the activeAt heartbeat', () => {
    it('online row: activeAt is now, even when the last turn was ages ago', () => {
        const row = { online: true, lastTurnAt: LONG_AGO, updatedAt: LONG_AGO };
        expect(v2ActiveAt(row, undefined, NOW)).toBe(NOW);
        expect(v2ActiveAt(row, LONG_AGO, NOW)).toBe(NOW);
    });

    it('offline row: falls back to the last moment we saw it live, never older than its last turn', () => {
        const seenLive = NOW - 5_000;
        expect(v2ActiveAt({ online: false, lastTurnAt: LONG_AGO, updatedAt: LONG_AGO }, seenLive, NOW)).toBe(seenLive);
        // last turn newer than what the store remembers → the turn wins
        expect(v2ActiveAt({ online: false, lastTurnAt: NOW - 1_000, updatedAt: LONG_AGO }, seenLive, NOW)).toBe(NOW - 1_000);
        // no turns yet → updatedAt
        expect(v2ActiveAt({ online: false, lastTurnAt: null, updatedAt: LONG_AGO }, undefined, NOW)).toBe(LONG_AGO);
    });

    it('the regression: an idle-but-online session stays in the active group; a dead one leaves it', () => {
        // isSessionInActiveGroup reads the real clock, so anchor to it here
        const now = Date.now();
        const longAgo = now - 10 * SESSION_STALE_AFTER_MS;
        const idle = { online: true, lastTurnAt: longAgo, updatedAt: longAgo };
        const asSession = (activeAt: number) => ({ active: true, activeAt, metadata: { joy__state: 'running' } });
        // before the fix this was `lastTurnAt` → stale → out of the group / hidden
        expect(isSessionInActiveGroup(asSession(v2ActiveAt(idle, undefined, now)))).toBe(true);
        // lease lapsed: the fallback timestamp is old → stale → out of the group
        const dead = { ...idle, online: false };
        expect(isSessionInActiveGroup(asSession(v2ActiveAt(dead, longAgo, now)))).toBe(false);
    });
});
