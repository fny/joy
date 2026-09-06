/**
 * Which locally-held sessions the relay's session list no longer contains.
 *
 * `GET /joy/v2/sessions` is the complete, authoritative snapshot for the
 * account on this relay, but storage.applySessions only MERGES rows in, so a
 * session deleted on another device (or through this app's own delete op)
 * survived every refresh: its card stayed in the list and its message sync
 * kept polling a session that no longer exists (#406).
 *
 * Only v2-linked sessions are candidates — the demo session and any local
 * stub without a relay link were never in the list to begin with.
 */
export function staleSessionIds(
    existing: Record<string, { metadata?: { v2?: { sessionId?: string } } | null } | undefined>,
    fetchedIds: Iterable<string>,
    isLocalOnly: (id: string) => boolean = () => false,
): string[] {
    const present = new Set(fetchedIds);
    const stale: string[] = [];
    for (const [id, session] of Object.entries(existing)) {
        if (present.has(id)) continue;
        if (isLocalOnly(id)) continue;
        if (!session?.metadata?.v2?.sessionId) continue;
        stale.push(id);
    }
    return stale;
}
