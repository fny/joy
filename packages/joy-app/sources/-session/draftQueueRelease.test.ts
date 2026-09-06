import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Environment stubs ───────────────────────────────────────────────────────
const sessions: Record<string, { thinking?: boolean; presence?: string; metadata?: { joy__source?: string } }> = {};
const storageSubscribers: Array<() => void> = [];
vi.mock('@/sync/storage', () => ({
    storage: {
        getState: () => ({ sessions }),
        subscribe: (fn: () => void) => { storageSubscribers.push(fn); return () => {}; },
    },
    isFresh: () => true,
}));
vi.mock('@/sync/storageTypes', () => ({ isJoyDaemonSource: () => true }));
vi.mock('@/sync/serverConfig', () => {
    const mem = new Map<string, string>();
    return { relayScopedMMKV: () => ({ getString: (k: string) => mem.get(k), set: (k: string, v: string) => { mem.set(k, v); } }) };
});
let uuidN = 0;
vi.mock('expo-crypto', () => ({ randomUUID: () => `L${++uuidN}` }));

import { useDraftQueueStore } from './draftQueue';
import { attemptOwnsDraft, cancelRelease, initDraftQueueRelease, isCancelPending, notifyOutboxAcked } from './draftQueueRelease';

type Deferred = { resolve: (v: { ok: true; localId: string } | { ok: false; reason: string }) => void; reject: (e: unknown) => void; localId: string; text: string };
const sends: Deferred[] = [];
const send = vi.fn((_sid: string, text: string, localId: string) => new Promise<{ ok: true; localId: string } | { ok: false; reason: string }>((resolve, reject) => {
    sends.push({ resolve, reject, localId, text });
}));

const S = 'session-1';
const drafts = () => useDraftQueueStore.getState().bySession[S] ?? [];
const head = () => drafts()[0];

// The release pass is deferred with setTimeout(0). Under fake timers a timer
// created INSIDE another timer's callback is due at now+1, so drains advance
// a few ms rather than 0.
const TICK = 5;

/** One sweep of the release pass (the store/storage subscription defers it a tick). */
async function sweep() {
    storageSubscribers[0]();
    await vi.advanceTimersByTimeAsync(TICK);
}

// The module keeps per-session release backstops (inFlightUntil) across
// tests; each test starts well past the previous one's horizon.
let clock = new Date('2026-09-06T00:00:00Z').getTime();
beforeEach(() => {
    vi.useFakeTimers();
    clock += 10 * 60_000;
    vi.setSystemTime(clock);
    sessions[S] = { thinking: false, presence: 'online', metadata: { joy__source: 'joy-daemon' } };
    useDraftQueueStore.setState({ bySession: {} });
    sends.length = 0;
    send.mockClear();
    initDraftQueueRelease(send); // idempotent after the first call
});
afterEach(async () => {
    // Drain the deferred sweep a trailing store update scheduled: dropping it
    // with the fake clock would leave the module's `scheduled` latch set.
    await vi.advanceTimersByTimeAsync(TICK);
    vi.useRealTimers();
});

describe('attemptOwnsDraft (#133)', () => {
    const d = { state: 'releasing' as const, releaseLocalId: 'L1' };
    it('owns only while token, state and release identity all match', () => {
        expect(attemptOwnsDraft(d, 'L1', 7, 7)).toBe(true);
        expect(attemptOwnsDraft(d, 'L1', 7, 8)).toBe(false); // a newer attempt took over
        expect(attemptOwnsDraft(d, 'L9', 7, 7)).toBe(false); // edited: new release identity
        expect(attemptOwnsDraft({ ...d, state: 'queued' }, 'L1', 7, 7)).toBe(false);
        expect(attemptOwnsDraft(undefined, 'L1', 7, 7)).toBe(false);
    });
});

describe('draft release fencing (#133)', () => {
    it("a late failure of text A does not revert text B's own release", async () => {
        useDraftQueueStore.getState().add(S, 'A', 'busy');
        await sweep();
        expect(sends).toHaveLength(1);
        expect(head().state).toBe('releasing');
        const l1 = head().releaseLocalId!;

        // Edit to B while A's request is pending: reclaims the draft.
        useDraftQueueStore.getState().update(S, head().id, 'B');
        expect(head().releaseLocalId).toBeUndefined();

        // Past the 15s backstop the sweep releases B with a fresh identity.
        await vi.advanceTimersByTimeAsync(16_000);
        await sweep();
        expect(sends).toHaveLength(2);
        const l2 = head().releaseLocalId!;
        expect(l2).not.toBe(l1);
        expect(head().state).toBe('releasing');

        // A fails late.
        sends[0].reject(new Error('relay 500'));
        await vi.advanceTimersByTimeAsync(TICK);
        expect(head().state).toBe('releasing'); // B untouched
        expect(head().lastError).toBeUndefined();
        expect(head().releaseLocalId).toBe(l2);

        // B's acknowledgement removes it.
        notifyOutboxAcked(S, [l2]);
        expect(drafts()).toHaveLength(0);
    });

    it('a failure of the current attempt still reverts it', async () => {
        useDraftQueueStore.getState().add(S, 'A', 'busy');
        await sweep();
        sends[0].resolve({ ok: false, reason: 'offline' });
        await vi.advanceTimersByTimeAsync(TICK);
        expect(head().state).toBe('queued');
        expect(head().attempt).toBe(1);
        expect(head().lastError).toBe('offline');
    });

    it('an ack for the current release identity is honoured even after a revert', async () => {
        useDraftQueueStore.getState().add(S, 'A', 'busy');
        await sweep();
        const l1 = head().releaseLocalId!;
        sends[0].reject(new Error('timeout'));
        await vi.advanceTimersByTimeAsync(TICK);
        expect(head().state).toBe('queued');
        expect(head().releaseLocalId).toBe(l1); // retries keep the identity
        notifyOutboxAcked(S, [l1]); // the first POST had landed after all
        expect(drafts()).toHaveLength(0);
    });

    it('an ack for a superseded identity is ignored', async () => {
        useDraftQueueStore.getState().add(S, 'A', 'busy');
        await sweep();
        const l1 = head().releaseLocalId!;
        useDraftQueueStore.getState().update(S, head().id, 'B');
        notifyOutboxAcked(S, [l1]);
        expect(drafts()).toHaveLength(1);
        expect(head().text).toBe('B');
    });
});

describe('removing an item while its send is in flight (#134)', () => {
    it('defers the removal until the send fails, then removes without a retry', async () => {
        useDraftQueueStore.getState().add(S, 'A', 'busy');
        await sweep();
        const id = head().id;
        expect(cancelRelease(S, id)).toBe('pending');
        expect(isCancelPending(S, id)).toBe(true);
        expect(drafts()).toHaveLength(1); // still visible

        sends[0].resolve({ ok: false, reason: 'offline' });
        await vi.advanceTimersByTimeAsync(TICK);
        expect(drafts()).toHaveLength(0);
        expect(isCancelPending(S, id)).toBe(false);
    });

    it('lets an accepted send leave the queue normally', async () => {
        useDraftQueueStore.getState().add(S, 'A', 'busy');
        await sweep();
        const id = head().id;
        const l1 = head().releaseLocalId!;
        expect(cancelRelease(S, id)).toBe('pending');
        notifyOutboxAcked(S, [l1]);
        expect(drafts()).toHaveLength(0);
        expect(isCancelPending(S, id)).toBe(false);
    });

    it('removes immediately when no send is in flight', () => {
        useDraftQueueStore.getState().add(S, 'A', 'busy');
        const id = head().id;
        expect(cancelRelease(S, id)).toBe('removed');
        expect(drafts()).toHaveLength(0);
    });

    it('removes immediately once the lease has expired', async () => {
        useDraftQueueStore.getState().add(S, 'A', 'busy');
        await sweep();
        const id = head().id;
        await vi.advanceTimersByTimeAsync(31_000);
        expect(cancelRelease(S, id)).toBe('removed');
        expect(drafts()).toHaveLength(0);
    });
});
