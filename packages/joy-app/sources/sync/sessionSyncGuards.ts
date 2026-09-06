/**
 * Small pure guards for the per-session message pipeline in sync.ts.
 */

/**
 * Per-session fetch generation. `resetSessionChatState` bumps it; a fetch
 * captures the generation when it starts and refuses to commit (apply rows,
 * move cursors) once it is stale. Without this, a forward fetch that was
 * already in flight when the user hit "Reload chat" applied its page AFTER
 * the reset had wiped the store and both cursors — leaving one message, no
 * backward anchor, and every later sync walking forward from it, so the
 * requested reset never reloaded the history (#407).
 */
export class FetchGeneration {
    private generations = new Map<string, number>();

    current(sessionId: string): number {
        return this.generations.get(sessionId) ?? 0;
    }

    /** Invalidate every fetch started before now. */
    bump(sessionId: string): number {
        const next = this.current(sessionId) + 1;
        this.generations.set(sessionId, next);
        return next;
    }

    isStale(sessionId: string, generation: number): boolean {
        return this.current(sessionId) !== generation;
    }

    forget(sessionId: string): void {
        this.generations.delete(sessionId);
    }
}

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
