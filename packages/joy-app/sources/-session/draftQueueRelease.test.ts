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
import { attemptOwnsDraft, cancelRelease, initDraftQueueRelease, isCancelPending, notifyOutboxAcked, settleAcceptedRelease } from './draftQueueRelease';

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
        notifyOutboxAcked(S, [{ localId: l2 }]);
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
        notifyOutboxAcked(S, [{ localId: l1 }]); // the first POST had landed after all
        expect(drafts()).toHaveLength(0);
    });

    it('an ack for a superseded identity is ignored', async () => {
        useDraftQueueStore.getState().add(S, 'A', 'busy');
        await sweep();
        const l1 = head().releaseLocalId!;
        useDraftQueueStore.getState().update(S, head().id, 'B');
        notifyOutboxAcked(S, [{ localId: l1 }]);
        expect(drafts()).toHaveLength(1);
        expect(head().text).toBe('B');
    });
});

describe('removing an item while its send is in flight (#134)', () => {
    const cancelTurn = vi.fn<(sessionId: string, turnId: string) => Promise<void>>();
    beforeEach(() => { cancelTurn.mockReset(); });

    it('defers the removal until the send fails, then removes without a retry or a cancel', async () => {
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
        expect(cancelTurn).not.toHaveBeenCalled(); // nothing reached the relay
    });

    it('cancels the accepted turn, then removes the draft', async () => {
        cancelTurn.mockResolvedValue(undefined);
        useDraftQueueStore.getState().add(S, 'A', 'busy');
        await sweep();
        const id = head().id;
        const l1 = head().releaseLocalId!;
        expect(cancelRelease(S, id)).toBe('pending');

        notifyOutboxAcked(S, [{ localId: l1, turnId: 'turn-1' }], cancelTurn);
        expect(cancelTurn).toHaveBeenCalledWith(S, 'turn-1');
        expect(drafts()).toHaveLength(1); // not gone until the cancel lands
        expect(isCancelPending(S, id)).toBe(true);
        expect(cancelRelease(S, id)).toBe('pending'); // a second × waits too

        await vi.advanceTimersByTimeAsync(TICK);
        expect(drafts()).toHaveLength(0);
        expect(isCancelPending(S, id)).toBe(false);
    });

    it('a failed cancel keeps the draft visible with the error and parks it', async () => {
        cancelTurn.mockRejectedValue(new Error('http_409'));
        useDraftQueueStore.getState().add(S, 'A', 'busy');
        await sweep();
        const id = head().id;
        const l1 = head().releaseLocalId!;
        expect(cancelRelease(S, id)).toBe('pending');

        notifyOutboxAcked(S, [{ localId: l1, turnId: 'turn-1' }], cancelTurn);
        await vi.advanceTimersByTimeAsync(TICK);
        expect(cancelTurn).toHaveBeenCalledWith(S, 'turn-1');
        expect(drafts()).toHaveLength(1);
        expect(head().state).toBe('queued');
        expect(head().lastError).toBe('cancel failed: http_409');
        expect(isCancelPending(S, id)).toBe(false);

        // Parked: sweeps do not resend the accepted message...
        await vi.advanceTimersByTimeAsync(31_000);
        await sweep();
        expect(sends).toHaveLength(1);
        // ...and × now removes locally.
        expect(cancelRelease(S, id)).toBe('removed');
        expect(drafts()).toHaveLength(0);
    });

    it('a manual retry of a parked draft resends with the same identity; its ack removes it', async () => {
        cancelTurn.mockRejectedValue(new Error('http_409'));
        useDraftQueueStore.getState().add(S, 'A', 'busy');
        await sweep();
        const id = head().id;
        const l1 = head().releaseLocalId!;
        cancelRelease(S, id);
        notifyOutboxAcked(S, [{ localId: l1, turnId: 'turn-1' }], cancelTurn);
        await vi.advanceTimersByTimeAsync(TICK);
        expect(head().lastError).toBe('cancel failed: http_409');

        useDraftQueueStore.getState().retryRelease(S, id);
        await vi.advanceTimersByTimeAsync(16_000); // past the per-session release backstop
        await sweep();
        expect(sends).toHaveLength(2);
        expect(sends[1].localId).toBe(l1); // the relay replays the first acceptance
        notifyOutboxAcked(S, [{ localId: l1, turnId: 'turn-1' }], cancelTurn);
        expect(drafts()).toHaveLength(0); // no pending removal any more: plain ack
        expect(cancelTurn).toHaveBeenCalledTimes(1);
    });

    it('an ack without a turnId cannot cancel: kept with the error, no cancel call', async () => {
        useDraftQueueStore.getState().add(S, 'A', 'busy');
        await sweep();
        const id = head().id;
        const l1 = head().releaseLocalId!;
        expect(cancelRelease(S, id)).toBe('pending');
        notifyOutboxAcked(S, [{ localId: l1 }], cancelTurn);
        await vi.advanceTimersByTimeAsync(TICK);
        expect(cancelTurn).not.toHaveBeenCalled();
        expect(drafts()).toHaveLength(1);
        expect(head().lastError).toMatch(/^cancel failed: /);
        expect(isCancelPending(S, id)).toBe(false);
    });

    it('an accepted send with no pending removal leaves the queue at once, no cancel', async () => {
        useDraftQueueStore.getState().add(S, 'A', 'busy');
        await sweep();
        const l1 = head().releaseLocalId!;
        notifyOutboxAcked(S, [{ localId: l1, turnId: 'turn-1' }], cancelTurn);
        expect(drafts()).toHaveLength(0);
        expect(cancelTurn).not.toHaveBeenCalled();
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

describe('settleAcceptedRelease (#134, pure)', () => {
    const cancelTurn = vi.fn<(sessionId: string, turnId: string) => Promise<void>>();
    beforeEach(() => { cancelTurn.mockReset(); });

    /** A draft holding a live release lease, so cancelRelease records a pending removal. */
    function releasing(): string {
        useDraftQueueStore.getState().add(S, 'A', 'busy');
        const id = head().id;
        useDraftQueueStore.getState().markReleasing(S, id, 'L-x', Date.now() + 30_000);
        return id;
    }

    it('no pending cancel → removed synchronously, cancel untouched', async () => {
        const id = releasing();
        const outcome = settleAcceptedRelease(S, id, 'turn-1', cancelTurn);
        expect(drafts()).toHaveLength(0);
        await expect(outcome).resolves.toBe('removed');
        expect(cancelTurn).not.toHaveBeenCalled();
    });

    it('pending cancel + accepted → cancel called with the turnId, then removed', async () => {
        cancelTurn.mockResolvedValue(undefined);
        const id = releasing();
        expect(cancelRelease(S, id)).toBe('pending');
        const outcome = settleAcceptedRelease(S, id, 'turn-1', cancelTurn);
        expect(cancelTurn).toHaveBeenCalledWith(S, 'turn-1');
        expect(drafts()).toHaveLength(1);
        await expect(outcome).resolves.toBe('cancelled');
        expect(drafts()).toHaveLength(0);
        expect(isCancelPending(S, id)).toBe(false);
    });

    it('pending cancel + cancel rejects → kept, queued, with the error', async () => {
        cancelTurn.mockRejectedValue(new Error('different_turn_active'));
        const id = releasing();
        cancelRelease(S, id);
        await expect(settleAcceptedRelease(S, id, 'turn-1', cancelTurn)).resolves.toBe('cancel_failed');
        expect(drafts()).toHaveLength(1);
        expect(head().state).toBe('queued');
        expect(head().lastError).toBe('cancel failed: different_turn_active');
        expect(isCancelPending(S, id)).toBe(false);
    });

    it('a second ack while the cancel is in flight does not fire a second cancel', async () => {
        let release!: () => void;
        cancelTurn.mockImplementation(() => new Promise<void>((r) => { release = r; }));
        const id = releasing();
        cancelRelease(S, id);
        const first = settleAcceptedRelease(S, id, 'turn-1', cancelTurn);
        await expect(settleAcceptedRelease(S, id, 'turn-1', cancelTurn)).resolves.toBe('cancelling');
        expect(cancelTurn).toHaveBeenCalledTimes(1);
        release();
        await expect(first).resolves.toBe('cancelled');
        expect(drafts()).toHaveLength(0);
    });
});
