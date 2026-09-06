import { SESSION_STALE_AFTER_MS } from '@/sync/sessionLiveness';

/**
 * Favicon "permission pending" predicate, pure so the indicator's timing can
 * be tested. Storage recalculates `presence` only when a session update is
 * applied, so a session whose daemon simply stopped sending kept
 * presence:'online' forever and the alert favicon stayed lit (#299). The
 * predicate therefore re-checks freshness against `now`, and the component
 * re-evaluates when the earliest heartbeat deadline passes.
 */

export interface PermissionSessionLike {
    presence: 'online' | number;
    activeAt: number;
    agentState?: { requests?: Record<string, unknown> | null } | null;
}

function hasPendingRequests(session: PermissionSessionLike): boolean {
    const requests = session.agentState?.requests;
    return !!requests && Object.keys(requests).length > 0;
}

function isLive(session: PermissionSessionLike, now: number): boolean {
    return session.presence === 'online' && now - session.activeAt < SESSION_STALE_AFTER_MS;
}

/** True when at least one LIVE session (fresh heartbeat) has a pending permission request. */
export function hasFreshPermissionRequest(sessions: Iterable<PermissionSessionLike>, now: number): boolean {
    for (const session of sessions) {
        if (isLive(session, now) && hasPendingRequests(session)) return true;
    }
    return false;
}

/**
 * Milliseconds until the earliest live+pending session would go stale, or
 * null when nothing is lit. The component re-renders at that moment so a
 * stalled heartbeat clears the favicon without any store update.
 */
export function msUntilNextFreshnessExpiry(sessions: Iterable<PermissionSessionLike>, now: number): number | null {
    let next: number | null = null;
    for (const session of sessions) {
        if (!isLive(session, now) || !hasPendingRequests(session)) continue;
        const remaining = session.activeAt + SESSION_STALE_AFTER_MS - now;
        if (next === null || remaining < next) next = remaining;
    }
    return next === null ? null : Math.max(0, next);
}
