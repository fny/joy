import { storage, isFresh } from '@/sync/storage';
import { useDraftQueueStore } from './draftQueue';
import type { SendMessageResult } from '@/sync/sync';

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

const inFlightUntil = new Map<string, number>();
const RELEASE_BACKSTOP_MS = 15_000;
// Lease horizon for a 'releasing' draft: past this, a retry (same
// releaseLocalId — idempotent) is allowed. Covers app reloads mid-send.
const RELEASE_LEASE_MS = 30_000;
// After this many failed attempts, stop auto-retrying every sweep; the draft
// stays visible/editable with its error and the user can send it manually.
const MAX_AUTO_ATTEMPTS = 5;
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

export function initDraftQueueRelease(send: SendFn): void {
    if (initialized) return;
    initialized = true;

    const releasePass = () => {
        const state = storage.getState();
        const drafts = useDraftQueueStore.getState().bySession;
        const now = Date.now();
        for (const [sessionId, queue] of Object.entries(drafts)) {
            if (!queue || queue.length === 0) continue;
            const session = state.sessions[sessionId];
            if (!session || session.metadata?.joy__source !== 'joy-tmux') continue;
            // Busy must be FRESH and provable (mirrors the capture gate): a
            // stale thinking flag held sends hostage. Stale presence = treat
            // as idle and release — the daemon/TUI queue absorbs a mid-turn
            // arrival harmlessly; a silently-held message does not.
            const head = queue[0];
            const busy = session.thinking === true
                && session.presence === 'online'
                && isFresh(session);
            if (busy && draftAge(head, now) < MAX_HOLD_MS) {
                // Turn running — the previous release (if any) landed.
                inFlightUntil.delete(sessionId);
                continue;
            }
            const until = inFlightUntil.get(sessionId);
            if (until !== undefined && now < until) continue;
            // Two-phase (codex finding 3): the draft is never removed before
            // the send's durable handoff. Take/respect the lease, send with a
            // STABLE releaseLocalId (idempotent at reducer + server on retry),
            // remove only on {ok}; revert with the error otherwise.
            if (head.state === 'releasing' && (head.leaseUntil ?? 0) > now) continue; // another pass owns it
            if ((head.attempt ?? 0) >= MAX_AUTO_ATTEMPTS) continue; // parked for manual action
            const releaseLocalId = head.releaseLocalId ?? `${sessionId}-${head.id}`;
            inFlightUntil.set(sessionId, now + RELEASE_BACKSTOP_MS);
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
                    if (!res.ok) {
                        useDraftQueueStore.getState().revertRelease(sessionId, head.id, res.reason);
                    }
                })
                .catch((e) => {
                    useDraftQueueStore.getState().revertRelease(sessionId, head.id, String(e));
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
export function notifyOutboxAcked(sessionId: string, localIds: Iterable<string>): void {
    const acked = new Set(localIds);
    const drafts = useDraftQueueStore.getState().bySession[sessionId] ?? [];
    for (const d of drafts) {
        if (d.state === 'releasing' && d.releaseLocalId && acked.has(d.releaseLocalId)) {
            useDraftQueueStore.getState().remove(sessionId, d.id);
        }
    }
}
