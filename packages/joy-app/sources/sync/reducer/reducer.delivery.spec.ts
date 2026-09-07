import { describe, it, expect } from 'vitest';
import { createReducer, reducer, advanceDeliveryStage, bindTurnToLocal, forgetLocalMessage } from './reducer';
import type { NormalizedMessage } from '../typesRaw';

// Optimistic sends: the row this client inserts (stage 'local'), the relay's
// own turn.queued row reconciling INTO it, and lifecycle events advancing it.

const optimistic = (localId: string, text = 'hello'): NormalizedMessage => ({
    id: localId, localId, createdAt: 1000, role: 'user', isSidechain: false,
    content: { type: 'text', text },
    meta: { sentFrom: 'app', deliveryStage: 'local' },
} as NormalizedMessage);

const serverEcho = (localId: string, turnId: string, seq: number, attachments?: unknown[]): NormalizedMessage => ({
    id: `srv-${seq}`, localId, seq, createdAt: 2000, role: 'user', isSidechain: false,
    content: { type: 'text', text: 'hello', ...(attachments ? { attachments } : {}) },
    meta: { sentFrom: 'joy', turnId },
} as NormalizedMessage);

const userRows = (state: ReturnType<typeof createReducer>) =>
    [...state.messages.values()].filter((m) => m.role === 'user');

describe('optimistic delivery stages', () => {
    it('inserts at local and brightens through relay → daemon → agent, never backwards', () => {
        const state = createReducer();
        reducer(state, [optimistic('l1')]);
        expect(userRows(state)).toHaveLength(1);
        expect(userRows(state)[0].deliveryStage).toBe('local');

        expect(advanceDeliveryStage(state, { localId: 'l1' }, 'relay')).toHaveLength(1);
        expect(userRows(state)[0].deliveryStage).toBe('relay');

        bindTurnToLocal(state, 'l1', 'turn-A');
        expect(advanceDeliveryStage(state, { turnId: 'turn-A' }, 'daemon')).toHaveLength(1);
        expect(userRows(state)[0].deliveryStage).toBe('daemon');

        // A late, lower stage is ignored.
        expect(advanceDeliveryStage(state, { turnId: 'turn-A' }, 'relay')).toHaveLength(0);
        expect(userRows(state)[0].deliveryStage).toBe('daemon');

        expect(advanceDeliveryStage(state, { turnId: 'turn-A' }, 'agent')).toHaveLength(1);
        expect(userRows(state)[0].deliveryStage).toBe('agent');
    });

    it('applies turn lifecycle that arrived BEFORE the turn was bound (#634)', () => {
        const state = createReducer();
        reducer(state, [optimistic('l1')]);
        expect(userRows(state)[0].deliveryStage).toBe('local');

        // A page read carrying turn.receipted/turn.started can land before the
        // POST ack binds the turn. These used to be dropped on the floor and
        // nothing ever re-applied them, so the bubble stayed dim forever.
        expect(advanceDeliveryStage(state, { turnId: 'turn-A' }, 'daemon')).toHaveLength(0);
        expect(advanceDeliveryStage(state, { turnId: 'turn-A' }, 'agent')).toHaveLength(0);
        expect(userRows(state)[0].deliveryStage).toBe('local');

        // The binding arrives late; the parked stage applies with it.
        expect(bindTurnToLocal(state, 'l1', 'turn-A')).toHaveLength(1);
        expect(userRows(state)[0].deliveryStage).toBe('agent');
        expect(state.pendingTurnStages.size).toBe(0);
    });

    it('parks only the highest stage, and never regresses a row on binding', () => {
        const state = createReducer();
        reducer(state, [optimistic('l1')]);
        advanceDeliveryStage(state, { localId: 'l1' }, 'relay');

        // Out-of-order arrivals: the highest wins, the lower is discarded.
        advanceDeliveryStage(state, { turnId: 'turn-A' }, 'agent');
        advanceDeliveryStage(state, { turnId: 'turn-A' }, 'daemon');
        expect(state.pendingTurnStages.get('turn-A')).toBe('agent');

        bindTurnToLocal(state, 'l1', 'turn-A');
        expect(userRows(state)[0].deliveryStage).toBe('agent');
    });

    it('does not park a stage keyed only by an unknown localId', () => {
        const state = createReducer();
        advanceDeliveryStage(state, { localId: 'never-sent' }, 'agent');
        expect(state.pendingTurnStages.size).toBe(0);
    });

    it('bounds the parked map so turns from other devices cannot grow it forever', () => {
        const state = createReducer();
        for (let i = 0; i < 200; i++) {
            advanceDeliveryStage(state, { turnId: `foreign-${i}` }, 'agent');
        }
        expect(state.pendingTurnStages.size).toBeLessThanOrEqual(64);
        // The most recent turns are the ones still worth binding.
        expect(state.pendingTurnStages.has('foreign-199')).toBe(true);
    });

    it("the relay's own row reconciles into the optimistic one — one row, seq learned, turn learned, stage ≥ relay", () => {
        const state = createReducer();
        reducer(state, [optimistic('l2')]);
        reducer(state, [serverEcho('l2', 'turn-B', 41, [{ id: 'att-1', name: 'shot.png', size: 10 }])]);

        const rows = userRows(state);
        expect(rows).toHaveLength(1);              // no duplicate bubble
        expect(rows[0].seq).toBe(41);
        expect(rows[0].turnId).toBe('turn-B');
        expect(rows[0].deliveryStage).toBe('relay');
        // Attachment citations exist only after upload — the echo supplies them.
        expect(rows[0].attachments?.map((a) => a.id)).toEqual(['att-1']);
        // And the turn is now addressable by lifecycle events.
        expect(advanceDeliveryStage(state, { turnId: 'turn-B' }, 'agent')).toHaveLength(1);
    });

    it('rows without a stage (history, other devices) are never touched', () => {
        const state = createReducer();
        reducer(state, [serverEcho('other-device', 'turn-C', 7)]);
        expect(userRows(state)[0].deliveryStage).toBeUndefined();
        expect(advanceDeliveryStage(state, { turnId: 'turn-C' }, 'agent')).toHaveLength(0);
        expect(userRows(state)[0].deliveryStage).toBeUndefined();
    });

    it('a failed send is forgotten completely, so a retry under the same localId is a fresh row', () => {
        const state = createReducer();
        reducer(state, [optimistic('l3')]);
        bindTurnToLocal(state, 'l3', 'turn-D');
        const internalId = forgetLocalMessage(state, 'l3');
        expect(internalId).toBeTruthy();
        expect(userRows(state)).toHaveLength(0);
        expect(state.localIds.has('l3')).toBe(false);
        expect(state.turnIds.has('turn-D')).toBe(false);

        reducer(state, [optimistic('l3', 'hello again')]);
        expect(userRows(state)).toHaveLength(1);
        expect(userRows(state)[0].text).toBe('hello again');
    });
});
