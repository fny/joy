import { describe, expect, it } from 'vitest';
import { heldOpenTurn, initialScrollState, LIVE_BAND, nextScrollState, RELEASE_GRACE_MS, WHEEL_IDLE_MS, type Metrics, type ScrollEffect, type ScrollEvent, type ScrollState } from './chatScroll';

const at = (offset: number, maxOffset = 2000): Metrics => ({ offset, maxOffset });

/** Run events in order; collect every effect with the event that caused it. */
function run(events: ScrollEvent[], start: ScrollState = initialScrollState()) {
    let s = start;
    const effects: Array<{ on: ScrollEvent['type']; effect: ScrollEffect }> = [];
    for (const e of events) {
        const r = nextScrollState(s, e);
        s = r.state;
        for (const effect of r.effects) effects.push({ on: e.type, effect });
    }
    return { state: s, effects, follows: effects.filter((x) => x.effect.type === 'followBottom').length };
}

const live = (): ScrollState => ({ ...initialScrollState(), metrics: at(2000) });
const reading = (offset: number, max = 2000): ScrollState => ({ ...initialScrollState(), mode: 'reading', metrics: at(offset, max) });

describe('leaving following takes the reader', () => {
    it('one wheel notch up leaves following at once, even inside the live band', () => {
        const r = run([{ type: 'wheel', dy: -10, now: 0 }, { type: 'scroll', metrics: at(1990), now: 5 }], live());
        expect(r.state.mode).toBe('reading');
    });

    it('a geometry change mid-wheel never follows', () => {
        const r = run([{ type: 'wheel', dy: 100, now: 0 }, { type: 'geometry', now: 50 }], live());
        expect(r.follows).toBe(0);
    });

    it('a native drag revokes following when it starts; a drag up stays reading (onScroll swallowed)', () => {
        const r = run([
            { type: 'dragStart', metrics: at(2000), now: 0 },
            { type: 'geometry', now: 50 },
            { type: 'dragEnd', metrics: at(1700), now: 300 },
            { type: 'tick', now: 300 + RELEASE_GRACE_MS },
            { type: 'geometry', now: 600 },
        ], live());
        expect(r.state.mode).toBe('reading');
        expect(r.follows).toBe(0);
    });

    it('an upward fling: nothing moves in the release gap, and the final clamp does not re-arm', () => {
        const r = run([
            { type: 'dragStart', metrics: at(2000), now: 0 },
            { type: 'scroll', metrics: at(1900), now: 50 },
            { type: 'dragEnd', metrics: at(1850), now: 100 },
            { type: 'geometry', now: 110 },                       // the handoff gap
            { type: 'momentumStart', metrics: at(1840), now: 120 },
            { type: 'geometry', now: 200 },
            { type: 'momentumEnd', metrics: at(1500, 1500), now: 900 }, // clamped at a new end
            { type: 'geometry', now: 1000 },
        ], live());
        expect(r.state.mode).toBe('reading');
        expect(r.follows).toBe(0);
    });

    it('the end of its own programmatic scroll never asks for another follow', () => {
        // iOS reports a momentum end for every non-animated scrollTo. Following
        // from it re-issued the scroll each frame, and each scroll report took
        // the touch from the button under the reader's finger.
        const r = run([
            { type: 'geometry', now: 0 },
            { type: 'scroll', metrics: at(2000), now: 16 },
            { type: 'momentumEnd', metrics: at(2000), now: 16 },
        ], live());
        expect(r.effects.map((x) => x.on)).toEqual(['geometry']);
        expect(r.state.mode).toBe('following');
    });

    it('a momentum end from a programmatic animation does not end a new drag', () => {
        const r = run([
            { type: 'dragStart', metrics: at(2000), now: 0 },
            { type: 'momentumEnd', metrics: at(2000), now: 50 }, // stale animation end
            { type: 'geometry', now: 60 },
        ], live());
        expect(r.state.interaction?.phase).toBe('drag');
        expect(r.follows).toBe(0);
    });
});

describe('geometry is never permission to follow (the reported jump)', () => {
    // dev/chat-scroll-lab repro: wheel up 400px, the reply below shrinks and
    // clamps the reader to the new end, the stream resumes.
    it('a reader clamped to the bottom by content shrinking stays reading', () => {
        const r = run([
            { type: 'wheel', dy: -100, now: 0 },
            { type: 'scroll', metrics: at(1600), now: 10 },
            { type: 'tick', now: 10 + WHEEL_IDLE_MS },
            { type: 'scroll', metrics: at(1200, 1200), now: 1000 }, // shrink → clamp
            { type: 'geometry', now: 1100 },                        // stream resumes
            { type: 'geometry', now: 1200 },
        ], live());
        expect(r.state.mode).toBe('reading');
        expect(r.follows).toBe(0);
    });

    it('a small correction back inside the live band does not re-arm', () => {
        const r = run([
            { type: 'wheel', dy: -20, now: 0 },
            { type: 'tick', now: 500 },
            { type: 'scroll', metrics: at(1990), now: 600 }, // MVCP correction
            { type: 'geometry', now: 700 },
        ], live());
        expect(r.state.mode).toBe('reading');
        expect(r.follows).toBe(0);
    });

    it('a late bottom report (a deferred scrollToEnd landing) does not re-arm', () => {
        const r = run([
            { type: 'wheel', dy: -100, now: 0 },
            { type: 'tick', now: 500 },
            { type: 'scroll', metrics: at(2000), now: 600 },
            { type: 'geometry', now: 700 },
        ], live());
        expect(r.state.mode).toBe('reading');
        expect(r.follows).toBe(0);
    });

    it('a keyboard dismissal that grows the viewport during an upward drag keeps reading', () => {
        const r = run([
            { type: 'dragStart', metrics: at(2000), now: 0 },
            { type: 'scroll', metrics: at(1900), now: 50 },
            { type: 'scroll', metrics: at(1700, 1700), now: 150 }, // list taller, clamped to its end
            { type: 'dragEnd', metrics: at(1700, 1700), now: 200 },
            { type: 'tick', now: 200 + RELEASE_GRACE_MS },
            { type: 'geometry', now: 400 },
        ], live());
        expect(r.state.mode).toBe('reading');
        expect(r.follows).toBe(0);
    });

    it('a small move toward newer followed by a shrink to the end does not re-arm', () => {
        const r = run([
            { type: 'wheel', dy: 10, now: 0 },
            { type: 'scroll', metrics: at(1510), now: 5 },
            { type: 'scroll', metrics: at(1510, 1510), now: 40 }, // a fold removed the rest
            { type: 'tick', now: 400 },
        ], reading(1500));
        expect(r.state.mode).toBe('reading');
    });
});

describe('returning to following is the reader\'s own move', () => {
    it('wheeling down into the live band resumes following once the wheel goes quiet', () => {
        const r = run([
            { type: 'wheel', dy: 100, now: 1000 },
            { type: 'scroll', metrics: at(2000 - LIVE_BAND + 1), now: 1010 },
            { type: 'tick', now: 1010 + WHEEL_IDLE_MS },
        ], reading(1800));
        expect(r.state.mode).toBe('following');
        expect(r.follows).toBe(1);
    });

    it('down then up inside one wheel burst, ending in the band, stays reading', () => {
        const r = run([
            { type: 'wheel', dy: 20, now: 0 },
            { type: 'scroll', metrics: at(1985), now: 5 },
            { type: 'wheel', dy: -10, now: 40 },
            { type: 'scroll', metrics: at(1975), now: 45 },
            { type: 'tick', now: 400 },
        ], reading(1965));
        expect(r.state.mode).toBe('reading');
    });

    it('wheeling down but stopping above the band stays reading', () => {
        const r = run([
            { type: 'wheel', dy: 100, now: 1000 },
            { type: 'scroll', metrics: at(1800), now: 1010 },
            { type: 'tick', now: 1500 },
        ], reading(1700));
        expect(r.state.mode).toBe('reading');
    });

    it('a downward drag ending past the end (iOS overscroll) resumes following', () => {
        const r = run([
            { type: 'dragStart', metrics: at(1990), now: 0 },
            { type: 'scroll', metrics: at(2010), now: 80 },
            { type: 'dragEnd', metrics: at(2030), now: 200 },
            { type: 'tick', now: 200 + RELEASE_GRACE_MS },
        ], reading(1990));
        expect(r.state.mode).toBe('following');
    });

    it('the down button follows and scrolls, and so does sending a prompt', () => {
        for (const type of ['bottomPressed', 'sent'] as const) {
            const r = run([{ type, now: 0 }], reading(1500));
            expect(r.state.mode).toBe('following');
            expect(r.effects.map((e) => e.effect.type)).toEqual(['scrollToBottom']);
        }
    });

    it('a tap (pointer down and up without moving) changes nothing', () => {
        const r = run([
            { type: 'pointerDown', metrics: at(1500), now: 0 },
            { type: 'pointerUp', metrics: at(1500), now: 100 },
        ], reading(1500));
        expect(r.state.mode).toBe('reading');
    });
});

describe('gpt-6-astra round 3 counterexamples', () => {
    it('a drag that reverses toward older in its last (swallowed) stretch stays reading', () => {
        const r = run([
            { type: 'dragStart', metrics: at(1990), now: 0 },
            { type: 'scroll', metrics: at(1995), now: 40 },
            { type: 'dragEnd', metrics: at(1980), now: 100 },
            { type: 'tick', now: 100 + RELEASE_GRACE_MS },
        ], reading(1990));
        expect(r.state.mode).toBe('reading');
        expect(r.follows).toBe(0);
    });

    it('an upward drag plus a prepend correction that nets an increase does not reattach', () => {
        const r = run([
            { type: 'dragStart', metrics: at(1400, 1400), now: 0 },
            { type: 'dragEnd', metrics: at(1480, 1500), now: 200 },
            { type: 'tick', now: 200 + RELEASE_GRACE_MS },
        ], live());
        expect(r.state.mode).toBe('reading');
        expect(r.follows).toBe(0);
    });

    it('a delayed live restore after the reader took over does nothing', () => {
        const r = run([
            { type: 'wheel', dy: -100, now: 0 },
            { type: 'restore', live: true, now: 50 }, // still interacting
        ], live());
        expect(r.state.mode).toBe('reading');
        expect(r.follows).toBe(0);
    });

    it('growth then a shrink within one downward gesture does not reattach', () => {
        const r = run([
            { type: 'wheel', dy: 100, now: 0 },
            { type: 'scroll', metrics: at(2800, 3000), now: 10 },
            { type: 'scroll', metrics: at(2500, 2500), now: 40 },
            { type: 'tick', now: 400 },
        ], reading(1500));
        expect(r.state.mode).toBe('reading');
        expect(r.follows).toBe(0);
    });

    it('a shrink reported only through geometry metrics counts too', () => {
        const r = run([
            { type: 'wheel', dy: 100, now: 0 },
            { type: 'scroll', metrics: at(1800), now: 10 },
            { type: 'geometry', metrics: at(1800, 1800), now: 40 },
            { type: 'tick', now: 400 },
        ], reading(1700));
        expect(r.state.mode).toBe('reading');
    });

    it('a momentum start delivered after the release grace still guards the fling', () => {
        const r = run([
            { type: 'dragStart', metrics: at(1990), now: 0 },
            { type: 'scroll', metrics: at(1995), now: 40 },
            { type: 'dragEnd', metrics: at(2000), now: 100 },
            { type: 'momentumStart', metrics: at(2000), now: 260 },
            { type: 'geometry', now: 270 },
        ], reading(1990));
        expect(r.state.interaction?.phase).toBe('momentum');
        expect(r.follows).toBe(0);
    });

    it('a momentum start after the release already ended still starts a guarded interaction', () => {
        const r = run([
            { type: 'dragStart', metrics: at(1500), now: 0 },
            { type: 'dragEnd', metrics: at(1400), now: 100 },
            { type: 'tick', now: 100 + RELEASE_GRACE_MS + 10 },
            { type: 'momentumStart', metrics: at(1400), now: 300 },
            { type: 'geometry', now: 310 },
        ], live());
        expect(r.state.interaction?.phase).toBe('momentum');
        expect(r.follows).toBe(0);
    });
});

describe('gpt-6-astra round 4 counterexamples', () => {
    it('an Android programmatic animation (momentum start with no drag) does not cancel its navigation', () => {
        let r = run([{ type: 'navigate', now: 0 }], live());
        const gen = r.state.op!.gen;
        r = run([{ type: 'momentumStart', metrics: at(900), now: 50 }], r.state);
        expect(r.state.op?.gen).toBe(gen);
        expect(r.state.interaction).toBeNull();
    });

    it('a jump started just after a drag release keeps its own animation (round 5)', () => {
        let r = run([
            { type: 'dragStart', metrics: at(1500), now: 0 },
            { type: 'dragEnd', metrics: at(1400), now: 100 },
            { type: 'tick', now: 251 },
            { type: 'navigate', now: 300 },
        ], live());
        const gen = r.state.op!.gen;
        r = run([{ type: 'momentumStart', metrics: at(900), now: 310 }], r.state);
        expect(r.state.op?.gen).toBe(gen);
    });

    it('an explicit jump clears the interrupted-restore protection (round 5)', () => {
        const r = run([
            { type: 'restore', live: false, now: 0 }, { type: 'appBackground', now: 10 },
            { type: 'appActive', now: 20 }, { type: 'navigate', now: 30 },
        ], live());
        expect(r.state.restoreInterrupted).toBe(false);
    });

    it('backgrounding mid-restore keeps the snapshot protected until the next restore', () => {
        let r = run([{ type: 'restore', live: false, now: 0 }, { type: 'appBackground', now: 10 }], live());
        expect(r.state.op).toBeNull();
        expect(r.state.restoreInterrupted).toBe(true);
        r = run([{ type: 'appActive', now: 20 }, { type: 'restore', live: false, now: 30 }], r.state);
        expect(r.state.restoreInterrupted).toBe(false);
    });

    it('overscroll past the end, momentum, and the spring back: a downward gesture, following resumes', () => {
        const r = run([
            { type: 'dragStart', metrics: at(1990), now: 0 },
            { type: 'dragEnd', metrics: at(2030), now: 100 },
            { type: 'momentumStart', metrics: at(2030), now: 110 },
            { type: 'momentumEnd', metrics: at(2000), now: 600 },
            { type: 'geometry', now: 700 },
        ], reading(1990));
        expect(r.state.mode).toBe('following');
        expect(r.follows).toBeGreaterThan(0);
    });

    it('a drag end report that reverses counts, even with no scroll delivered in between', () => {
        const r = run([
            { type: 'dragStart', metrics: at(1995), now: 0 },
            { type: 'scroll', metrics: at(2000), now: 40 },
            { type: 'dragEnd', metrics: at(1999), now: 100 },
            { type: 'tick', now: 100 + RELEASE_GRACE_MS },
        ], reading(1995));
        expect(r.state.mode).toBe('reading');
    });
});

describe('following follows, only with hands off', () => {
    it('a following reader follows every geometry change', () => {
        const r = run([{ type: 'geometry', now: 0 }, { type: 'geometry', now: 16 }], live());
        expect(r.follows).toBe(2);
    });

    it('a pointer held on the list (scrollbar, touch) blocks following until it lifts', () => {
        const r = run([
            { type: 'pointerDown', metrics: at(2000), now: 0 },
            { type: 'geometry', now: 50 },
            { type: 'pointerUp', metrics: at(2000), now: 100 },
        ], live());
        expect(r.effects.map((e) => e.on)).toEqual(['pointerUp']);
    });

    it('route hidden and app background are independent', () => {
        let r = run([{ type: 'routeHidden', now: 0 }, { type: 'appBackground', now: 1 }, { type: 'appActive', now: 2 }, { type: 'geometry', now: 3 }], live());
        expect(r.follows).toBe(0);
        r = run([{ type: 'routeShown', now: 4 }, { type: 'geometry', now: 5 }], r.state);
        expect(r.follows).toBe(1);
    });

    it('a restore does nothing while the route is hidden', () => {
        const r = run([{ type: 'routeHidden', now: 0 }, { type: 'restore', live: true, now: 1 }], live());
        expect(r.effects).toEqual([]);
    });
});

describe('programmatic operations belong to one generation', () => {
    it('user input during a restore cancels it: its completion is stale and nothing follows', () => {
        let r = run([{ type: 'restore', live: false, now: 0 }], live());
        const opGen = (r.effects[0].effect as { gen: number }).gen;
        r = run([{ type: 'wheel', dy: -50, now: 100 }], r.state);
        expect(r.state.op).toBeNull();
        expect(r.state.gen).not.toBe(opGen);
        r = run([{ type: 'opDone', gen: opGen, now: 400 }, { type: 'geometry', now: 500 }], r.state);
        expect(r.state.mode).toBe('reading');
        expect(r.follows).toBe(0);
    });

    it('a stale completion does not clear a newer operation', () => {
        let r = run([{ type: 'navigate', now: 0 }, { type: 'navigate', now: 10 }], live());
        const [first, second] = r.effects.map((e) => (e.effect as { gen: number }).gen);
        r = run([{ type: 'opDone', gen: first, now: 20 }], r.state);
        expect(r.state.op?.gen).toBe(second);
    });

    it('a live restore follows; a reading restore does not', () => {
        expect(run([{ type: 'restore', live: true, now: 0 }], reading(1500)).follows).toBe(1);
        const r = run([{ type: 'restore', live: false, now: 0 }, { type: 'geometry', now: 10 }], live());
        expect(r.follows).toBe(0);
        expect(r.state.mode).toBe('reading');
    });
});

describe('heldOpenTurn', () => {
    it('holds the turn that is thinking, and keeps holding it after the turn ends', () => {
        expect(heldOpenTurn(null, true, 'p1')).toBe('p1');
        expect(heldOpenTurn('p1', false, 'p1')).toBe('p1');
    });
    it('lets go when the next prompt arrives, or when nothing was ever held', () => {
        expect(heldOpenTurn('p1', false, 'p2')).toBeNull();
        expect(heldOpenTurn(null, false, 'p1')).toBeNull();
    });
    it('moves the hold to the new turn when it starts thinking', () => {
        expect(heldOpenTurn('p1', true, 'p2')).toBe('p2');
    });
});
