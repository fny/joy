import { describe, it, expect } from 'vitest';
import { sessionsToRetain } from './sessionMemory';

const none = () => false;

describe('sessionsToRetain', () => {
    it('keeps everything when the limit is off', () => {
        for (const limit of [null, undefined, 0, -1]) {
            expect(sessionsToRetain({ loadedIds: ['a', 'b', 'c'], mru: ['a'], limit, hasLiveTurn: none })).toBeNull();
        }
    });

    it('keeps the most-recently-viewed up to the limit', () => {
        const retained = sessionsToRetain({
            loadedIds: ['a', 'b', 'c', 'd'], mru: ['c', 'a', 'd', 'b'], limit: 2, hasLiveTurn: none,
        });
        expect(retained).toEqual(new Set(['c', 'a']));
    });

    it('never evicts a session with a live turn, however stale its view', () => {
        const retained = sessionsToRetain({
            loadedIds: ['a', 'b', 'c'], mru: ['a'], limit: 1, hasLiveTurn: (id) => id === 'c',
        });
        // 'c' is last in the MRU and well past the limit, but it is mid-turn:
        // dropping it is what left the chat blank on return.
        expect(retained).toEqual(new Set(['a', 'c']));
    });

    it('reports null when nothing would be dropped, so the caller can skip the rebuild', () => {
        expect(sessionsToRetain({ loadedIds: ['a', 'b'], mru: ['a', 'b'], limit: 5, hasLiveTurn: none })).toBeNull();
        expect(sessionsToRetain({ loadedIds: ['a', 'b'], mru: ['a'], limit: 1, hasLiveTurn: () => true })).toBeNull();
    });

    it('drops a loaded session that is neither recent nor working', () => {
        expect(sessionsToRetain({ loadedIds: ['a', 'b'], mru: ['a'], limit: 1, hasLiveTurn: none })).toEqual(new Set(['a']));
    });
});
