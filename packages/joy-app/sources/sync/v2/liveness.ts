// v2 session liveness → the store's `activeAt` heartbeat.
//
// Everything downstream (presence resolver, sidebar grouping, useSessionStatus)
// asks ONE question: "have we heard from this session within
// SESSION_STALE_AFTER_MS?" — answered from `activeAt`. Under happy the daemon's
// 30s keepalive kept that timestamp moving; under v2 the relay only bumps a
// row's timestamps on TURN events, so an idle-but-alive session went "stale"
// 90s after its last turn and fell out of the active group (or vanished).
//
// The relay's `online` flag IS the heartbeat: it means the owning daemon holds
// an unexpired lease (20s TTL, renewed continuously), and the app re-polls the
// list every 2.5s. So while online, activeAt is "now"; once the lease lapses it
// falls back to the last moment we actually saw it live — which doubles as an
// honest "last seen" — never earlier than the row's own last turn.
export function v2ActiveAt(
    row: { online: boolean; lastTurnAt: number | null; updatedAt: number },
    existingActiveAt: number | undefined,
    now: number = Date.now(),
): number {
    if (row.online) return now;
    return Math.max(existingActiveAt ?? 0, row.lastTurnAt ?? row.updatedAt);
}
