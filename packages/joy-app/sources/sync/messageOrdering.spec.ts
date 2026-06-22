import { describe, it, expect } from 'vitest';
import { compareMessagesNewestFirst } from './messageOrdering';
import { Message } from './typesMessage';
import { NormalizedMessage } from './typesRaw';
import { createReducer, reducer } from './reducer/reducer';

function userMsg(id: string, seq: number | null | undefined, createdAt: number, text = id): Message {
    return { kind: 'user-text', id, seq, localId: null, createdAt, text };
}
function agentMsg(id: string, seq: number | null | undefined, createdAt: number, text = id): Message {
    return { kind: 'agent-text', id, seq, localId: null, createdAt, text };
}

describe('compareMessagesNewestFirst', () => {
    // The actual cmqo6os7 incident: the daemon relayed a whole agent turn in a
    // burst ~196s AFTER Claude produced it, so the agent envelopes carry early
    // transcript-time while the bracketing "yes" (no joyTime) carries late
    // relay-time. createdAt alone sorts "yes" NEWER than its own response and
    // hides the turn. seq must win.
    it('orders a late-relayed agent turn by seq, not skewed createdAt', () => {
        const yes = userMsg('u-yes', 2976, 1782075301271);       // relay-time (late)
        const t1 = agentMsg('a-1', 2980, 1782075111502);          // transcript-time (early)
        const t2 = agentMsg('a-2', 2992, 1782075207520);
        const t3 = agentMsg('a-3', 3014, 1782075275365);
        const where = userMsg('u-where', 3016, 1782075317225);

        // Shuffled input; sort must recover strict seq-descending (newest first).
        const sorted = [t2, where, yes, t3, t1].sort(compareMessagesNewestFirst);
        expect(sorted.map((m) => m.seq)).toEqual([3016, 3014, 2992, 2980, 2976]);

        // The agent turn sits BETWEEN the two user messages (not above "yes").
        const ids = sorted.map((m) => m.id);
        expect(ids.indexOf('u-where')).toBeLessThan(ids.indexOf('a-3'));
        expect(ids.indexOf('a-1')).toBeLessThan(ids.indexOf('u-yes'));

        // A naive createdAt sort would wrongly hoist "yes" above the whole turn.
        const byCreatedAt = [...sorted].sort((a, b) => b.createdAt - a.createdAt);
        expect(byCreatedAt[1].id).toBe('u-yes'); // demonstrates the old bug
    });

    it('treats messages with no seq as newest (optimistic/pending) and is a total order', () => {
        const pending = userMsg('pending', undefined, 5);
        const a = agentMsg('a', 10, 100);
        const b = agentMsg('b', 20, 50);
        const sorted = [a, b, pending].sort(compareMessagesNewestFirst);
        expect(sorted.map((m) => m.id)).toEqual(['pending', 'b', 'a']);
    });

    it('breaks ties deterministically (same seq → createdAt → id)', () => {
        const x = agentMsg('x', 7, 200);
        const y = agentMsg('y', 7, 200);
        expect(compareMessagesNewestFirst(x, y)).toBe(1);
        expect(compareMessagesNewestFirst(y, x)).toBe(-1);
        expect(compareMessagesNewestFirst(x, x)).toBe(0);
    });
});

describe('reducer seq propagation + reconciliation', () => {
    it('carries the server seq onto emitted messages', () => {
        const state = createReducer();
        const messages: NormalizedMessage[] = [{
            id: 'm1', localId: null, createdAt: 1000, seq: 2980,
            role: 'agent', isSidechain: false,
            content: [{ type: 'text', text: 'hi', uuid: 'm1', parentUUID: null }],
        }];
        const result = reducer(state, messages);
        expect(result.messages).toHaveLength(1);
        expect(result.messages[0].seq).toBe(2980);
    });

    it('upgrades an optimistic send to its server seq when the echo arrives', () => {
        const state = createReducer();

        // 1) Optimistic local send — rendered immediately, no server seq yet.
        const optimistic: NormalizedMessage[] = [{
            id: 'local-1', localId: 'L', createdAt: 1000,
            role: 'user', isSidechain: false, content: { type: 'text', text: 'hello' },
        }];
        const first = reducer(state, optimistic);
        expect(first.messages).toHaveLength(1);
        expect(first.messages[0].seq ?? null).toBeNull();
        const internalId = first.messages[0].id;

        // 2) Server echo of the same send (matched by localId) carries seq 42.
        const echo: NormalizedMessage[] = [{
            id: 'server-1', localId: 'L', createdAt: 1000, seq: 42,
            role: 'user', isSidechain: false, content: { type: 'text', text: 'hello' },
        }];
        const second = reducer(state, echo);

        // Same message re-emitted (not a duplicate) with the authoritative seq.
        expect(second.messages).toHaveLength(1);
        expect(second.messages[0].id).toBe(internalId);
        expect(second.messages[0].seq).toBe(42);
    });
});
