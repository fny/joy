import { describe, expect, it } from 'vitest';
import { MAX_DEFERRED_UPDATES, SessionContextLedger } from './contextLedger';

type M = { id: string; text: string };
const m = (id: string, text = id): M => ({ id, text });

describe('SessionContextLedger (#340)', () => {
    it('defers updates only for sessions the connection was shown', () => {
        const l = new SessionContextLedger<M>();
        l.markShown('A');
        expect(l.defer('A', [m('1')])).toBe(true);
        expect(l.defer('B', [m('2')])).toBe(false);
        expect(l.staleSessions()).toEqual(['A']);
        expect(l.isShown('B')).toBe(false);
    });

    it('replays deferred updates once, oldest first, latest version of a message winning', () => {
        const l = new SessionContextLedger<M>();
        l.markShown('A');
        l.defer('A', [m('1', 'first'), m('2', 'second')]);
        l.defer('A', [m('1', 'first, updated')]);
        expect(l.takeDeferred('A')).toEqual([m('1', 'first, updated'), m('2', 'second')]);
        expect(l.takeDeferred('A')).toEqual([]);
        expect(l.staleSessions()).toEqual([]);
        expect(l.isShown('A')).toBe(true);
    });

    it('a fresh snapshot drops what was deferred against the old one', () => {
        const l = new SessionContextLedger<M>();
        l.markShown('A');
        l.defer('A', [m('1')]);
        l.markShown('A');
        expect(l.takeDeferred('A')).toEqual([]);
    });

    it('past the bound the snapshot is void: nothing more is kept and the session is briefed in full again', () => {
        const l = new SessionContextLedger<M>(3);
        l.markShown('A');
        expect(l.defer('A', [m('1'), m('2'), m('3')])).toBe(true);
        expect(l.size).toBe(3);
        expect(l.isShown('A')).toBe(true);
        expect(l.defer('A', [m('4')])).toBe(true);
        expect(l.size).toBe(0);
        expect(l.isShown('A')).toBe(false); // the next injection is the full context
        expect(l.staleSessions()).toEqual(['A']); // and it is due
        expect(l.takeDeferred('A')).toEqual([]);
        expect(l.staleSessions()).toEqual(['A']);
        // Still swallowed — the full briefing will include them.
        expect(l.defer('A', [m('5')])).toBe(true);
        expect(l.size).toBe(0);
        l.markShown('A');
        expect(l.isShown('A')).toBe(true);
        expect(l.staleSessions()).toEqual([]);
    });

    it('a re-sent version of a deferred message does not count towards the bound', () => {
        const l = new SessionContextLedger<M>(2);
        l.markShown('A');
        l.defer('A', [m('1'), m('2')]);
        l.defer('A', [m('1', 'again'), m('2', 'again')]);
        expect(l.isShown('A')).toBe(true);
        expect(l.takeDeferred('A')).toEqual([m('1', 'again'), m('2', 'again')]);
    });

    it('the default bound is small: a connect takes seconds, not a session history', () => {
        expect(MAX_DEFERRED_UPDATES).toBeLessThanOrEqual(100);
        const l = new SessionContextLedger<M>();
        l.markShown('A');
        for (let i = 0; i < 10_000; i++) l.defer('A', [m(`${i}`)]);
        expect(l.size).toBe(0);
        expect(l.isShown('A')).toBe(false);
    });

    it('clear forgets every session', () => {
        const l = new SessionContextLedger<M>();
        l.markShown('A');
        l.defer('A', [m('1')]);
        l.clear();
        expect(l.isShown('A')).toBe(false);
        expect(l.takeDeferred('A')).toEqual([]);
        expect(l.defer('A', [m('2')])).toBe(false);
    });
});
