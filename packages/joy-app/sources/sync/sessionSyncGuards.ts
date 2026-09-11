/**
 * Small pure guards for the per-session message pipeline in sync.ts.
 */

/** Thrown at a commit point by a fetch whose generation went stale. */
export class StaleFetchError extends Error {
    constructor(sessionId: string) {
        super(`fetch for ${sessionId} superseded by a chat reset`);
        this.name = 'StaleFetchError';
    }
}

/**
 * Has the event log already acknowledged an optimistic send? The relay's own
 * row for it (matched by localId) reconciles INTO the optimistic row, giving
 * it an authoritative `seq` and lifting its delivery stage past `local`. A
 * POST that fails AFTER that happened is a lost response, not a lost send —
 * dismissing the row then deleted a prompt the agent was already running,
 * with the forward cursor past it so no sync ever brought it back (#410).
 */
export function isSendAcknowledged(row: { seq?: number | null; deliveryStage?: string } | null | undefined): boolean {
    if (!row) return false;
    if (typeof row.seq === 'number') return true;
    return row.deliveryStage !== undefined && row.deliveryStage !== 'local';
}

/**
 * Cursors outlive the message store when limitSessionMemory evicts a
 * session. A store re-created by something OTHER than a fetch (the
 * optimistic row of a send into that session) then looks anchored — the
 * next fetch takes the forward-only branch from the old cursor and the chat
 * shows just the rows after it, with hasMoreOlder stuck false (#12). When
 * the store is gone but a cursor remains, the cursors must be dropped so the
 * next fetch re-anchors like a cold open.
 */
export function cursorsNeedReanchor(storeExists: boolean, hasForwardCursor: boolean): boolean {
    return !storeExists && hasForwardCursor;
}
