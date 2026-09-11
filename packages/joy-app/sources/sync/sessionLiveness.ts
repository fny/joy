// Session liveness predicates — no store, so the list logic that depends on
// them can be unit-tested directly.
import { isJoyDaemonSource } from './storageTypes';

// Client-side liveness window. The server keeps a session active:true until its
// own ~10-min reaper runs, so when a daemon dies the app would show "online" for
// up to 10 min. The joy-tmux keepalive beats every 30s, so treat a session whose
// last activity is older than this as offline — far above the cadence to avoid
// flapping an idle-but-alive session.
export const SESSION_STALE_AFTER_MS = 90_000;

/**
 * How long a client-derived `thinking` outranks a daemon card that does not
 * carry the mirror. Covers the card's lag behind the message stream (a poke
 * plus a refetch, seconds) with room to spare; anything older is a turn-end
 * this client missed, not a turn still running.
 */
export const EPHEMERAL_THINKING_TRUST_MS = 45_000;

export function isFresh(session: { activeAt: number }): boolean {
    return isFreshAt(session, Date.now());
}

export function isFreshAt(session: { activeAt: number }, now: number): boolean {
    return now - session.activeAt < SESSION_STALE_AFTER_MS;
}

/**
 * How long until the FIRST currently-fresh session in `sessions` goes stale,
 * or null when none is fresh. Freshness is a pure function of the clock, and
 * nothing in the store changes when a session crosses the boundary — so a
 * list computed at render kept a dead daemon's session "online" until some
 * unrelated update happened to re-render it. Machines have had this exact
 * boundary timer since #180/#323 (useMachineOnline); this is the session
 * half. Callers arm ONE timeout for the earliest expiry and recompute then.
 */
export function msUntilNextSessionStale(sessions: Iterable<{ activeAt: number }>, now: number): number | null {
    let next: number | null = null;
    for (const s of sessions) {
        if (!isFreshAt(s, now)) continue;
        const remaining = s.activeAt + SESSION_STALE_AFTER_MS - now;
        if (next === null || remaining < next) next = remaining;
    }
    return next === null ? null : Math.max(0, next);
}

/**
 * Checks if a session should be shown in the active sessions group
 */
export function isSessionActive(session: { active: boolean; activeAt: number }): boolean {
    return session.active && isFresh(session);
}

/**
 * The ONE answer to "does this session belong in the active group?" — used by
 * the list grouping AND stamped on the row (SessionRowData.active), so the
 * visibility filter can never disagree with the grouping. joy__state is a
 * metadata-driven safety net independent of the server's `active` flag:
 * 'detached' (Claude died) and 'archived' (killed/cleaned up) both belong out
 * of the active group even if the relay still reports the row as active.
 * Splitting these (raw flag here, stale-aware there) once produced date
 * headers with no rows under them: a relay-active-but-stale session was
 * grouped as history and then filtered out as "active".
 */
export function isSessionInActiveGroup(session: { active: boolean; activeAt: number; metadata?: { joy__state?: string } | null }): boolean {
    const joyState = session.metadata?.joy__state;
    return isSessionActive(session) && joyState !== 'detached' && joyState !== 'archived';
}

/**
 * Is the agent busy right now — the ONE definition (#652).
 *
 * There were two, and they disagreed. The status line showed "clauding…" on
 * `thinking === true || metadata.joy__thinking != null`, while the send gate
 * queued a message only on `thinking === true`. The ephemeral flag reaches
 * connected clients only, so after a cold start, a reconnect or a session
 * eviction it is absent while the persisted mirror is the thing that is true:
 * the screen said the agent was working and the gate sent the message straight
 * out anyway, where it appeared as a chat bubble instead of a queue row.
 *
 * Both signals are guarded the same way — the mirror is only trusted while the
 * session's presence is live and fresh, so a dead daemon cannot freeze either
 * of them. That was the original objection to the mirror, and it is answered
 * by the liveness check rather than by ignoring the mirror.
 *
 * The two are NOT symmetric, though, and ORing them outright left finished
 * sessions blue in the sidebar. `thinking` is derived by this client from
 * turn-start / turn-end events in the message stream, and it has no reset
 * path: relay session rows preserve it (`thinking: existing?.thinking ??
 * false`), so a turn-end this client never saw — the session was open when
 * the turn began and closed before it ended — pinned the flag true for the
 * life of the app. (Until 164fc749 a wedged turn was force-closed after 30
 * minutes, which emitted the turn-end that unstuck it; that backstop is gone
 * on purpose, so the asymmetry had to be faced here.)
 *
 * The daemon's mirror has no such gap — it is written on every transition —
 * but it LAGS: the turn-start event reaches this client through the message
 * stream before the card carrying joy__thinking does. Deferring to the mirror
 * outright would therefore reopen #652 in that window, releasing a queued
 * message into a turn that has just begun.
 *
 * So for a session the daemon publishes, the derived flag is believed only
 * while it is fresh — long enough to cover the card's lag, far short of
 * forever — and after that the mirror's silence is taken at face value.
 *
 * Anything deciding "is it busy" must call this, so the two can never drift
 * apart again.
 */
export function isAgentBusy(session: {
    thinking?: boolean;
    /** When this client derived `thinking`; 0 when it never did. */
    thinkingAt?: number;
    presence?: 'online' | number;
    activeAt: number;
    metadata?: { joy__thinking?: { since: number } | null; joy__source?: string | null } | null;
}): boolean {
    const live = session.presence === 'online' && isFresh(session);
    if (!live) return false;
    if (session.metadata?.joy__thinking != null) return true;
    if (session.thinking !== true) return false;
    if (!isJoyDaemonSource(session.metadata?.joy__source)) return true;
    return Date.now() - (session.thinkingAt ?? 0) < EPHEMERAL_THINKING_TRUST_MS;
}
