import { describe, expect, it } from 'vitest';
import { SessionContextLedger } from './contextLedger';

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
