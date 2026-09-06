import { describe, it, expect } from 'vitest';
import { FetchGeneration, StaleFetchError, cursorsNeedReanchor, isSendAcknowledged } from './sessionSyncGuards';

describe('FetchGeneration (#407)', () => {
    it('a fetch started before a reset is stale at its commit point', () => {
        const gen = new FetchGeneration();
        const inFlight = gen.current('s1'); // fetch begins, captures generation
        gen.bump('s1'); // resetSessionChatState while the response is pending
        expect(gen.isStale('s1', inFlight)).toBe(true);
    });

    it('a fetch started after the reset commits normally', () => {
        const gen = new FetchGeneration();
        gen.bump('s1');
        const fresh = gen.current('s1');
        expect(gen.isStale('s1', fresh)).toBe(false);
    });

    it('generations are per session', () => {
        const gen = new FetchGeneration();
        const other = gen.current('s2');
        gen.bump('s1');
        expect(gen.isStale('s2', other)).toBe(false);
    });

    it('forget resets a session without disturbing others', () => {
        const gen = new FetchGeneration();
        gen.bump('s1');
        gen.bump('s2');
        gen.forget('s1');
        expect(gen.current('s1')).toBe(0);
        expect(gen.current('s2')).toBe(1);
    });

    it('simulated pipeline: a stale fetch applies nothing and the rerun re-anchors', async () => {
        // Mirrors sync.fetchMessages: capture → await network → guard → commit.
        const gen = new FetchGeneration();
        const store: { messages: number[]; lastSeq?: number; oldestSeq?: number } = { messages: [1, 2, 3], lastSeq: 100, oldestSeq: 1 };
        let releaseNetwork!: () => void;
        const network = new Promise<void>((r) => { releaseNetwork = r; });

        const forwardFetch = (async () => {
            const g = gen.current('s');
            await network; // response for seq 101 arrives late
            if (gen.isStale('s', g)) throw new StaleFetchError('s');
            store.messages.push(101);
            store.lastSeq = 101;
        })();

        // resetSessionChatState
        gen.bump('s');
        store.messages = [];
        delete store.lastSeq;
        delete store.oldestSeq;

        releaseNetwork();
        await expect(forwardFetch).rejects.toBeInstanceOf(StaleFetchError);
        // Nothing committed: the rerun sees no cursor and takes the cold-open path.
        expect(store).toEqual({ messages: [] });
    });
});

describe('isSendAcknowledged (#410)', () => {
    it('a row reconciled with a server seq counts as accepted', () => {
        expect(isSendAcknowledged({ seq: 101, deliveryStage: 'relay' })).toBe(true);
    });

    it('a row whose stage moved past local counts as accepted even without a seq', () => {
        expect(isSendAcknowledged({ seq: null, deliveryStage: 'agent' })).toBe(true);
    });

    it('an unconfirmed optimistic row is not accepted', () => {
        expect(isSendAcknowledged({ seq: null, deliveryStage: 'local' })).toBe(false);
        expect(isSendAcknowledged(undefined)).toBe(false);
        expect(isSendAcknowledged(null)).toBe(false);
    });
});

describe('cursorsNeedReanchor (#12)', () => {
    it('an evicted store with a surviving cursor must re-anchor', () => {
        expect(cursorsNeedReanchor(false, true)).toBe(true);
    });

    it('a cold session (no store, no cursor) and a loaded session are fine', () => {
        expect(cursorsNeedReanchor(false, false)).toBe(false);
        expect(cursorsNeedReanchor(true, true)).toBe(false);
        expect(cursorsNeedReanchor(true, false)).toBe(false);
    });
});
