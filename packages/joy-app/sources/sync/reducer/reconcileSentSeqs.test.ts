import { describe, it, expect } from 'vitest';
import { createReducer, reducer, reconcileSentSeqs } from './reducer';
import { NormalizedMessage } from '../typesRaw';

/**
 * Regression test for the optimistic-send ordering bug: a client's own user
 * messages never receive a live `seq` (the socket broadcast omits the sender's
 * own rows), so they kept seq=null until a full reload and the seq-based display
 * sort floated them to "now". reconcileSentSeqs applies the POST /messages ack
 * — the one place a sender learns its messages' seq — back onto the reducer.
 */
function optimisticUser(localId: string, text: string, createdAt: number): NormalizedMessage {
    return {
        role: 'user',
        content: { type: 'text', text },
        id: localId,        // optimistic id === localId (see sync.sendMessage)
        localId,
        createdAt,
        seq: null,
        isSidechain: false,
    };
}

describe('reconcileSentSeqs', () => {
    it('upgrades an optimistic user send seq from the POST ack (matched by localId)', () => {
        const state = createReducer();
        reducer(state, [optimisticUser('local-1', 'hello', 1000)]);

        // Before the ack, the optimistic send has no server seq.
        const before = [...state.messages.values()].find((m) => m.role === 'user');
        expect(before?.seq).toBeNull();

        const changed = reconcileSentSeqs(state, [{ id: 'server-1', seq: 42, localId: 'local-1' }]);

        expect(changed).toHaveLength(1);
        expect(changed[0].seq).toBe(42);
        const after = [...state.messages.values()].find((m) => m.role === 'user');
        expect(after?.seq).toBe(42);
        // The server id is now also indexed so a later echo dedupes correctly.
        expect(state.messageIds.get('server-1')).toBe(after?.id);
    });

    it('no-ops on an ack whose localId/id the reducer has never seen (no phantom message)', () => {
        const state = createReducer();
        reducer(state, [optimisticUser('local-1', 'hello', 1000)]);
        const countBefore = state.messages.size;

        const changed = reconcileSentSeqs(state, [{ id: 'server-x', seq: 99, localId: 'unknown-local' }]);

        expect(changed).toHaveLength(0);
        expect(state.messages.size).toBe(countBefore);
    });

    it('reconciles a batch and leaves already-correct seqs untouched', () => {
        const state = createReducer();
        reducer(state, [
            optimisticUser('local-1', 'a', 1000),
            optimisticUser('local-2', 'b', 1001),
        ]);

        const changed = reconcileSentSeqs(state, [
            { id: 'server-1', seq: 10, localId: 'local-1' },
            { id: 'server-2', seq: 11, localId: 'local-2' },
        ]);
        expect(changed).toHaveLength(2);

        // Re-applying the same acks is idempotent — nothing changes.
        const again = reconcileSentSeqs(state, [
            { id: 'server-1', seq: 10, localId: 'local-1' },
            { id: 'server-2', seq: 11, localId: 'local-2' },
        ]);
        expect(again).toHaveLength(0);
    });
});
