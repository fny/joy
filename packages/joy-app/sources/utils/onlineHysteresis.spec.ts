import { describe, it, expect } from 'vitest';
import { stabilizeOnline, sameOnlineState } from './onlineHysteresis';

const GRACE = 8_000;
const step = (state: { stable: boolean; offlineSince: number | null }, raw: boolean, now: number) =>
    stabilizeOnline({ ...state, raw, now, graceMs: GRACE });

describe('stabilizeOnline', () => {
    it('keeps showing online through a brief blip — the flash this exists to stop', () => {
        let s = { stable: true, offlineSince: null as number | null };
        s = step(s, false, 1_000);       // one late keepalive
        expect(s.stable).toBe(true);
        s = step(s, true, 3_000);        // the next one arrives
        expect(s).toEqual({ stable: true, offlineSince: null });
    });

    it('goes offline once the reading is sustained past the grace window', () => {
        let s = { stable: true, offlineSince: null as number | null };
        s = step(s, false, 1_000);
        expect(s.stable).toBe(true);
        s = step(s, false, 1_000 + GRACE - 1);
        expect(s.stable).toBe(true);     // not yet
        s = step(s, false, 1_000 + GRACE);
        expect(s.stable).toBe(false);    // believed
    });

    it('recovers instantly — never delays a session that is ready', () => {
        let s: { stable: boolean; offlineSince: number | null } = { stable: false, offlineSince: 1_000 };
        s = step(s, true, 50_000);
        expect(s).toEqual({ stable: true, offlineSince: null });
    });

    it('does not restart the clock on every false reading', () => {
        let s = { stable: true, offlineSince: null as number | null };
        s = step(s, false, 1_000);
        s = step(s, false, 4_000);
        s = step(s, false, 7_000);
        expect(s.offlineSince).toBe(1_000);   // still the first one
        s = step(s, false, 9_000);
        expect(s.stable).toBe(false);          // 8s after 1_000, not after 7_000
    });

    it('is stable once offline — repeated false readings change nothing', () => {
        const s: { stable: boolean; offlineSince: number | null } = { stable: false, offlineSince: 1_000 };
        expect(step(s, false, 20_000)).toEqual(s);
        expect(step(s, false, 99_000)).toEqual(s);
    });

    it('holds a steady online state without churning', () => {
        const s = { stable: true, offlineSince: null as number | null };
        expect(sameOnlineState(step(s, true, 5_000), s)).toBe(true);
    });
});

describe('sameOnlineState', () => {
    it('compares both fields', () => {
        expect(sameOnlineState({ stable: true, offlineSince: null }, { stable: true, offlineSince: null })).toBe(true);
        expect(sameOnlineState({ stable: true, offlineSince: null }, { stable: false, offlineSince: null })).toBe(false);
        expect(sameOnlineState({ stable: true, offlineSince: 1 }, { stable: true, offlineSince: 2 })).toBe(false);
    });
});
