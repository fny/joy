/**
 * #128 — sealed rows the forward sync cannot open with the key it has are
 * kept as a recoverable GAP, not dropped: after the retry budget the cursor
 * advances (one bad row must not wedge the session), but the range is
 * remembered with the key it failed under and re-read once the session's
 * key changes. Run against the REAL class members (syncMembers.testutil.ts).
 */
import { describe, it, expect } from 'vitest';
import { FetchGeneration, StaleFetchError } from './sessionSyncGuards';
import { buildSyncSubset } from './syncMembers.testutil';

const quiet = { log: () => { } };
const K1 = new Uint8Array(32).fill(1);
const K2 = new Uint8Array(32).fill(2);
const K3 = new Uint8Array(32).fill(3);

type Page = { messages: { seq: number; id: string }[]; lifecycle: never[]; cursor: number; hasMore: boolean; unopenable?: number };

function build(pageFor: (key: Uint8Array | null, afterSeq: number) => Page) {
    const calls: { key: Uint8Array | null; afterSeq: number }[] = [];
    const applied: { seq: number; id: string }[] = [];
    const Sync = buildSyncSubset(['fetchForwardSince', 'assertFresh', 'replayUnopenableGap', 'recordUnopenableGap', 'keyId'], {
        v2MessagesAfter: async (opts: { key: Uint8Array | null; afterSeq: number }) => {
            calls.push({ key: opts.key, afterSeq: opts.afterSeq });
            return pageFor(opts.key, opts.afterSeq);
        },
        log: quiet,
        StaleFetchError,
    });
    const x = new Sync();
    for (const p of ['sessionLastSeq', 'unopenableStrikes', 'unopenableGaps']) x[p] = new Map();
    x.fetchGen = new FetchGeneration();
    x.applyLifecycle = () => { };
    x.sessionsSync = { invalidate: () => { } };
    let key: Uint8Array | null = K1;
    x.v2ReadCtx = () => ({ base: 'b', v2SessionId: 'v', token: 't', key });
    x.applyFetchedMessages = async (_s: string, _e: unknown, m: { seq: number; id: string }[]) => { applied.push(...m); };
    return { x, calls, applied, setKey: (k: Uint8Array | null) => { key = k; } };
}

/** Pages: seq 101 is sealed under K2; everything else is empty. */
function relayWithRowUnderK2(key: Uint8Array | null, afterSeq: number): Page {
    if (afterSeq === 100) {
        return key === K2
            ? { messages: [{ seq: 101, id: 'm101' }], lifecycle: [], cursor: 101, hasMore: false, unopenable: 0 }
            : { messages: [], lifecycle: [], cursor: 101, hasMore: false, unopenable: 1 };
    }
    return { messages: [], lifecycle: [], cursor: afterSeq, hasMore: false, unopenable: 0 };
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
        const { x, applied } = build(relayWithRowUnderK2);
        await exhaustRetries(x);
        expect(applied).toEqual([]);
        expect(x.unopenableGaps.get('A')).toEqual({ fromSeq: 100, toSeq: 101, keyId: expect.any(String) });
    });

    it('the same key is not retried on every later sync', async () => {
        const { x, calls } = build(relayWithRowUnderK2);
        await exhaustRetries(x);
        calls.length = 0;
        await x.fetchForwardSince('A', {}, 101, x.fetchGen.current('A'));
        expect(calls.map((c) => c.afterSeq)).toEqual([101]);
        expect(x.unopenableGaps.has('A')).toBe(true);
    });

    it('a key correction re-reads the gap, lands its rows, and closes it', async () => {
        const { x, calls, applied, setKey } = build(relayWithRowUnderK2);
        await exhaustRetries(x);
        calls.length = 0;
        setKey(K2); // the card's envelope was corrected
        await x.fetchForwardSince('A', {}, 101, x.fetchGen.current('A'));
        expect(calls.map((c) => c.afterSeq)).toEqual([100, 101]); // the gap first, then the head
        expect(calls[0].key).toBe(K2);
        expect(applied).toEqual([{ seq: 101, id: 'm101' }]);
        expect(x.unopenableGaps.has('A')).toBe(false);
        expect(x.sessionLastSeq.get('A')).toBe(101);
    });

    it('a different but still-wrong key keeps the gap and is itself not retried until the key changes again', async () => {
        const { x, calls, applied, setKey } = build(relayWithRowUnderK2);
        await exhaustRetries(x);
        const failedUnder = x.unopenableGaps.get('A').keyId;
        setKey(K3);
        calls.length = 0;
        await x.fetchForwardSince('A', {}, 101, x.fetchGen.current('A'));
        expect(calls.map((c) => c.afterSeq)).toEqual([100, 101]);
        expect(applied).toEqual([]);
        const gap = x.unopenableGaps.get('A');
        expect(gap.fromSeq).toBe(100);
        expect(gap.keyId).not.toBe(failedUnder); // stamped with K3 now
        calls.length = 0;
        await x.fetchForwardSince('A', {}, 101, x.fetchGen.current('A'));
        expect(calls.map((c) => c.afterSeq)).toEqual([101]); // K3 already tried
        setKey(K2);
        await x.fetchForwardSince('A', {}, 101, x.fetchGen.current('A'));
        expect(applied).toEqual([{ seq: 101, id: 'm101' }]);
        expect(x.unopenableGaps.has('A')).toBe(false);
    });

    it('a missing key never spends the budget and never records a gap', async () => {
        const { x, setKey } = build(relayWithRowUnderK2);
        setKey(null);
        const gen = x.fetchGen.current('A');
        for (let i = 0; i < 8; i++) {
            await expect(x.fetchForwardSince('A', {}, 100, gen)).rejects.toThrow(/no content key yet/);
        }
        expect(x.unopenableGaps.has('A')).toBe(false);
        expect(x.sessionLastSeq.has('A')).toBe(false);
    });

    it('a gap replay that is reset mid-flight writes nothing', async () => {
        const { x, applied, setKey } = build(relayWithRowUnderK2);
        await exhaustRetries(x);
        setKey(K2);
        const gen = x.fetchGen.current('A');
        x.fetchGen.bump('A'); // reset before the replay's first page lands
        await expect(x.fetchForwardSince('A', {}, 101, gen)).rejects.toBeInstanceOf(StaleFetchError);
        expect(applied).toEqual([]);
        expect(x.unopenableGaps.has('A')).toBe(true);
    });
});
