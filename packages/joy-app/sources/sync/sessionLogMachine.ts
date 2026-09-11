/**
 * A session's message log, as the engine tracks it: where the cursors are,
 * whether the store still holds the rows, and which fetch may commit. Pure,
 * import-free; `SessionLogs` is the per-session container sync.ts holds.
 *
 * This state used to live in three maps (forward cursor, backward cursor,
 * fetch generation) plus the store's own flags, and every fix in its history
 * is a place where two of them disagreed:
 *   #407 a reset while a page was in flight — the page committed afterwards
 *        and restored only the forward cursor;
 *   #406 a forgotten session's generation counter reset to 0, the very value
 *        an in-flight fetch had captured, so it committed after the delete;
 *   #12  the store was evicted but the cursors survived; a send re-created
 *        the store and the next fetch walked forward from the old cursor —
 *        history gone, hasMoreOlder stuck false;
 *   #4   a page of nothing renderable never moved the backward anchor, so
 *        older history was unreachable although the relay said it existed;
 *   #2   a background poll re-anchored sessions the memory limit had just
 *        evicted, defeating the limit.
 *
 * Generations are minted by the container from ONE counter, so a session
 * that is forgotten and listed again can never hand an old fetch a valid
 * token (#406 by construction). A fetch captures the generation when it
 * starts; `isStale` at every commit point is the fence (#407, #12).
 */
export type LogState =
    | { kind: 'cold'; gen: number }
    /** The newest page is being fetched for a cold session. */
    | { kind: 'anchoring'; gen: number }
    | { kind: 'anchored'; gen: number; lastSeq: number; oldestSeq: number | null; hasMoreOlder: boolean }
    | { kind: 'loading_older'; gen: number; lastSeq: number; oldestSeq: number; hasMoreOlder: boolean }
    /** The store was evicted (memory limit); the forward cursor survives only
     *  as a fact about what was once held — it is never walked from. */
    | { kind: 'evicted'; gen: number; lastSeq: number }
    /** Evicted and on screen: the newest page is being fetched again. */
    | { kind: 'reanchoring'; gen: number }
    | { kind: 'forgotten'; gen: number };

export type PageKind = 'anchor' | 'forward' | 'older';

export type LogEvent =
    /** A fetch is starting under `gen`; `viewing` = the session is on screen. */
    | { type: 'fetch_started'; gen: number; viewing: boolean }
    | { type: 'fetch_failed'; gen: number }
    /** Rows (or a scanned-only span, #4) were applied to the store. `minSeq`/
     *  `maxSeq` are the rows' bounds (null when the page had none);
     *  `scannedTo` is the oldest seq the reader scanned (anchor/older). */
    | { type: 'page_applied'; gen: number; page: PageKind; minSeq: number | null; maxSeq: number | null; scannedTo: number | null; hasMore: boolean }
    | { type: 'older_started'; gen: number }
    | { type: 'older_failed'; gen: number }
    /** Reload chat: everything local is dropped; `gen` is fresh. */
    | { type: 'reset'; gen: number }
    /** The store no longer holds the rows (limitSessionMemory). */
    | { type: 'evicted' }
    /** Something other than a fetch re-created the store (a send's
     *  optimistic row): the cursors must not survive it (#12). */
    | { type: 'recreated'; gen: number }
    | { type: 'forgotten'; gen: number };

/** What the engine should do for a fetch that just started. */
export type FetchBranch = 'anchor' | 'reanchor' | 'forward' | 'skip';

export function fetchBranchOf(s: LogState): FetchBranch {
    switch (s.kind) {
        case 'anchoring': return 'anchor';
        case 'reanchoring': return 'reanchor';
        case 'anchored': return 'forward';
        case 'loading_older': return 'forward';
        case 'cold': return 'skip';
        case 'evicted': return 'skip';   // not on screen: stays evicted (#2)
        case 'forgotten': return 'skip';
    }
}

const finiteMin = (...xs: (number | null)[]): number | null => {
    let m: number | null = null;
    for (const x of xs) if (x !== null && Number.isFinite(x) && (m === null || x < m)) m = x;
    return m;
};

export function nextLogState(s: LogState, ev: LogEvent): LogState {
    // Fences first: a token from another generation commits nothing.
    if ('gen' in ev && ev.type !== 'reset' && ev.type !== 'recreated' && ev.type !== 'forgotten' && ev.gen !== s.gen) return s;
    if (ev.type === 'reset') return { kind: 'cold', gen: ev.gen };
    if (ev.type === 'forgotten') return { kind: 'forgotten', gen: ev.gen };

    switch (s.kind) {
        case 'cold':
            switch (ev.type) {
                case 'fetch_started': return { kind: 'anchoring', gen: s.gen };
                case 'fetch_failed': return s;
                case 'page_applied': return s;
                case 'older_started': return s;
                case 'older_failed': return s;
                case 'evicted': return s;
                case 'recreated': return s;
            }
            return unreachable(ev);
        case 'anchoring':
            switch (ev.type) {
                case 'fetch_started': return s;
                case 'fetch_failed': return { kind: 'cold', gen: s.gen };
                case 'page_applied': return ev.page === 'anchor' ? anchoredFrom(s.gen, ev) : s;
                case 'older_started': return s;
                case 'older_failed': return s;
                case 'evicted': return s;
                case 'recreated': return s;
            }
            return unreachable(ev);
        case 'anchored':
            switch (ev.type) {
                case 'fetch_started': return s;
                case 'fetch_failed': return s;
                case 'page_applied':
                    if (ev.page === 'forward') return { ...s, lastSeq: ev.maxSeq ?? s.lastSeq };
                    if (ev.page === 'anchor') return anchoredFrom(s.gen, ev);
                    return s; // an older page outside loading_older: nothing was asked
                case 'older_started':
                    if (s.oldestSeq === null || s.oldestSeq <= 1 || !s.hasMoreOlder) return s;
                    return { kind: 'loading_older', gen: s.gen, lastSeq: s.lastSeq, oldestSeq: s.oldestSeq, hasMoreOlder: s.hasMoreOlder };
                case 'older_failed': return s;
                case 'evicted': return { kind: 'evicted', gen: s.gen, lastSeq: s.lastSeq };
                case 'recreated': return s; // the store is present: a send changes nothing
            }
            return unreachable(ev);
        case 'loading_older':
            switch (ev.type) {
                case 'fetch_started': return s;
                case 'fetch_failed': return s;
                case 'page_applied': {
                    if (ev.page === 'forward') return { ...s, lastSeq: ev.maxSeq ?? s.lastSeq };
                    if (ev.page === 'anchor') return anchoredFrom(s.gen, ev);
                    // The reader's cursor may be below every returned row, or
                    // the only progress when nothing was renderable (#4).
                    const reached = finiteMin(ev.minSeq, ev.scannedTo);
                    const advanced = reached !== null && reached < s.oldestSeq;
                    return {
                        kind: 'anchored', gen: s.gen, lastSeq: s.lastSeq,
                        oldestSeq: advanced ? reached : s.oldestSeq,
                        hasMoreOlder: ev.hasMore && advanced,
                    };
                }
                case 'older_started': return s;
                case 'older_failed': return { kind: 'anchored', gen: s.gen, lastSeq: s.lastSeq, oldestSeq: s.oldestSeq, hasMoreOlder: s.hasMoreOlder };
                case 'evicted': return { kind: 'evicted', gen: s.gen, lastSeq: s.lastSeq };
                case 'recreated': return s;
            }
            return unreachable(ev);
        case 'evicted':
            switch (ev.type) {
                // On screen: refetch like a cold open. Off screen: stay put (#2).
                case 'fetch_started': return ev.viewing ? { kind: 'reanchoring', gen: s.gen } : s;
                case 'fetch_failed': return s;
                case 'page_applied': return s;
                case 'older_started': return s;
                case 'older_failed': return s;
                case 'evicted': return s;
                case 'recreated': return { kind: 'cold', gen: ev.gen };
            }
            return unreachable(ev);
        case 'reanchoring':
            switch (ev.type) {
                case 'fetch_started': return s;
                case 'fetch_failed': return { kind: 'cold', gen: s.gen };
                case 'page_applied': return ev.page === 'anchor' ? anchoredFrom(s.gen, ev) : s;
                case 'older_started': return s;
                case 'older_failed': return s;
                case 'evicted': return s;
                case 'recreated': return s;
            }
            return unreachable(ev);
        case 'forgotten':
            switch (ev.type) {
                case 'fetch_started': return s;
                case 'fetch_failed': return s;
                case 'page_applied': return s;
                case 'older_started': return s;
                case 'older_failed': return s;
                case 'evicted': return s;
                case 'recreated': return s;
            }
            return unreachable(ev);
    }
    return unreachable(s);
}

/** Both ends anchored from the newest page: the forward cursor is the
 *  highest row seen (0 when the log is empty, so forward sync starts at
 *  the beginning); the backward anchor is the oldest bound SCANNED, even
 *  when every page was non-renderable (#4). */
function anchoredFrom(gen: number, ev: Extract<LogEvent, { type: 'page_applied' }>): LogState {
    return { kind: 'anchored', gen, lastSeq: ev.maxSeq ?? 0, oldestSeq: finiteMin(ev.minSeq, ev.scannedTo), hasMoreOlder: ev.hasMore };
}

function unreachable(x: never): never {
    throw new Error(`sessionLog: unhandled ${JSON.stringify(x)}`);
}

/** The engine's per-session logs, with one generation counter for all. */
export class SessionLogs {
    private logs = new Map<string, LogState>();
    private nextGen = 1;

    mint(): number { return this.nextGen++; }

    state(sessionId: string): LogState {
        let s = this.logs.get(sessionId);
        if (!s) { s = { kind: 'cold', gen: this.mint() }; this.logs.set(sessionId, s); }
        return s;
    }
    /** The generation a fetch starting now must carry. */
    gen(sessionId: string): number { return this.state(sessionId).gen; }
    /** Has `gen` been superseded? A session with no log (forgotten) makes every token stale. */
    isStale(sessionId: string, gen: number): boolean {
        const s = this.logs.get(sessionId);
        return !s || s.gen !== gen;
    }
    send(sessionId: string, ev: LogEvent): LogState {
        const next = nextLogState(this.state(sessionId), ev);
        if (next.kind === 'forgotten') this.logs.delete(sessionId);
        else this.logs.set(sessionId, next);
        return next;
    }
    /** Events that need a fresh generation get it from the counter here. */
    reset(sessionId: string): LogState { return this.send(sessionId, { type: 'reset', gen: this.mint() }); }
    recreated(sessionId: string): LogState { return this.send(sessionId, { type: 'recreated', gen: this.mint() }); }
    forget(sessionId: string): void { this.send(sessionId, { type: 'forgotten', gen: this.mint() }); }

    /** The forward cursor, in every state that still has one. */
    lastSeq(sessionId: string): number | undefined {
        const s = this.logs.get(sessionId);
        return s && (s.kind === 'anchored' || s.kind === 'loading_older' || s.kind === 'evicted') ? s.lastSeq : undefined;
    }
    /** The backward anchor, only while the store is held. */
    oldestSeq(sessionId: string): number | undefined {
        const s = this.logs.get(sessionId);
        return s && (s.kind === 'anchored' || s.kind === 'loading_older') && s.oldestSeq !== null ? s.oldestSeq : undefined;
    }
    clear(): void { this.logs.clear(); }
}
