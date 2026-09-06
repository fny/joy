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

export class SessionContextLedger<M extends { id: string }> {
    private shown = new Map<string, Map<string, M>>();

    /** Has this connection received the session's full context? */
    isShown(sessionId: string): boolean {
        return this.shown.has(sessionId);
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
     * not shown (its first injection will include the change).
     */
    defer(sessionId: string, messages: M[]): boolean {
        const deferred = this.shown.get(sessionId);
        if (!deferred) return false;
        for (const m of messages) deferred.set(m.id, m);
        return true;
    }

    /** Sessions with something deferred, in the order they were shown. */
    staleSessions(): string[] {
        const out: string[] = [];
        for (const [sessionId, deferred] of this.shown) if (deferred.size > 0) out.push(sessionId);
        return out;
    }

    /** Take the updates deferred since the session's snapshot, oldest first. */
    takeDeferred(sessionId: string): M[] {
        const deferred = this.shown.get(sessionId);
        if (!deferred || deferred.size === 0) return [];
        const out = [...deferred.values()];
        deferred.clear();
        return out;
    }

    /** New connection or voice ended: nothing has been shown. */
    clear(): void {
        this.shown.clear();
    }
}
