/**
 * The v2 live driver as an explicit machine. Pure, import-free.
 *
 * Sessions ride the relay's SSE doorbell with a poll fallback. The engine
 * (sync.ts) used to keep this as five fields — the stream's stop function,
 * the poll timer, the reconnect timer, a stopped flag, the last successful
 * read — and a store field for the indicator, and the pieces disagreed:
 * a stop/start inside the reconnect window let the old timer open a SECOND
 * stream over the new driver's (#408); the reconnect was a fixed 3 s with
 * no backoff; `error` was declared for the indicator and never produced;
 * and "connected" meant one thing to the stream's close handler and
 * another to the poll.
 *
 * Every stream attempt here is a GENERATION. `hello`, `close` and the retry
 * timer name the attempt they belong to, and an event from a retired
 * generation is ignored — so a stale timer cannot open a stream, by
 * construction. The indicator is ONE pure function of the state and the
 * age of the last successful read, whichever transport made it: the SSE
 * stream cannot open on React Native at all, so its state must never be
 * the app's.
 */
export type LiveConn =
    | { kind: 'stopped' }
    | { kind: 'connecting'; gen: number; attempt: number }
    | { kind: 'streaming'; gen: number }
    | { kind: 'polling_reconnect'; gen: number; attempt: number; retryAt: number };

export type LiveDriverState = {
    conn: LiveConn;
    /** The next generation to mint; never reused within a process. */
    nextGen: number;
    /** Wall time of the last read that reached the relay, 0 = never. */
    lastOkAt: number;
    /** Wall time of the last read that failed, 0 = never. */
    lastFailAt: number;
};

export type LiveDriverEvent =
    | { type: 'start' }
    | { type: 'stop' }
    | { type: 'hello'; gen: number; now: number }
    | { type: 'close'; gen: number; now: number }
    /** The reconnect timer armed for `gen` fired. */
    | { type: 'retry_due'; gen: number; now: number }
    | { type: 'read_ok'; now: number }
    | { type: 'read_failed'; now: number }
    /** A doorbell; carries no state (listed so the table is total). */
    | { type: 'poke' };

export type Indicator = 'disconnected' | 'connecting' | 'connected' | 'error';

export const RECONNECT_BASE_MS = 3_000;
export const RECONNECT_MAX_MS = 30_000;
/** Consecutive failed attempts before the indicator calls it an error. */
export const ERROR_AFTER_ATTEMPTS = 5;

export function reconnectDelayMs(attempt: number): number {
    return Math.min(RECONNECT_BASE_MS * 2 ** Math.max(0, attempt - 1), RECONNECT_MAX_MS);
}

export function initialLiveDriver(): LiveDriverState {
    return { conn: { kind: 'stopped' }, nextGen: 1, lastOkAt: 0, lastFailAt: 0 };
}

export function nextLiveDriver(s: LiveDriverState, ev: LiveDriverEvent): LiveDriverState {
    // Reads are transport-agnostic and count in every non-stopped state.
    if (ev.type === 'read_ok') return s.conn.kind === 'stopped' ? s : { ...s, lastOkAt: ev.now };
    if (ev.type === 'read_failed') return s.conn.kind === 'stopped' ? s : { ...s, lastFailAt: ev.now };
    if (ev.type === 'poke') return s;
    if (ev.type === 'stop') return { ...s, conn: { kind: 'stopped' } };

    const c = s.conn;
    switch (c.kind) {
        case 'stopped':
            switch (ev.type) {
                case 'start': return { ...s, conn: { kind: 'connecting', gen: s.nextGen, attempt: 1 }, nextGen: s.nextGen + 1 };
                case 'hello': return s;
                case 'close': return s;
                case 'retry_due': return s;
            }
            return unreachable(ev);
        case 'connecting':
            switch (ev.type) {
                case 'start': return s; // already driving
                case 'hello': return ev.gen === c.gen ? { ...s, conn: { kind: 'streaming', gen: c.gen }, lastOkAt: ev.now } : s;
                case 'close': return ev.gen === c.gen
                    ? { ...s, conn: { kind: 'polling_reconnect', gen: c.gen, attempt: c.attempt, retryAt: ev.now + reconnectDelayMs(c.attempt) } }
                    : s;
                case 'retry_due': return s;
            }
            return unreachable(ev);
        case 'streaming':
            switch (ev.type) {
                case 'start': return s;
                case 'hello': return s;
                // A stream that carried data drops: the first retry is quick.
                case 'close': return ev.gen === c.gen
                    ? { ...s, conn: { kind: 'polling_reconnect', gen: c.gen, attempt: 1, retryAt: ev.now + reconnectDelayMs(1) } }
                    : s;
                case 'retry_due': return s;
            }
            return unreachable(ev);
        case 'polling_reconnect':
            switch (ev.type) {
                case 'start': return s;
                case 'hello': return s;   // no stream is open in this state; a late hello is a retired one
                case 'close': return s;
                case 'retry_due':
                    if (ev.gen !== c.gen || ev.now < c.retryAt) return s;
                    return { ...s, conn: { kind: 'connecting', gen: s.nextGen, attempt: c.attempt + 1 }, nextGen: s.nextGen + 1 };
            }
            return unreachable(ev);
    }
    return unreachable(c);
}

/**
 * The one notion of connected. Precedence: a stopped driver is offline; a
 * read that landed within three polls is connected whatever the stream is
 * doing; never having read anything is the cold start's "connecting"
 * (#11); then a failure since the last good read is offline — or an error
 * once the stream has failed repeatedly on top of it; and a quiet gap with
 * nothing failed (the app was backgrounded, no polls ran) keeps the last
 * good answer.
 */
export function indicatorOf(s: LiveDriverState, now: number, pollIntervalMs: number): Indicator {
    if (s.conn.kind === 'stopped') return 'disconnected';
    if (s.lastOkAt > 0 && now - s.lastOkAt < 3 * pollIntervalMs) return 'connected';
    if (s.lastOkAt === 0) return s.lastFailAt > 0 && s.conn.kind === 'polling_reconnect' && s.conn.attempt >= ERROR_AFTER_ATTEMPTS ? 'error' : 'connecting';
    if (s.lastFailAt > s.lastOkAt) {
        return s.conn.kind === 'polling_reconnect' && s.conn.attempt >= ERROR_AFTER_ATTEMPTS ? 'error' : 'disconnected';
    }
    return 'connected';
}

function unreachable(x: never): never {
    throw new Error(`liveDriver: unhandled ${JSON.stringify(x)}`);
}
