/**
 * The v2 link stamped on every session card by fetchSessions.
 *
 * `relay` MUST be the base URL the session list was actually fetched from.
 * The list request honours the per-install v2 base override, but the link
 * used to be stamped with getServerUrl() — so with the override pointing at
 * relay B, cards listed from B were addressed to A for every read, send and
 * machine-plane call (#409). The caller captures the base once, before the
 * request, and passes it here.
 */
export type V2Link = { sessionId: string; relay: string; keyEnvelope: string; localSessionId?: string };

export function v2LinkForRow(
    row: { sessionId: string; sessionKeyEnvelope?: string | null; localSessionId?: string | null },
    cardLink: Partial<V2Link> | undefined,
    relayBase: string,
): V2Link {
    // The card's link may predate fields (or the relay moved) — the ROW is
    // authoritative for linkage; the card only fills what the row lacks.
    return {
        ...cardLink,
        sessionId: row.sessionId,
        relay: relayBase,
        keyEnvelope: row.sessionKeyEnvelope ?? cardLink?.keyEnvelope ?? '',
        localSessionId: row.localSessionId ?? cardLink?.localSessionId,
    };
}
