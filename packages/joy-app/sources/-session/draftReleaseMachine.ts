/**
 * The draft queue's auto-release, as explicit machines. Pure, import-free.
 *
 * Two machines, because the state has two scopes:
 *
 *  · one per DRAFT — where its release stands. This used to be spread over
 *    five stores that had to agree: the persisted draft fields
 *    (state/releaseLocalId/leaseUntil/attempt/lastError), an attempt-token
 *    map (#133), and a removal-intent map with its own phase (#134). Here it
 *    is one value; the persisted fields are its projection.
 *  · one per SESSION (the lane) — the settle window after the agent was last
 *    busy and the in-flight backstop after a release went out. Both are
 *    about the previous release, not the draft, so they live on the lane.
 *
 * `decideRelease` is the sweep's ladder: given the two states, whether the
 * agent is busy, the draft's age and the clock, exactly one thing to do.
 *
 * Rules kept from the engine (each a past bug):
 *  · one item per turn-completion, held while the agent is busy by the one
 *    definition (#652), capped by MAX_HOLD_MS — no app-side state may hold a
 *    message hostage forever (codex design review, 2026-07-11);
 *  · a settle window (RELEASE_SETTLE_MS) so the released message lands after
 *    the turn's trailing rows, and a backstop (RELEASE_BACKSTOP_MS) so a
 *    thinking flap cannot machine-gun the queue into one turn;
 *  · two-phase release: the lease and a STABLE release identity are
 *    persisted before the send (codex finding 3); the draft leaves only on
 *    the relay's ack (5.6-sol audit #3); an expired lease licenses a retry
 *    under the same identity, which is idempotent at the reducer and the
 *    server;
 *  · attempt fencing (#133): a failure callback acts only while its token
 *    still owns the draft's current release identity — text A's late
 *    failure must not revert text B's own release;
 *  · removal during release (#134): keyed to the SEND IDENTITY. A definite
 *    failure completes the removal (nothing reached the relay); an ack
 *    cancels the accepted turn first and only then drops the draft; a
 *    failed cancel parks the draft, visibly, with the error — the message is
 *    the relay's now, so it is neither hidden nor resent; a replayed ack
 *    retries the cancel, MAX_CANCEL_ATTEMPTS times;
 *  · an edit RECLAIMS the draft (5.6-sol audit #7): the identity is dropped,
 *    so a late ack, cancel or failure for the old send cannot touch it;
 *  · a draft whose images are gone from disk does not auto-release (#650).
 */

export const MAX_AUTO_ATTEMPTS = 5;
export const MAX_CANCEL_ATTEMPTS = 3;
export const RELEASE_BACKSTOP_MS = 15_000;
export const RELEASE_SETTLE_MS = 2_000;
export const RELEASE_LEASE_MS = 30_000;
export const MAX_HOLD_MS = 3 * 60_000;

// ── per draft ───────────────────────────────────────────────────────────────

export type DraftReleaseState =
    /** Eligible for auto-release (or parked by the sweep's other guards).
     *  `localId` survives a revert: a retry keeps the identity. */
    | { kind: 'queued'; attempt: number; lastError: string | null; localId: string | null; missing: string[] }
    /** The send is out (or its lease expired and a retry is licensed).
     *  `removal`: the user asked for the item to go while it was in flight. */
    | { kind: 'releasing'; attempt: number; lastError: string | null; localId: string; leaseUntil: number; token: number; removal: boolean }
    /** Accepted, and the user had asked for removal: the relay cancel is out. */
    | { kind: 'cancelling'; attempt: number; localId: string; cancelAttempts: number }
    /** Parked, visible with its error: the auto-attempts are spent, or the
     *  cancel of an accepted send failed (`cancelFailed`). */
    | { kind: 'failed'; attempt: number; lastError: string | null; localId: string | null; cancelFailed: boolean; cancelAttempts: number }
    /** Removed from the queue. */
    | { kind: 'done' };

export type DraftReleaseEvent =
    /** A release attempt went out under `token`, with this identity and lease. */
    | { type: 'release_started'; token: number; localId: string; leaseUntil: number }
    /** The send of (`token`, `localId`) failed for good. */
    | { type: 'rejected'; token: number; localId: string; error: string }
    /** The relay durably accepted the send with this identity. */
    | { type: 'ack'; localId: string }
    | { type: 'cancel_ok'; localId: string }
    | { type: 'cancel_failed'; localId: string; error: string }
    /** The user pressed × on the item. */
    | { type: 'user_cancel' }
    /** The user edited the text: a new composition. */
    | { type: 'user_edit' }
    /** The user pressed retry on a parked item: the error and the count are
     *  cleared, and a pending removal is withdrawn — they asked to send. */
    | { type: 'user_retry' }
    | { type: 'attachments_missing'; ids: string[] }
    | { type: 'attachments_ready' };

export const DONE: DraftReleaseState = { kind: 'done' };

export function queuedDraft(attempt = 0, lastError: string | null = null, localId: string | null = null, missing: string[] = []): DraftReleaseState {
    return { kind: 'queued', attempt, lastError, localId, missing };
}

/** The identity the draft's last send carried, if it still carries one. */
export function localIdOf(s: DraftReleaseState): string | null {
    return s.kind === 'done' ? null : s.localId;
}

/** Does attempt `token` still own draft `s`'s release of `localId` (#133)? */
export function attemptOwnsDraft(s: DraftReleaseState | undefined, localId: string, token: number): boolean {
    return !!s && s.kind === 'releasing' && s.token === token && s.localId === localId;
}

/** Is the item's removal recorded but not yet complete? */
export function isRemovalPending(s: DraftReleaseState): boolean {
    return (s.kind === 'releasing' && s.removal) || s.kind === 'cancelling';
}

/** After a failed attempt: back in the queue, or parked once the budget is spent. */
function afterRejection(attempt: number, error: string, localId: string): DraftReleaseState {
    const next = attempt + 1;
    return next >= MAX_AUTO_ATTEMPTS
        ? { kind: 'failed', attempt: next, lastError: error, localId, cancelFailed: false, cancelAttempts: 0 }
        : { kind: 'queued', attempt: next, lastError: error, localId, missing: [] };
}

/** An edit drops the identity and keeps the counters (the store's update does). */
function afterEdit(attempt: number, lastError: string | null): DraftReleaseState {
    return attempt >= MAX_AUTO_ATTEMPTS
        ? { kind: 'failed', attempt, lastError, localId: null, cancelFailed: false, cancelAttempts: 0 }
        : { kind: 'queued', attempt, lastError, localId: null, missing: [] };
}

export function nextDraftRelease(s: DraftReleaseState, ev: DraftReleaseEvent): DraftReleaseState {
    switch (s.kind) {
        case 'queued':
            switch (ev.type) {
                case 'release_started': return { kind: 'releasing', attempt: s.attempt, lastError: s.lastError, localId: ev.localId, leaseUntil: ev.leaseUntil, token: ev.token, removal: false };
                case 'rejected': return s; // no attempt owns a queued draft
                // A stale attempt's failure reverted the draft while its
                // retry (same identity) landed: the relay owns it (#133).
                case 'ack': return ev.localId === s.localId ? DONE : s;
                case 'cancel_ok': return s;
                case 'cancel_failed': return s;
                case 'user_cancel': return DONE; // nothing in flight: gone at once
                case 'user_edit': return { ...s, localId: null };
                case 'user_retry': return { ...s, attempt: 0, lastError: null };
                case 'attachments_missing': return { ...s, missing: ev.ids };
                case 'attachments_ready': return { ...s, missing: [] };
            }
            return unreachable(ev);
        case 'releasing':
            switch (ev.type) {
                // A lease-expiry retry: same identity, new token and lease;
                // a pending removal rides along.
                case 'release_started': return { ...s, localId: ev.localId, leaseUntil: ev.leaseUntil, token: ev.token };
                case 'rejected': {
                    if (!attemptOwnsDraft(s, ev.localId, ev.token)) return s;
                    // Nothing reached the relay: the removal completes here (#134).
                    if (s.removal) return DONE;
                    return afterRejection(s.attempt, ev.error, s.localId);
                }
                case 'ack':
                    if (ev.localId !== s.localId) return s;
                    return s.removal ? { kind: 'cancelling', attempt: s.attempt, localId: s.localId, cancelAttempts: 1 } : DONE;
                case 'cancel_ok': return s;
                case 'cancel_failed': return s;
                case 'user_cancel': return { ...s, removal: true }; // settles with the send
                case 'user_edit': return afterEdit(s.attempt, s.lastError);
                case 'user_retry': return s;
                case 'attachments_missing': return s;
                case 'attachments_ready': return s;
            }
            return unreachable(ev);
        case 'cancelling':
            switch (ev.type) {
                case 'release_started': return s;
                case 'rejected': return s;
                case 'ack': return s; // a second ack does not fire a second cancel
                case 'cancel_ok': return ev.localId === s.localId ? DONE : s;
                case 'cancel_failed':
                    if (ev.localId !== s.localId) return s;
                    return { kind: 'failed', attempt: s.attempt + 1, lastError: ev.error, localId: s.localId, cancelFailed: true, cancelAttempts: s.cancelAttempts };
                case 'user_cancel': return s; // already on its way out
                // A new composition: the old send's cancel is not its business.
                case 'user_edit': return afterEdit(s.attempt, null);
                case 'user_retry': return s;
                case 'attachments_missing': return s;
                case 'attachments_ready': return s;
            }
            return unreachable(ev);
        case 'failed':
            switch (ev.type) {
                case 'release_started': return s; // not eligible: a retry goes through user_retry
                case 'rejected': return s;
                case 'ack': {
                    if (ev.localId !== s.localId) return s;
                    // A replayed ack (a lease-expiry retry that also landed)
                    // retries the cancel — bounded — instead of dropping what
                    // the relay still runs. Without a failed cancel behind
                    // it, the ack means what it says: the relay owns it.
                    if (!s.cancelFailed) return DONE;
                    if (s.cancelAttempts >= MAX_CANCEL_ATTEMPTS) return s;
                    return { kind: 'cancelling', attempt: s.attempt, localId: s.localId!, cancelAttempts: s.cancelAttempts + 1 };
                }
                case 'cancel_ok': return s;
                case 'cancel_failed': return s;
                case 'user_cancel': return DONE; // removed locally, knowing the relay kept it
                case 'user_edit': return afterEdit(s.attempt, s.lastError);
                // Clears the error and the count, and WITHDRAWS a removal:
                // the user asked to send after all.
                case 'user_retry': return { kind: 'queued', attempt: 0, lastError: null, localId: s.localId, missing: [] };
                case 'attachments_missing': return s;
                case 'attachments_ready': return s;
            }
            return unreachable(ev);
        case 'done':
            return DONE;
    }
    return unreachable(s);
}

// ── per session (the lane) ──────────────────────────────────────────────────

export type LaneState = {
    /** When the agent was last seen busy (the settle window counts from here). */
    lastBusyAt: number;
    /** A release went out; the next waits until the turn starts or this passes. */
    inFlightUntil: number | null;
};

export type LaneEvent =
    /** The agent is busy: the prior release landed (its turn is running). */
    | { type: 'busy'; now: number }
    | { type: 'released'; now: number };

export const IDLE_LANE: LaneState = { lastBusyAt: 0, inFlightUntil: null };

export function nextLane(s: LaneState, ev: LaneEvent): LaneState {
    switch (ev.type) {
        case 'busy': return { lastBusyAt: ev.now, inFlightUntil: null };
        case 'released': return { ...s, inFlightUntil: ev.now + RELEASE_BACKSTOP_MS };
    }
    return unreachable(ev);
}

// ── the sweep's ladder ──────────────────────────────────────────────────────

export type ReleaseDecision =
    | 'hold_busy'          // the agent is busy (and the draft is not past MAX_HOLD_MS)
    | 'hold_settle'        // the turn just ended; let its trailing rows land
    | 'hold_in_flight'     // a release is out and its turn has not started
    | 'leased'             // this draft's own send is in flight under a live lease
    | 'cancelling'         // accepted and being cancelled: resending would replay the acceptance
    | 'parked'             // attempts spent, or a failed cancel: manual action only
    | 'missing_attachments'// images gone from disk (#650): a deliberate tap only
    | 'done'
    | 'release';

export function decideRelease(input: {
    draft: DraftReleaseState;
    lane: LaneState;
    busy: boolean;
    /** How long the draft has been queued. */
    age: number;
    now: number;
    /** Attachments known to be missing from disk (the persisted flag). */
    missing: number;
}): ReleaseDecision {
    const { draft, lane, busy, age, now } = input;
    const holdable = age < MAX_HOLD_MS;
    if (busy && holdable) return 'hold_busy';
    if (now - lane.lastBusyAt < RELEASE_SETTLE_MS && holdable) return 'hold_settle';
    if (lane.inFlightUntil !== null && now < lane.inFlightUntil) return 'hold_in_flight';
    switch (draft.kind) {
        case 'done': return 'done';
        case 'cancelling': return 'cancelling';
        case 'failed': return 'parked';
        case 'releasing':
            if (draft.leaseUntil > now) return 'leased';
            break;
        case 'queued':
            break;
    }
    if (input.missing > 0) return 'missing_attachments';
    return 'release';
}

function unreachable(x: never): never {
    throw new Error(`draftRelease: unhandled ${JSON.stringify(x)}`);
}
