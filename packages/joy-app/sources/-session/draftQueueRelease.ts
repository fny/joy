import { storage, isFresh } from '@/sync/storage';
import { isJoyDaemonSource } from '@/sync/storageTypes';
import { useDraftQueueStore, draftReason } from './draftQueue';
import type { SendMessageResult } from '@/sync/sync';
import { randomUUID } from 'expo-crypto';
import { useCallback, useEffect, useReducer } from 'react';
import { t } from '@/text';

/**
 * Auto-release for the app-side message queue (draft queue).
 *
 * THE queue for messages composed while the agent is busy lives in the APP
 * (useDraftQueueStore) — not in the daemon, not in Claude's TUI buffer — so
 * items stay trivially editable/deletable right up until they're sent. This
 * module is the release valve: when a session's turn completes (thinking
 * flips false), the HEAD draft is sent through the normal send path. One
 * item per turn-completion, so everything still queued remains editable.
 *
 * Release guards:
 *  - inFlight per session: set on release, cleared when thinking goes true
 *    (the sent message started its turn) or after a 15s backstop — so a
 *    thinking flap can't machine-gun the whole queue into one turn.
 *  - joy-tmux sessions only: the thinking semantics this relies on (hook
 *    driven, persisted mirror) are joy's.
 */

type SendFn = (sessionId: string, text: string, localId: string) => Promise<SendMessageResult>;
/** Cancels the relay turn an accepted send became (sync wires v2CancelTurn). */
export type CancelTurnFn = (sessionId: string, turnId: string) => Promise<void>;
/** One accepted send as the relay's POST ack described it (#134). */
export type ReleaseAck = { localId: string; turnId?: string };
let cancelTurnFn: CancelTurnFn | undefined;

const inFlightUntil = new Map<string, number>();
const RELEASE_BACKSTOP_MS = 15_000;
// How long after thinking→false a release waits for the turn's trailing
// message rows to reach the server (ordering; see the settle comment below).
const RELEASE_SETTLE_MS = 2_000;
const lastBusyAt = new Map<string, number>();
// Lease horizon for a 'releasing' draft: past this, a retry (same
// releaseLocalId — idempotent) is allowed. Covers app reloads mid-send.
const RELEASE_LEASE_MS = 30_000;
// After this many failed attempts, stop auto-retrying every sweep; the draft
// stays visible/editable with its error and the user can send it manually.
export const MAX_AUTO_ATTEMPTS = 5;
// Hard invariant (codex design review, 2026-07-11): NO app-side state may
// indefinitely prevent user input from reaching the CLI. The fresh-busy gate
// has a residual hostage case — activeAt refreshes from the daemon's generic
// 30s keepalive, so a stuck thinking=true on a HEALTHY daemon still reads
// "fresh busy" forever. A draft held longer than this releases regardless;
// the CLI's native mid-turn queue absorbs it.
const MAX_HOLD_MS = 3 * 60_000;

function draftAge(d: { id: string; queuedAt?: number }, now: number): number {
    const t = d.queuedAt ?? Number.parseInt(d.id, 10);
    return Number.isFinite(t) && t > 0 ? now - t : Number.POSITIVE_INFINITY;
}

let initialized = false;

// ── Attempt fencing (#133) ──────────────────────────────────────────────────
// Every release attempt takes a token; the attempt's failure callbacks act
// only while they still own the draft. Without this, text A's late failure
// (still pending after the 15s backstop) reverted the draft that by then
// held text B in ITS OWN release: B went back to 'queued' carrying A's error,
// and B's acknowledgement — matched on state === 'releasing' — was ignored,
// leaving an accepted message in the queue for further retries.
const attemptTokens = new Map<string, number>();
let nextAttemptToken = 1;
const draftKey = (sessionId: string, draftId: string) => `${sessionId}\u0000${draftId}`;

/** Does `token` still own draft `draftId`'s release of `releaseLocalId`? */
export function attemptOwnsDraft(
    draft: { state?: 'queued' | 'releasing'; releaseLocalId?: string } | undefined,
    releaseLocalId: string,
    token: number,
    currentToken: number | undefined,
): boolean {
    return !!draft
        && currentToken === token
        && draft.state === 'releasing'
        && draft.releaseLocalId === releaseLocalId;
}

function revertIfOwned(sessionId: string, draftId: string, releaseLocalId: string, token: number, error: string): void {
    const draft = (useDraftQueueStore.getState().bySession[sessionId] ?? []).find((d) => d.id === draftId);
    if (!attemptOwnsDraft(draft, releaseLocalId, token, attemptTokens.get(draftKey(sessionId, draftId)))) return;
    attemptTokens.delete(draftKey(sessionId, draftId));
    // The user asked for this item to go while its send was in flight
    // (#134): a definite failure means nothing reached the relay, so the
    // removal completes now instead of reverting to 'queued' for a retry.
    if (pendingCancels.has(draftKey(sessionId, draftId))) {
        settleCancel(sessionId, draftId);
        useDraftQueueStore.getState().remove(sessionId, draftId);
        return;
    }
    useDraftQueueStore.getState().revertRelease(sessionId, draftId, error);
}

// ── Removal during release (#134) ───────────────────────────────────────────
// An app-held item whose POST is in flight cannot be removed locally: the
// draft would vanish while the send still lands and the agent runs a message
// the user believes is gone. Removal is instead RECORDED and settles with the
// send: failure → removed here (nothing reached the relay); acceptance → the
// turn the ack named is CANCELLED through the relay (settleAcceptedRelease)
// and only then does the draft leave the queue — a cancel that fails keeps
// the item visible with the error, parked (no auto-resend). Subscribers
// (WaitingStack) render the in-between state.
const pendingCancels = new Set<string>();
const pendingCancelListeners = new Set<() => void>();
// Drafts whose relay cancel is in flight: the sweep must not resend them and
// a second ack (lease-expiry replay) must not fire a second cancel.
const cancelsInFlight = new Set<string>();
// draftKey → releaseLocalId of a draft whose accepted turn could NOT be
// cancelled. It stays visible with the error; the sweep leaves it alone while
// it still carries that release identity and error (an edit or a manual
// retry clears one of them and the draft flows again).
const parkedCancelFailures = new Map<string, string>();
function settleCancel(sessionId: string, draftId: string): void {
    if (!pendingCancels.delete(draftKey(sessionId, draftId))) return;
    pendingCancelListeners.forEach((l) => l());
}

export type CancelReleaseOutcome = 'removed' | 'pending';

/** Remove an app-held item, or — while its send is in flight — mark it for
 *  removal once the send settles. Returns which of the two happened. */
export function cancelRelease(sessionId: string, draftId: string, now = Date.now()): CancelReleaseOutcome {
    const draft = (useDraftQueueStore.getState().bySession[sessionId] ?? []).find((d) => d.id === draftId);
    const inFlight = !!draft && (
        (draft.state === 'releasing' && (draft.leaseUntil ?? 0) > now)
        || cancelsInFlight.has(draftKey(sessionId, draftId))
    );
    if (!inFlight) {
        settleCancel(sessionId, draftId);
        parkedCancelFailures.delete(draftKey(sessionId, draftId));
        useDraftQueueStore.getState().remove(sessionId, draftId);
        return 'removed';
    }
    pendingCancels.add(draftKey(sessionId, draftId));
    pendingCancelListeners.forEach((l) => l());
    return 'pending';
}

export function isCancelPending(sessionId: string, draftId: string): boolean {
    return pendingCancels.has(draftKey(sessionId, draftId));
}

/** Re-render hook for the pending-removal state of one session's drafts. */
export function useCancelPending(sessionId: string): (draftId: string) => boolean {
    const [, bump] = useReducer((n: number) => n + 1, 0);
    useEffect(() => {
        pendingCancelListeners.add(bump);
        return () => { pendingCancelListeners.delete(bump); };
    }, []);
    return useCallback((draftId: string) => isCancelPending(sessionId, draftId), [sessionId]);
}

export function initDraftQueueRelease(send: SendFn, cancelTurn?: CancelTurnFn): void {
    if (initialized) return;
    initialized = true;
    cancelTurnFn = cancelTurn;

    const releasePass = () => {
        const state = storage.getState();
        const drafts = useDraftQueueStore.getState().bySession;
        const now = Date.now();
        for (const [sessionId, queue] of Object.entries(drafts)) {
            if (!queue || queue.length === 0) continue;
            const session = state.sessions[sessionId];
            if (!session || !isJoyDaemonSource(session.metadata?.joy__source)) continue;

            // Auto-release only 'busy' QUEUE ITEMS (a message held because a turn
            // is processing ahead), never deliberate drafts. Pick the first such
            // item in order (a manual draft at the head must not block it).
            // Offline sends are NOT here — they ride the outbox with a per-message
            // status; releasing while offline is fine too (the released send just
            // sits in the outbox and reflushes on reconnect).
            const head = queue.find((d) => draftReason(d) === 'busy');
            if (!head) continue;

            // Hold while the agent is FRESH-and-provably busy — a stale thinking
            // flag would hold sends hostage; a wrongly-immediate one is absorbed
            // by the daemon/TUI queue.
            const busy = session.thinking === true
                && session.presence === 'online'
                && isFresh(session);
            if (busy && draftAge(head, now) < MAX_HOLD_MS) {
                inFlightUntil.delete(sessionId); // turn running — prior release landed
                lastBusyAt.set(sessionId, now);
                continue;
            }
            // Settle window: thinking flips false slightly BEFORE the daemon
            // finishes forwarding the turn's trailing rows, so an instant
            // release wins the seq race and the released message renders
            // MID-turn (above the answer it queued behind). Give the tail a
            // moment to land; the sweep re-runs this pass.
            const busyAgo = now - (lastBusyAt.get(sessionId) ?? 0);
            if (busyAgo < RELEASE_SETTLE_MS && draftAge(head, now) < MAX_HOLD_MS) continue;
            const until = inFlightUntil.get(sessionId);
            if (until !== undefined && now < until) continue;
            // Two-phase (codex finding 3): the draft is never removed before
            // the send's durable handoff. Take/respect the lease, send with a
            // STABLE releaseLocalId (idempotent at reducer + server on retry),
            // remove only on {ok}; revert with the error otherwise.
            if (head.state === 'releasing' && (head.leaseUntil ?? 0) > now) continue; // another pass owns it
            if ((head.attempt ?? 0) >= MAX_AUTO_ATTEMPTS) continue; // parked for manual action
            // Accepted-and-being-cancelled, or accepted-and-uncancellable
            // (#134): resending would only replay the acceptance the user
            // asked to undo. Parked until an edit or a manual retry.
            const key = draftKey(sessionId, head.id);
            if (cancelsInFlight.has(key)) continue;
            const parkedId = parkedCancelFailures.get(key);
            if (parkedId !== undefined) {
                if (parkedId === head.releaseLocalId && head.lastError != null) continue;
                parkedCancelFailures.delete(key);
            }
            // FRESH random id when the draft has none (5.6-sol verify #7):
            // the deterministic `${sessionId}-${id}` fallback meant an EDITED
            // draft regenerated the same localId as its pre-edit send — the
            // server's dedupe then acked old text A for new text B. Retries
            // stay stable because markReleasing persists the minted id.
            const releaseLocalId = head.releaseLocalId ?? randomUUID();
            inFlightUntil.set(sessionId, now + RELEASE_BACKSTOP_MS);
            const token = nextAttemptToken++;
            attemptTokens.set(draftKey(sessionId, head.id), token);
            useDraftQueueStore.getState().markReleasing(sessionId, head.id, releaseLocalId, now + RELEASE_LEASE_MS);
            void send(sessionId, head.text, releaseLocalId)
                .then((res) => {
                    // {ok} means the send reached the in-memory outbox — NOT
                    // durable (5.6-sol audit #3: the app dying before the POST
                    // completed vaporized both copies). The draft is removed
                    // only on OUTBOX ACK (notifyOutboxAcked below); here we
                    // just keep the lease alive while the POST flies. Lease
                    // expiry retries with the SAME localId — the server's
                    // dedupe makes that a plain re-ack if the first landed.
                    // Failure callbacks are fenced to THIS attempt (#133).
                    if (!res.ok) {
                        revertIfOwned(sessionId, head.id, releaseLocalId, token, res.reason);
                    }
                })
                .catch((e) => {
                    revertIfOwned(sessionId, head.id, releaseLocalId, token, String(e));
                });
        }
    };

    // Deferred + guarded: this runs inside store notification chains, where a
    // synchronous nested set (send → applyMessages) or a thrown error would
    // break the remaining listeners — the whole UI stops reacting. Escape the
    // stack, swallow failures (the sweep below retries).
    let scheduled = false;
    const maybeRelease = () => {
        if (scheduled) return;
        scheduled = true;
        setTimeout(() => {
            scheduled = false;
            try { releasePass(); } catch { /* next pass retries */ }
        }, 0);
    };

    // Sessions state drives the thinking transitions; drafts changing while
    // idle also needs a look; and a periodic sweep backstops BOTH — a session
    // whose state stopped updating entirely (dead daemon) still releases once
    // its freshness lapses.
    storage.subscribe(maybeRelease);
    useDraftQueueStore.subscribe(maybeRelease);
    setInterval(maybeRelease, 10_000);
}

/** POST-ack notification from sync's outbox: the server durably owns these
 *  localIds now, so their releasing drafts can finally be removed. Matches on
 *  releaseLocalId (NOT draft id) — an edited draft cleared its release
 *  identity and must survive the stale ack (5.6-sol audit #7). */
export function notifyOutboxAcked(sessionId: string, acks: Iterable<ReleaseAck>, cancelTurn: CancelTurnFn | undefined = cancelTurnFn): void {
    const acked = new Map<string, ReleaseAck>();
    for (const a of acks) acked.set(a.localId, a);
    const drafts = useDraftQueueStore.getState().bySession[sessionId] ?? [];
    for (const d of drafts) {
        // Matched on the release identity ALONE, not on state: a stale
        // attempt's failure may already have reverted this draft to 'queued'
        // while its retry (same releaseLocalId) landed — the relay owns the
        // message either way, so it must leave the queue (#133). An edit
        // clears releaseLocalId, which is what keeps a stale ack out.
        const ack = d.releaseLocalId ? acked.get(d.releaseLocalId) : undefined;
        if (ack) void settleAcceptedRelease(sessionId, d.id, ack.turnId, cancelTurn);
    }
}

export type AcceptedSettle = 'removed' | 'cancelled' | 'cancel_failed' | 'cancelling';

/** Settle ONE draft whose send the relay accepted. Without a pending removal
 *  the draft simply leaves the queue (synchronously — the relay owns the
 *  message). With one (#134), the accepted turn is cancelled first and the
 *  draft leaves only once that lands; a failed cancel keeps the draft
 *  visible with the error and parks it — the message is the relay's now, so
 *  the app must neither pretend it is gone nor resend it. */
export function settleAcceptedRelease(
    sessionId: string,
    draftId: string,
    turnId: string | undefined,
    cancelTurn: CancelTurnFn | undefined,
): Promise<AcceptedSettle> {
    const key = draftKey(sessionId, draftId);
    if (cancelsInFlight.has(key)) return Promise.resolve('cancelling');
    // The send settled: no late failure callback may act on this draft.
    attemptTokens.delete(key);
    if (!pendingCancels.has(key)) {
        useDraftQueueStore.getState().remove(sessionId, draftId);
        return Promise.resolve('removed');
    }
    cancelsInFlight.add(key);
    return (async () => {
        if (!turnId) throw new Error('the relay accepted the message without naming its turn');
        if (!cancelTurn) throw new Error('no cancel path is wired');
        await cancelTurn(sessionId, turnId);
    })().then(
        () => {
            cancelsInFlight.delete(key);
            settleCancel(sessionId, draftId);
            useDraftQueueStore.getState().remove(sessionId, draftId);
            return 'cancelled' as const;
        },
        (e: unknown) => {
            cancelsInFlight.delete(key);
            settleCancel(sessionId, draftId);
            const draft = (useDraftQueueStore.getState().bySession[sessionId] ?? []).find((d) => d.id === draftId);
            if (draft?.releaseLocalId) parkedCancelFailures.set(key, draft.releaseLocalId);
            useDraftQueueStore.getState().revertRelease(sessionId, draftId, t('joyQueue.cancelFailed', { reason: e instanceof Error ? e.message : String(e) }));
            return 'cancel_failed' as const;
        },
    );
}
