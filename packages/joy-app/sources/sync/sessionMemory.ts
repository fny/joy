/**
 * Which loaded chat histories survive an eviction pass.
 *
 * `limitSessionMemory` unloads the message history of sessions beyond the N
 * most-recently-viewed, so browsing many chats doesn't keep every history
 * resident. The rule it has to honour is that a session with work in flight is
 * never unloaded: its reducer state is mid-turn, and dropping it shows an empty
 * chat until the refetch lands.
 *
 * Pure, and takes the liveness question as a callback, so the retention rule can
 * be tested without the store — the bug it had was never in the loop, it was in
 * which predicate the loop asked (see `hasLiveTurn` in storage.ts).
 */
export function sessionsToRetain(params: {
    loadedIds: readonly string[];
    /** Session ids, most-recently-viewed first. */
    mru: readonly string[];
    /** null / non-positive means the feature is off: keep everything. */
    limit: number | null | undefined;
    hasLiveTurn: (sessionId: string) => boolean;
}): Set<string> | null {
    const { loadedIds, mru, limit, hasLiveTurn } = params;
    if (limit == null || limit <= 0) return null;

    const recent = new Set(mru.slice(0, limit));
    const retained = new Set<string>();
    for (const id of loadedIds) {
        if (recent.has(id) || hasLiveTurn(id)) retained.add(id);
    }
    // Nothing would be dropped — tell the caller so it can skip rebuilding the map.
    return retained.size === loadedIds.length ? null : retained;
}
