/**
 * #128 — sealed rows a read cannot open with the key it has are kept as
 * recoverable GAPS, not dropped: after the retry budget the cursor advances
 * (one bad row must not wedge the session), but the range is remembered
 * with the key it failed under and re-read once the session's key changes.
 * A session holds a list of ranges, each settled under its own key; a
 * replay that runs out of budget leaves the unvisited remainder as its
 * continuation cursor; older pages record gaps too; and the ranges are
 * mirrored into the store for the chat's placeholder row. Run against the
 * REAL class members (syncMembers.testutil.ts).
 */
import { describe, it, expect } from 'vitest';
import { FetchGeneration, StaleFetchError } from './sessionSyncGuards';
import { buildSyncSubset } from './syncMembers.testutil';
import type { UnopenableGapRange } from './typesMessage';

const quiet = { log: () => { } };
const K1 = new Uint8Array(32).fill(1);
const K2 = new Uint8Array(32).fill(2);
const K3 = new Uint8Array(32).fill(3);
const id = (k: Uint8Array) => Array.from(k, (b) => b.toString(16).padStart(2, '0')).join('');

type Page = { messages: { seq: number; id: string }[]; lifecycle: never[]; cursor: number; hasMore: boolean; unopenable?: number; unopenableSeqs?: number[] };
type Range = { fromSeq: number; toSeq: number; keyId: string | null; count: number };

const MEMBERS = ['fetchForwardSince', 'loadOlderMessages', 'assertFresh', 'replayUnopenableGap', 'recordUnopenableGap', 'publishUnopenableGaps', 'keyId'];

function build(
    pageFor: (key: Uint8Array | null, afterSeq: number) => Page,
    olderPageFor: (key: Uint8Array | null, beforeSeq: number) => Page = () => ({ messages: [], lifecycle: [], cursor: 1, hasMore: false, unopenable: 0 }),
) {
    const calls: { key: Uint8Array | null; afterSeq: number }[] = [];
    const olderCalls: { key: Uint8Array | null; beforeSeq: number }[] = [];
    const applied: { seq: number; id: string }[] = [];
    const published: UnopenableGapRange[][] = [];
    let invalidated = 0;
    const state = {
        sessionMessages: { A: { isLoadingOlder: false, hasMoreOlder: true } },
        applyOlderMessagesLoading: () => { },
        applyOlderMessagesPagination: () => { },
        applyUnopenableGaps: (_s: string, ranges: UnopenableGapRange[]) => { published.push(ranges); },
    };
    const Sync = buildSyncSubset(MEMBERS, {
        v2MessagesAfter: async (opts: { key: Uint8Array | null; afterSeq: number }) => {
            calls.push({ key: opts.key, afterSeq: opts.afterSeq });
            return pageFor(opts.key, opts.afterSeq);
        },
        v2MessagesBefore: async (opts: { key: Uint8Array | null; beforeSeq: number }) => {
            olderCalls.push({ key: opts.key, beforeSeq: opts.beforeSeq });
            return olderPageFor(opts.key, opts.beforeSeq);
        },
        log: quiet,
        StaleFetchError,
        storage: { getState: () => state },
    });
    const x = new Sync();
    for (const p of ['sessionLastSeq', 'sessionOldestSeq', 'unopenableStrikes', 'unopenableGaps']) x[p] = new Map();
    x.fetchGen = new FetchGeneration();
    x.applyLifecycle = () => { };
    x.sessionsSync = { invalidate: () => { invalidated++; } };
    let key: Uint8Array | null = K1;
    x.v2ReadCtx = () => ({ base: 'b', v2SessionId: 'v', token: 't', key });
    x.encryption = { getSessionEncryption: () => ({}) };
    x.getSessionMessageLock = () => ({ inLock: (fn: () => Promise<void>) => fn() });
    x.applyFetchedMessages = async (_s: string, _e: unknown, m: { seq: number; id: string }[]) => { applied.push(...m); };
    const gaps = (): Range[] => x.unopenableGaps.get('A') ?? [];
    const sync = (fromSeq: number) => x.fetchForwardSince('A', {}, fromSeq, x.fetchGen.current('A'));
    return { x, calls, olderCalls, applied, published, gaps, sync, invalidated: () => invalidated, setKey: (k: Uint8Array | null) => { key = k; } };
}

/** Pages: seq 101 is sealed under K2; everything else is empty. */
function relayWithRowUnderK2(key: Uint8Array | null, afterSeq: number): Page {
    if (afterSeq === 100) {
        return key === K2
            ? { messages: [{ seq: 101, id: 'm101' }], lifecycle: [], cursor: 101, hasMore: false, unopenable: 0 }
            : { messages: [], lifecycle: [], cursor: 101, hasMore: false, unopenable: 1, unopenableSeqs: [101] };
    }
    return { messages: [], lifecycle: [], cursor: afterSeq, hasMore: false, unopenable: 0 };
}

/** One row per page, seqs 1..last, all sealed under `under`; empty past `last`. */
function oneRowPages(under: Uint8Array, last: number) {
    return (key: Uint8Array | null, afterSeq: number): Page => {
        if (afterSeq >= last) return { messages: [], lifecycle: [], cursor: afterSeq, hasMore: false, unopenable: 0 };
        const seq = afterSeq + 1;
        return key === under
            ? { messages: [{ seq, id: `m${seq}` }], lifecycle: [], cursor: seq, hasMore: true, unopenable: 0 }
            : { messages: [], lifecycle: [], cursor: seq, hasMore: true, unopenable: 1, unopenableSeqs: [seq] };
    };
}

async function exhaustRetries(x: any) {
    const gen = x.fetchGen.current('A');
    // MAX_UNOPENABLE_RETRIES present-key attempts throw "retrying"…
    for (let i = 0; i < 5; i++) {
        await expect(x.fetchForwardSince('A', {}, 100, gen)).rejects.toThrow(/could not be opened/);
    }
    // …then the sync advances past the row.
    await x.fetchForwardSince('A', {}, 100, gen);
    expect(x.sessionLastSeq.get('A')).toBe(101);
}

describe('forward sync keeps unopenable rows as a recoverable gap (#128)', () => {
    it('after the retry budget the range is recorded with the key that failed, not forgotten', async () => {
        const { x, applied, gaps, published } = build(relayWithRowUnderK2);
        await exhaustRetries(x);
        expect(applied).toEqual([]);
        expect(gaps()).toEqual([{ fromSeq: 100, toSeq: 101, keyId: id(K1), count: 1 }]);
        expect(published.at(-1)).toEqual([{ fromSeq: 100, toSeq: 101, count: 1 }]);
    });

    it('the same key is not retried on every later sync', async () => {
        const { x, calls, gaps, sync } = build(relayWithRowUnderK2);
        await exhaustRetries(x);
        calls.length = 0;
        await sync(101);
        expect(calls.map((c) => c.afterSeq)).toEqual([101]);
        expect(gaps()).toHaveLength(1);
    });

    it('a key correction re-reads the gap, lands its rows, and closes it', async () => {
        const { x, calls, applied, gaps, published, sync, setKey } = build(relayWithRowUnderK2);
        await exhaustRetries(x);
        calls.length = 0;
        setKey(K2); // the card's envelope was corrected
        await sync(101);
        expect(calls.map((c) => c.afterSeq)).toEqual([100, 101]); // the gap first, then the head
        expect(calls[0].key).toBe(K2);
        expect(applied).toEqual([{ seq: 101, id: 'm101' }]);
        expect(gaps()).toEqual([]);
        expect(published.at(-1)).toEqual([]); // the placeholder row goes with it
        expect(x.sessionLastSeq.get('A')).toBe(101);
    });

    it('a different but still-wrong key keeps the gap and is itself not retried until the key changes again', async () => {
        const { x, calls, applied, gaps, sync, setKey } = build(relayWithRowUnderK2);
        await exhaustRetries(x);
        setKey(K3);
        calls.length = 0;
        await sync(101);
        expect(calls.map((c) => c.afterSeq)).toEqual([100, 101]);
        expect(applied).toEqual([]);
        expect(gaps()).toEqual([{ fromSeq: 100, toSeq: 101, keyId: id(K3), count: 1 }]); // stamped with K3 now
        calls.length = 0;
        await sync(101);
        expect(calls.map((c) => c.afterSeq)).toEqual([101]); // K3 already tried
        setKey(K2);
        await sync(101);
        expect(applied).toEqual([{ seq: 101, id: 'm101' }]);
        expect(gaps()).toEqual([]);
    });

    it('a missing key never spends the budget and never records a gap', async () => {
        const { x, gaps, setKey } = build(relayWithRowUnderK2);
        setKey(null);
        const gen = x.fetchGen.current('A');
        for (let i = 0; i < 8; i++) {
            await expect(x.fetchForwardSince('A', {}, 100, gen)).rejects.toThrow(/no content key yet/);
        }
        expect(gaps()).toEqual([]);
        expect(x.sessionLastSeq.has('A')).toBe(false);
    });

    it('a gap replay that is reset mid-flight writes nothing', async () => {
        const { x, applied, gaps, setKey } = build(relayWithRowUnderK2);
        await exhaustRetries(x);
        setKey(K2);
        const gen = x.fetchGen.current('A');
        x.fetchGen.bump('A'); // reset before the replay's first page lands
        await expect(x.fetchForwardSince('A', {}, 101, gen)).rejects.toBeInstanceOf(StaleFetchError);
        expect(applied).toEqual([]);
        expect(gaps()).toHaveLength(1);
    });
});

describe('a replay that runs out of budget keeps a continuation cursor (#128 a)', () => {
    it('five one-row pages of a 0..10 gap recover 1..5 and leave 6..10 for the next sync, not deleted', async () => {
        const { x, calls, applied, gaps, published, sync, setKey } = build(oneRowPages(K2, 10));
        x.recordUnopenableGap('A', 0, 10, K1, 10);
        setKey(K2);
        await sync(10);
        expect(applied.map((m) => m.seq)).toEqual([1, 2, 3, 4, 5]);
        expect(calls.map((c) => c.afterSeq)).toEqual([0, 1, 2, 3, 4, 10]); // MAX_FORWARD_CATCHUP_PAGES, then the head
        // The unvisited remainder keeps the OLD stamp: that is the cursor.
        expect(gaps()).toEqual([{ fromSeq: 5, toSeq: 10, keyId: id(K1), count: 5 }]);
        expect(published.at(-1)).toEqual([{ fromSeq: 5, toSeq: 10, count: 5 }]);

        calls.length = 0;
        await sync(10);
        expect(applied.map((m) => m.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
        expect(calls.map((c) => c.afterSeq)).toEqual([5, 6, 7, 8, 9, 10]);
        expect(gaps()).toEqual([]);
        expect(published.at(-1)).toEqual([]);

        calls.length = 0;
        await sync(10);
        expect(calls.map((c) => c.afterSeq)).toEqual([10]); // nothing left to replay
    });

    it('a page still sealed under the new key is stamped with it while the remainder keeps the old stamp', async () => {
        // Under K2 rows 1..3 open, row 4 stays sealed, 5..10 open.
        const relay = (key: Uint8Array | null, afterSeq: number): Page => {
            if (afterSeq >= 10) return { messages: [], lifecycle: [], cursor: afterSeq, hasMore: false, unopenable: 0 };
            const seq = afterSeq + 1;
            if (seq === 4 || key !== K2) return { messages: [], lifecycle: [], cursor: seq, hasMore: true, unopenable: 1, unopenableSeqs: [seq] };
            return { messages: [{ seq, id: `m${seq}` }], lifecycle: [], cursor: seq, hasMore: true, unopenable: 0 };
        };
        const { x, applied, gaps, sync, setKey } = build(relay);
        x.recordUnopenableGap('A', 0, 10, K1, 10);
        setKey(K2);
        await sync(10);
        expect(applied.map((m) => m.seq)).toEqual([1, 2, 3, 5]);
        expect(gaps()).toEqual([
            { fromSeq: 3, toSeq: 4, keyId: id(K2), count: 1 },
            { fromSeq: 5, toSeq: 10, keyId: id(K1), count: 5 },
        ]);
        await sync(10);
        expect(applied.map((m) => m.seq)).toEqual([1, 2, 3, 5, 6, 7, 8, 9, 10]);
        expect(gaps()).toEqual([{ fromSeq: 3, toSeq: 4, keyId: id(K2), count: 1 }]); // K2 tried it: waits for another key
        setKey(K3);
        await sync(10);
        expect(gaps()).toEqual([{ fromSeq: 3, toSeq: 4, keyId: id(K3), count: 1 }]);
    });
});

describe('a replay settles only the rows inside its range (#128 F5)', () => {
    /** Under K2 seq 1 opens and seq 2 (past the range) is sealed; K3 opens both. */
    const relay = (key: Uint8Array | null, afterSeq: number): Page => {
        const rows = [1, 2].filter((seq) => seq > afterSeq);
        const opened = rows.filter((seq) => key === K3 || (key === K2 && seq === 1));
        const failed = rows.filter((seq) => !opened.includes(seq));
        return { messages: opened.map((seq) => ({ seq, id: `m${seq}` })), lifecycle: [], cursor: rows.at(-1) ?? afterSeq, hasMore: false, unopenable: failed.length, unopenableSeqs: failed };
    };

    it('gap (0,1]: K2 opens seq 1 but fails seq 2 → (0,1] is gone and (1,2] is its own range, not a K2 re-stamp of the recovered gap', async () => {
        const { x, calls, applied, gaps, published, sync, setKey } = build(relay);
        x.recordUnopenableGap('A', 0, 1, K1, 1);
        setKey(K2);
        await sync(2); // head is 2: the forward read stepped over seq 2 already
        expect(calls.map((c) => c.afterSeq)).toEqual([0, 2]);
        expect(applied.map((m) => m.seq)).toEqual([1]);
        expect(gaps()).toEqual([{ fromSeq: 1, toSeq: 2, keyId: id(K2), count: 1 }]);
        expect(published.at(-1)).toEqual([{ fromSeq: 1, toSeq: 2, count: 1 }]);

        calls.length = 0;
        await sync(2);
        expect(calls.map((c) => c.afterSeq)).toEqual([2]); // seq 1 is history; (1,2] waits for another key

        setKey(K3);
        calls.length = 0;
        await sync(2);
        expect(calls.map((c) => c.afterSeq)).toEqual([1, 2]);
        expect(applied.map((m) => m.seq)).toEqual([1, 2]);
        expect(gaps()).toEqual([]);
    });

    it('a failure past the head is left to the forward read, which retries it and records it after the budget', async () => {
        const { x, applied, gaps, sync, setKey } = build(relay);
        x.recordUnopenableGap('A', 0, 1, K1, 1);
        setKey(K2);
        const gen = x.fetchGen.current('A');
        // Head is 1: the replay recovers seq 1, then the forward page after
        // 1 meets seq 2 sealed — that is the forward path's retry budget.
        for (let i = 0; i < 5; i++) {
            await expect(x.fetchForwardSince('A', {}, 1, gen)).rejects.toThrow(/could not be opened/);
            expect(gaps()).toEqual([]);
        }
        await sync(1);
        expect(applied.map((m) => m.seq)).toEqual([1]);
        expect(x.sessionLastSeq.get('A')).toBe(2);
        expect(gaps()).toEqual([{ fromSeq: 1, toSeq: 2, keyId: id(K2), count: 1 }]);
    });

    it('a failure past the range that another recorded range holds is left to that range', async () => {
        const { x, calls, gaps, sync, setKey } = build(relay);
        x.recordUnopenableGap('A', 0, 1, K1, 1);
        x.recordUnopenableGap('A', 1, 2, K3, 1); // seq 2 already waits for a key other than K3
        setKey(K2);
        await sync(2);
        expect(calls.map((c) => c.afterSeq)).toEqual([0, 1, 2]); // both ranges replay under K2
        expect(gaps()).toEqual([{ fromSeq: 1, toSeq: 2, keyId: id(K2), count: 1 }]);
    });
});

describe('older pages that could not be opened record a gap (#128 b)', () => {
    it('loadOlderMessages advancing past an unopenable page records its span and pulls the card', async () => {
        const older = (_key: Uint8Array | null, beforeSeq: number): Page =>
            ({ messages: [], lifecycle: [], cursor: 1, hasMore: false, unopenable: 3, unopenableSeqs: [1, 50, 100] });
        const { x, olderCalls, gaps, published, invalidated } = build(relayWithRowUnderK2, older);
        x.sessionOldestSeq.set('A', 101);
        await x.loadOlderMessages('A');
        expect(olderCalls.map((c) => c.beforeSeq)).toEqual([101]);
        expect(x.sessionOldestSeq.get('A')).toBe(1); // still advances: scrolling is never wedged
        expect(gaps()).toEqual([{ fromSeq: 0, toSeq: 100, keyId: id(K1), count: 3 }]);
        expect(published.at(-1)).toEqual([{ fromSeq: 0, toSeq: 100, count: 3 }]);
        expect(invalidated()).toBe(1);
    });

    it('a page that opened some rows records the span of the rows that failed, and a key change re-reads it', async () => {
        const older = (): Page => ({ messages: [{ seq: 60, id: 'm60' }], lifecycle: [], cursor: 40, hasMore: true, unopenable: 2, unopenableSeqs: [40, 100] });
        const relay = (key: Uint8Array | null, afterSeq: number): Page => {
            if (afterSeq === 39 && key === K2) return { messages: [{ seq: 41, id: 'm41' }, { seq: 60, id: 'm60' }], lifecycle: [], cursor: 100, hasMore: true, unopenable: 0 };
            return { messages: [], lifecycle: [], cursor: afterSeq, hasMore: false, unopenable: 0 };
        };
        const { x, applied, calls, gaps, sync, setKey } = build(relay, older);
        x.sessionOldestSeq.set('A', 101);
        await x.loadOlderMessages('A');
        expect(applied.map((m) => m.seq)).toEqual([60]);
        expect(x.sessionOldestSeq.get('A')).toBe(40);
        expect(gaps()).toEqual([{ fromSeq: 39, toSeq: 100, keyId: id(K1), count: 2 }]);

        setKey(K2);
        await sync(100);
        expect(calls.map((c) => c.afterSeq)).toEqual([39, 100]);
        expect(applied.map((m) => m.seq)).toEqual([60, 41, 60]);
        expect(gaps()).toEqual([]);
    });

    it('a trimmed older page blames only the row that failed, not the rows it returned (#128 F5)', async () => {
        // 200 rows, seq 1 sealed under another key. The reader walks back
        // from 201, trims to the newest 100 (101..200, cursor 101), and
        // names seq 1 as the failure — far below the returned span.
        const older = (): Page => ({
            messages: Array.from({ length: 100 }, (_, i) => ({ seq: 101 + i, id: `m${101 + i}` })),
            lifecycle: [], cursor: 101, hasMore: true, unopenable: 1, unopenableSeqs: [1],
        });
        const { x, applied, gaps, published } = build(relayWithRowUnderK2, older);
        x.sessionOldestSeq.set('A', 201);
        await x.loadOlderMessages('A');
        expect(applied).toHaveLength(100);
        expect(applied.every((m) => m.seq >= 101)).toBe(true);
        expect(x.sessionOldestSeq.get('A')).toBe(101);
        expect(gaps()).toEqual([{ fromSeq: 0, toSeq: 1, keyId: id(K1), count: 1 }]); // exactly seq 1
        expect(published.at(-1)).toEqual([{ fromSeq: 0, toSeq: 1, count: 1 }]); // no placeholder over 101..200
    });

    it('a forward page past the retry budget keeps only the rows that failed, not the rows beside them', async () => {
        // Under K1 seq 102 is sealed; 101 and 103 open. After the budget the
        // gap is (101, 102], and 101/103 land as history.
        const relay = (key: Uint8Array | null, afterSeq: number): Page => {
            if (afterSeq !== 100) return { messages: [], lifecycle: [], cursor: afterSeq, hasMore: false, unopenable: 0, unopenableSeqs: [] };
            return key === K2
                ? { messages: [{ seq: 101, id: 'm101' }, { seq: 102, id: 'm102' }, { seq: 103, id: 'm103' }], lifecycle: [], cursor: 103, hasMore: false, unopenable: 0, unopenableSeqs: [] }
                : { messages: [{ seq: 101, id: 'm101' }, { seq: 103, id: 'm103' }], lifecycle: [], cursor: 103, hasMore: false, unopenable: 1, unopenableSeqs: [102] };
        };
        const { x, applied, gaps } = build(relay);
        const gen = x.fetchGen.current('A');
        for (let i = 0; i < 5; i++) {
            await expect(x.fetchForwardSince('A', {}, 100, gen)).rejects.toThrow(/could not be opened/);
        }
        await x.fetchForwardSince('A', {}, 100, gen);
        expect(x.sessionLastSeq.get('A')).toBe(103);
        expect(applied.map((m) => m.seq)).toEqual([101, 103]);
        expect(gaps()).toEqual([{ fromSeq: 101, toSeq: 102, keyId: id(K1), count: 1 }]);
    });

    it('a clean older page records nothing', async () => {
        const older = (): Page => ({ messages: [{ seq: 50, id: 'm50' }], lifecycle: [], cursor: 50, hasMore: true, unopenable: 0 });
        const { x, gaps, published, invalidated } = build(relayWithRowUnderK2, older);
        x.sessionOldestSeq.set('A', 101);
        await x.loadOlderMessages('A');
        expect(gaps()).toEqual([]);
        expect(published).toEqual([]);
        expect(invalidated()).toBe(0);
    });
});

describe('blocked ranges are tracked per key version (#128 c)', () => {
    it('ranges under different keys coexist; adjacent ranges merge only under the same key', () => {
        const { x, gaps } = build(relayWithRowUnderK2);
        x.recordUnopenableGap('A', 100, 200, K1, 4);
        x.recordUnopenableGap('A', 300, 400, K2, 2);
        expect(gaps()).toEqual([
            { fromSeq: 100, toSeq: 200, keyId: id(K1), count: 4 },
            { fromSeq: 300, toSeq: 400, keyId: id(K2), count: 2 },
        ]);
        x.recordUnopenableGap('A', 200, 300, K1, 4); // adjacent, same key: one range
        expect(gaps()).toEqual([
            { fromSeq: 100, toSeq: 300, keyId: id(K1), count: 8 },
            { fromSeq: 300, toSeq: 400, keyId: id(K2), count: 2 }, // adjacent, other key: kept apart
        ]);
        x.recordUnopenableGap('A', 100, 300, K1, 5); // the same rows again under K1: not counted twice
        expect(gaps()[0]).toEqual({ fromSeq: 100, toSeq: 300, keyId: id(K1), count: 8 });
    });

    it('a failure under a later key replaces only the rows it overlaps', () => {
        const { x, gaps } = build(relayWithRowUnderK2);
        x.recordUnopenableGap('A', 100, 300, K1, 8);
        x.recordUnopenableGap('A', 150, 250, K3, 1);
        expect(gaps()).toEqual([
            { fromSeq: 100, toSeq: 150, keyId: id(K1), count: 2 },
            { fromSeq: 150, toSeq: 250, keyId: id(K3), count: 1 },
            { fromSeq: 250, toSeq: 300, keyId: id(K1), count: 2 },
        ]);
    });

    it('a new failure never replaces unfinished work on an earlier range, and each range replays under its own stamp', async () => {
        // 1..10 sealed under K1, then 21..30 sealed under K2; K3 opens everything.
        const relay = (key: Uint8Array | null, afterSeq: number): Page => {
            if (afterSeq >= 30) return { messages: [], lifecycle: [], cursor: afterSeq, hasMore: false, unopenable: 0 };
            const seq = afterSeq + 1;
            return key === K3
                ? { messages: [{ seq, id: `m${seq}` }], lifecycle: [], cursor: seq, hasMore: true, unopenable: 0 }
                : { messages: [], lifecycle: [], cursor: seq, hasMore: true, unopenable: 1, unopenableSeqs: [seq] };
        };
        const { x, applied, calls, gaps, sync, setKey } = build(relay);
        x.recordUnopenableGap('A', 0, 10, K1, 10);
        setKey(K2);
        await sync(30); // budget: 1..5 stay sealed under K2, 6..10 untouched
        expect(gaps()).toEqual([
            { fromSeq: 0, toSeq: 5, keyId: id(K2), count: 5 },
            { fromSeq: 5, toSeq: 10, keyId: id(K1), count: 5 },
        ]);
        x.recordUnopenableGap('A', 20, 30, K2, 10); // a forward failure under K2 lands beside, not over
        expect(gaps()).toEqual([
            { fromSeq: 0, toSeq: 5, keyId: id(K2), count: 5 },
            { fromSeq: 5, toSeq: 10, keyId: id(K1), count: 5 },
            { fromSeq: 20, toSeq: 30, keyId: id(K2), count: 10 },
        ]);

        setKey(K3);
        calls.length = 0;
        await sync(30); // five pages: 1..5 open; the rest waits
        expect(applied.map((m) => m.seq)).toEqual([1, 2, 3, 4, 5]);
        expect(gaps()).toEqual([
            { fromSeq: 5, toSeq: 10, keyId: id(K1), count: 5 },
            { fromSeq: 20, toSeq: 30, keyId: id(K2), count: 10 },
        ]);
        await sync(30); // 6..10
        expect(gaps()).toEqual([{ fromSeq: 20, toSeq: 30, keyId: id(K2), count: 10 }]);
        await sync(30); // 21..25
        expect(gaps()).toEqual([{ fromSeq: 25, toSeq: 30, keyId: id(K2), count: 5 }]);
        await sync(30); // 26..30
        expect(gaps()).toEqual([]);
        expect(applied.map((m) => m.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30]);
    });
});
