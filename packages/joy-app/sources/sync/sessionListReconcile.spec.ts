import { describe, it, expect } from 'vitest';
import { staleSessionIds } from './sessionListReconcile';

const linked = (id: string) => ({ metadata: { v2: { sessionId: id } } });

describe('staleSessionIds (#406)', () => {
    it('names v2 sessions the relay list no longer contains', () => {
        const existing = { a: linked('a'), b: linked('b'), c: linked('c') };
        expect(staleSessionIds(existing, ['a', 'c'])).toEqual(['b']);
    });

    it('returns nothing when the list matches', () => {
        const existing = { a: linked('a'), b: linked('b') };
        expect(staleSessionIds(existing, ['b', 'a'])).toEqual([]);
    });

    it('never removes the demo session or a stub without a relay link', () => {
        const existing = {
            'demo-messages-session': linked('demo-messages-session'),
            stub: { metadata: { v2: undefined } },
            gone: linked('gone'),
        };
        const out = staleSessionIds(existing, [], (id) => id === 'demo-messages-session');
        expect(out).toEqual(['gone']);
    });

    it('treats an empty list as "everything deleted"', () => {
        // The list is the account's authoritative snapshot on this relay.
        expect(staleSessionIds({ a: linked('a') }, [])).toEqual(['a']);
    });
});
