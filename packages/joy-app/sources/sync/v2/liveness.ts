// v2 session liveness → the store's `activeAt` heartbeat.
//
// Everything downstream (presence resolver, sidebar grouping, useSessionStatus)
// asks ONE question: "have we heard from this session within
// SESSION_STALE_AFTER_MS?" — answered from `activeAt`. Previously the daemon's
// 30s keepalive kept that timestamp moving; under v2 the relay only bumps a
// row's timestamps on TURN events, so an idle-but-alive session went "stale"
// 90s after its last turn and fell out of the active group (or vanished).
//
// The relay's `online` flag IS the heartbeat: it means the owning daemon holds
// an unexpired lease (20s TTL, renewed continuously), and the app re-polls the
// list every 2.5s. So while online, activeAt is "now"; once the lease lapses it
// falls back to the last moment we actually saw it live — which doubles as an
// honest "last seen" — never earlier than the row's own last turn.

/** The states in which a session still has a process behind it. The rest —
 *  detached, failed, archived — are over, whatever their machine is doing. */
export const LIVE_SESSION_STATES: ReadonlySet<string> = new Set(['provisioning', 'starting', 'active']);

/**
 * Is this session live right now? The lease is the MACHINE's pulse; a session
 * inherits it only while it is in a live state. The relay applies the same
 * rule since 2026-09-18, and this guards against one that does not yet: every
 * archived run on a running daemon used to read online, so the sidebar said
 * "last seen just now" on all of them, forever.
 */
export function v2Online(row: { online: boolean; state: string }): boolean {
    return row.online && LIVE_SESSION_STATES.has(row.state);
}

/** How old an online session's activeAt may grow before a poll moves it.
 *  Well inside the 90 s staleness window, so an online session never reads
 *  stale; coarse enough that a poll does not rewrite every online session. */
export const ACTIVE_REFRESH_MS = 30_000;

export function v2ActiveAt(
    row: { online: boolean; state: string; lastTurnAt: number | null; updatedAt: number },
    existingActiveAt: number | undefined,
    now: number = Date.now(),
): number {
    // Stamping "now" on every poll made every online session a CHANGED session
    // every 2.5 s, so the store never settled and the whole list re-rendered
    // forever. Keep the stamp while it is fresh enough to mean "online".
    if (v2Online(row)) {
        return existingActiveAt !== undefined && existingActiveAt <= now && now - existingActiveAt < ACTIVE_REFRESH_MS ? existingActiveAt : now;
    }
    return Math.max(existingActiveAt ?? 0, row.lastTurnAt ?? row.updatedAt);
}
