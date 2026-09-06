// Which sessions the CURRENT voice connection has been shown, and what
// changed in them while the line could not carry an update. Pure.
//
// The focused session's history goes into the system prompt when the connect
// STARTS; the token mint and the SDK connect then take seconds. A turn that
// ended in that window was lost twice over: onMessages dropped the update
// because the line was not up, and the flush after connect skipped the
// session as "already shown" and asked the agent to summarise a result it
// had never received (#340). The ledger versions the snapshot: an update
// that could not be sent is deferred against the session's snapshot and
// replayed, oldest first, before anything else is said about that session.
//
// Only a SHOWN session needs deferral. A session the connection has not
// been shown gets its full history injected on first contact, and that
// history already includes the change.
//
// The ledger lives exactly as long as the connection (or the attempt to
// make one): it is cleared on every hang-up, drop and failed connect, not
// only on disarm. Kept across an idle hang-up it deferred every message of
// every shown session for as long as voice stayed armed — memory with no
// bound, discarded unread by the next connect's fresh snapshot (#340).
// Within a connection it is bounded too: past `maxDeferred` updates a
// session's snapshot is void and the session is briefed in full again,
// which is what a replay longer than the briefing would amount to anyway.

/** Deferred updates a session may accumulate before its snapshot is void. */
export const MAX_DEFERRED_UPDATES = 50;

export class SessionContextLedger<M extends { id: string }> {
    /** Per shown session: the updates deferred against its snapshot, or
     *  null once there were more than the ledger keeps — the snapshot is
     *  void and the session must be briefed in full again. */
    private shown = new Map<string, Map<string, M> | null>();

    constructor(private readonly maxDeferred: number = MAX_DEFERRED_UPDATES) {}

    /** Has this connection received the session's full context, with a
     *  snapshot that deferred updates can still be replayed against? */
    isShown(sessionId: string): boolean {
        return this.shown.get(sessionId) instanceof Map;
    }

    /** The session's full context was (or is about to be) sent: a fresh
     *  snapshot, nothing deferred against it. */
    markShown(sessionId: string): void {
        this.shown.set(sessionId, new Map());
    }

    /**
     * Remember an update the line could not carry. A later version of a
     * message replaces the earlier one in its original slot, so a replay is
     * one update per message, in first-seen order. False when the session is
     * not shown (its first injection will include the change). Past
     * `maxDeferred` distinct messages nothing more is kept: the session is
     * re-briefed in full instead, and that briefing includes the change.
     */
    defer(sessionId: string, messages: M[]): boolean {
        if (!this.shown.has(sessionId)) return false;
        const deferred = this.shown.get(sessionId);
        if (!deferred) return true; // snapshot already void
        for (const m of messages) deferred.set(m.id, m);
        if (deferred.size > this.maxDeferred) this.shown.set(sessionId, null);
        return true;
    }

    /** Sessions whose context is behind — something deferred, or a void
     *  snapshot — in the order they were shown. */
    staleSessions(): string[] {
        const out: string[] = [];
        for (const [sessionId, deferred] of this.shown) if (deferred === null || deferred.size > 0) out.push(sessionId);
        return out;
    }

    /** Take the updates deferred since the session's snapshot, oldest first.
     *  Empty for a void snapshot: there is nothing to replay, the session is
     *  not shown and its next injection is the full context. */
    takeDeferred(sessionId: string): M[] {
        const deferred = this.shown.get(sessionId);
        if (!deferred || deferred.size === 0) return [];
        const out = [...deferred.values()];
        deferred.clear();
        return out;
    }

    /** Deferred updates held right now, across sessions. */
    get size(): number {
        let n = 0;
        for (const deferred of this.shown.values()) n += deferred?.size ?? 0;
        return n;
    }

    /** New connection attempt, or the line is down for good: nothing is
     *  shown, nothing is deferred. */
    clear(): void {
        this.shown.clear();
    }
}
