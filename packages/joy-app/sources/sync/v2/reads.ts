/**
 * v2 read adapter — serves the app's existing message-fetch engine from the
 * relay's v2 event log.
 *
 * Why an adapter rather than a new pipeline: the v1 read engine (paging,
 * forward/backward cursors, the ORDER-DEPENDENT reducer, eviction re-anchor)
 * is battle-tested and keyed to a monotonic gap-free `seq`. The v2 event log
 * has exactly that shape, so translating events into the same row shape lets
 * the whole proven engine run on v2 with no behavioral change.
 *
 * Mapping (v2 event kind → app row):
 *   turn.queued     → user text message (the prompt)
 *   output          → agent text message
 *   turn.terminal   → agent text when it carries content, else skipped
 *   others          → skipped (lifecycle noise the app does not render)
 *
 * Content is UNSEALED here with the session's v2 key (the same key the send
 * path seals with), then handed over already-decrypted — v2 rows carry
 * `__v2Plain` so the sync layer skips content decryption.
 */
import { openV2Content, openV2Message, openV2Payload } from './crypto';
import { getV2BaseUrl } from './api';

export interface V2Row {
    id: string;
    seq: number;
    localId: string | null;
    createdAt: number;
    updatedAt: number;
    /** Placeholder so code that touches `content` (shape-compatible with the
     *  legacy row) never faults; the real payload is __v2Plain. */
    content: { t: 'plain' };
    /** Already-decrypted content in the app's RawRecord shape. */
    __v2Plain: unknown;
    /** Marks rows that came from the v2 event log (the only source). */
    __fromV2: true;
}

export interface V2Page {
    messages: V2Row[];
    hasMore: boolean;
    /** Highest RAW seq the page covered — lifecycle events that render as
     *  nothing still advance it, so a caller paging forward never re-reads
     *  (and never stalls on) a page with no renderable rows. */
    cursor?: number;
    /** Sealed rows on this page that could not be opened with the given key.
     *  A forward sync must not advance past them (issue #3). */
    unopenable?: number;
    /** The seqs of those rows, ascending — WHICH rows failed, so a caller
     *  records a gap for them alone: a backward read scans (and trims) rows
     *  well below the ones it returns, and a replay reads past the range it
     *  is re-trying; a bare count would stamp rows that opened fine (#128). */
    unopenableSeqs?: number[];
    /** turn.receipted / turn.started seen on this page, in seq order. */
    lifecycle: V2Lifecycle[];
}

interface RawV2Event {
    id: string; seq: string; kind: string;
    turnId: string | null; commandId: string | null;
    /** Who queued a turn.queued: `clientIntentId` is the sender's localId —
     *  the key that lets the relay's row reconcile into the optimistic one. */
    origin?: { clientIntentId?: string | null } | null;
    content: { ciphertext: string } | null;
    createdAt: number;
}

/** Turn lifecycle the chat renders as NOTHING but the optimistic send needs:
 *  receipted = the daemon has the prompt, started = the agent has it. */
export interface V2Lifecycle { turnId: string; kind: 'receipted' | 'started' }

function toLifecycle(e: RawV2Event): V2Lifecycle | null {
    if (!e.turnId) return null;
    if (e.kind === 'turn.receipted') return { turnId: e.turnId, kind: 'receipted' };
    if (e.kind === 'turn.started') return { turnId: e.turnId, kind: 'started' };
    return null;
}

/** Translate one v2 event into an app row, or null when it is not renderable. */
function toRow(e: RawV2Event, key: Uint8Array | null, stats?: { unopenable: number; unopenableSeqs: number[] }): V2Row | null {
    const seq = Number(e.seq);
    const payload = e.content ? openV2Payload(e.content.ciphertext, key) : null;
    const text = payload?.t === 'plain' ? payload.message.text : (e.content && !payload ? openV2Content(e.content.ciphertext, key) : null);
    if (e.content && payload === null && text === null) {
        // Sealed content we could not open (missing/incorrect session key) —
        // loud, because it renders as an empty chat otherwise, and COUNTED,
        // so a forward sync does not step its cursor past rows it never
        // rendered (issue #3: the bind's envelope and first sealed events
        // land together; the events page raced the card and was skipped).
        console.warn(`[v2 reads] could not open ${e.kind} seq=${e.seq} (key=${key ? 'present' : 'MISSING'})`);
        if (stats) { stats.unopenable += 1; stats.unopenableSeqs.push(seq); }
    }

    // A forwarded adapter record (tool call, text, turn lifecycle + usage,
    // terminal-typed prompt): the daemon sealed the SAME wire shape its
    // normalizers produced for the old socket lane, so it goes straight to
    // the normalizer via __v2Plain — tool cards and thinking render as before.
    if (payload?.t === 'record' && (e.kind === 'output' || e.kind === 'turn.terminal')) {
        const data = (payload.record.content as { data?: { time?: unknown } }).data;
        const createdAt = typeof data?.time === 'number' ? data.time : e.createdAt;
        return {
            id: e.id, seq, localId: null, createdAt, updatedAt: e.createdAt, content: { t: 'plain' }, __fromV2: true as const,
            __v2Plain: payload.record,
        };
    }

    if (e.kind === 'turn.queued') {
        // The prompt carries its attachment citations inside the sealed
        // payload; surface them on the user row so the bubble can render
        // them (bytes are fetched lazily by AttachmentView).
        const msg = openV2Message(e.content?.ciphertext, key);
        if (!msg) return null;
        return {
            // localId = the sender's clientIntentId, so THIS device's optimistic
            // row (inserted under that id) reconciles instead of duplicating.
            id: e.id, seq, localId: e.origin?.clientIntentId ?? e.commandId ?? null, createdAt: e.createdAt, updatedAt: e.createdAt, content: { t: 'plain' }, __fromV2: true as const,
            __v2Plain: {
                role: 'user',
                content: { type: 'text', text: msg.text, ...(msg.attachments.length ? { attachments: msg.attachments } : {}) },
                meta: { sentFrom: 'joy', ...(e.turnId ? { turnId: e.turnId } : {}) },
            },
        };
    }
    if (e.kind === 'output' || (e.kind === 'turn.terminal' && text !== null)) {
        if (text === null) return null;
        return {
            id: e.id, seq, localId: null, createdAt: e.createdAt, updatedAt: e.createdAt, content: { t: 'plain' }, __fromV2: true as const,
            // Agent text rides the SESSION ENVELOPE — the same wire shape the
            // daemon emits for v1 (role:'session' → content.data.ev), which the
            // app's normalizer understands. (role:'agent' means a raw Claude
            // transcript record, a different shape entirely.)
            __v2Plain: {
                role: 'session',
                content: {
                    type: 'session',
                    data: {
                        id: e.id,
                        time: e.createdAt,
                        role: 'agent',
                        turn: e.turnId ?? 'v2',
                        ev: { t: 'text', text },
                    },
                },
                meta: { sentFrom: 'joy' },
            },
        };
    }
    return null; // lifecycle events the chat does not render
}

async function fetchEvents(
    base: string, token: string, v2SessionId: string, cursor: number | { before: number }, limit: number,
): Promise<{ events: RawV2Event[]; hasMore: boolean }> {
    // `after` pages forward; `{ before }` asks the relay for the NEWEST events
    // below that seq (ascending), so a backward page is one request (#4).
    const q = typeof cursor === 'number' ? `after=${cursor}` : `before=${cursor.before}`;
    const res = await fetch(`${base}/joy/v2/sessions/${v2SessionId}/events?${q}&limit=${limit}`, {
        headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`v2 events ${res.status}`);
    const j = await res.json() as { messages?: RawV2Event[]; hasMore?: boolean };
    return { events: j.messages ?? [], hasMore: !!j.hasMore };
}

/**
 * Forward page: everything after `afterSeq`. Mirrors the v1 forward sync.
 */
export async function v2MessagesAfter(
    opts: { base?: string; token: string; v2SessionId: string; key: Uint8Array | null; afterSeq: number; limit?: number },
): Promise<V2Page> {
    const base = opts.base ?? getV2BaseUrl();
    const { events, hasMore } = await fetchEvents(base, opts.token, opts.v2SessionId, opts.afterSeq, opts.limit ?? 100);
    const stats = { unopenable: 0, unopenableSeqs: [] as number[] };
    const messages = events.map(e => toRow(e, opts.key, stats)).filter((r): r is V2Row => r !== null);
    const lifecycle = events.map(toLifecycle).filter((l): l is V2Lifecycle => l !== null);
    const cursor = events.length ? Number(events[events.length - 1].seq) : opts.afterSeq;
    return { messages, hasMore, cursor, lifecycle, unopenable: stats.unopenable, unopenableSeqs: stats.unopenableSeqs };
}

/**
 * Backward page: the newest rows BEFORE `beforeSeq` (or the newest overall
 * when beforeSeq is the sentinel). Uses the relay's descending page: walk back
 * from the bound until `limit` renderable rows are in hand or the log is
 * exhausted. (It used to walk the whole log forward from 0 on every page —
 * O(log) requests and decrypts per scroll-up; #4.)
 */
export async function v2MessagesBefore(
    opts: { base?: string; token: string; v2SessionId: string; key: Uint8Array | null; beforeSeq: number; limit?: number },
): Promise<V2Page> {
    const base = opts.base ?? getV2BaseUrl();
    const limit = opts.limit ?? 100;
    const rows: V2Row[] = [];
    const lifecycle: V2Lifecycle[] = [];
    const stats = { unopenable: 0, unopenableSeqs: [] as number[] };
    let bound = Number.isFinite(opts.beforeSeq) ? opts.beforeSeq : Number.MAX_SAFE_INTEGER;
    let olderExists = false;
    for (let pages = 0; pages < 20; pages++) {
        const { events, hasMore } = await fetchEvents(base, opts.token, opts.v2SessionId, { before: bound }, 200);
        if (events.length === 0) { olderExists = false; break; }
        const pageRows: V2Row[] = [];
        const pageLifecycle: V2Lifecycle[] = [];
        for (const e of events) {
            const row = toRow(e, opts.key, stats);
            if (row) pageRows.push(row);
            const l = toLifecycle(e);
            if (l) pageLifecycle.push(l);
        }
        rows.unshift(...pageRows);
        lifecycle.unshift(...pageLifecycle);
        bound = Number(events[0].seq);
        olderExists = hasMore;
        if (!hasMore || rows.length >= limit) break;
    }
    const tail = rows.slice(-limit);
    // `cursor` is the oldest seq scanned — the exclusive bound for the next
    // backward page. It matters when `messages` is empty with hasMore true:
    // 20 pages of non-renderable rows must still let the caller keep walking
    // instead of declaring history exhausted (Astra on 9664fd12, #4).
    // When the scan overshot the limit, the discarded rows are OLDER than the
    // returned ones: the bound must be the oldest returned row, not the oldest
    // scanned, or those rows are skipped for good (Astra on bfcec9fd).
    const cursor = rows.length > tail.length ? tail[0].seq : bound;
    // Failures are reported by seq (pages were walked newest-first, so sort):
    // the ones below `cursor` are NOT covered by the returned span, and the
    // caller must not blame the rows it did get for them (#128).
    const unopenableSeqs = stats.unopenableSeqs.sort((a, b) => a - b);
    return { messages: tail, hasMore: olderExists || rows.length > tail.length, lifecycle, unopenable: stats.unopenable, unopenableSeqs, cursor };
}
