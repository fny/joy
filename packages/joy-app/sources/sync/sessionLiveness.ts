// Session liveness predicates — dependency-free so the list logic that
// depends on them can be unit-tested without loading the whole store.

// Client-side liveness window. The server keeps a session active:true until its
// own ~10-min reaper runs, so when a daemon dies the app would show "online" for
// up to 10 min. The joy-tmux keepalive beats every 30s, so treat a session whose
// last activity is older than this as offline — far above the cadence to avoid
// flapping an idle-but-alive session.
export const SESSION_STALE_AFTER_MS = 90_000;

export function isFresh(session: { activeAt: number }): boolean {
    return Date.now() - session.activeAt < SESSION_STALE_AFTER_MS;
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
