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
import { openV2Content, openV2Message } from './crypto';
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
}

interface RawV2Event {
    id: string; seq: string; kind: string;
    turnId: string | null; commandId: string | null;
    content: { ciphertext: string } | null;
    createdAt: number;
}

/** Translate one v2 event into an app row, or null when it is not renderable. */
function toRow(e: RawV2Event, key: Uint8Array | null): V2Row | null {
    const seq = Number(e.seq);
    const text = e.content ? openV2Content(e.content.ciphertext, key) : null;
    if (e.content && text === null) {
        // Sealed content we could not open (missing/incorrect session key) —
        // loud, because it renders as an empty chat otherwise.
        console.warn(`[v2 reads] could not open ${e.kind} seq=${e.seq} (key=${key ? 'present' : 'MISSING'})`);
    }

    if (e.kind === 'turn.queued') {
        // The prompt carries its attachment citations inside the sealed
        // payload; surface them on the user row so the bubble can render
        // them (bytes are fetched lazily by AttachmentView).
        const msg = openV2Message(e.content?.ciphertext, key);
        if (!msg) return null;
        return {
            id: e.id, seq, localId: e.commandId ?? null, createdAt: e.createdAt, updatedAt: e.createdAt, content: { t: 'plain' }, __fromV2: true as const,
            __v2Plain: { role: 'user', content: { type: 'text', text: msg.text, ...(msg.attachments.length ? { attachments: msg.attachments } : {}) } },
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
    base: string, token: string, v2SessionId: string, afterSeq: number, limit: number,
): Promise<{ events: RawV2Event[]; hasMore: boolean }> {
    const res = await fetch(`${base}/joy/v2/sessions/${v2SessionId}/events?after=${afterSeq}&limit=${limit}`, {
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
    const messages = events.map(e => toRow(e, opts.key)).filter((r): r is V2Row => r !== null);
    const cursor = events.length ? Number(events[events.length - 1].seq) : opts.afterSeq;
    return { messages, hasMore, cursor };
}

/**
 * Backward page: the newest rows BEFORE `beforeSeq` (or the newest overall
 * when beforeSeq is the sentinel). The v2 log only pages forward, so we walk
 * forward from 0 collecting rows below the bound and keep the last `limit` —
 * correct, and bounded by the log's own pagination.
 */
export async function v2MessagesBefore(
    opts: { base?: string; token: string; v2SessionId: string; key: Uint8Array | null; beforeSeq: number; limit?: number },
): Promise<V2Page> {
    const base = opts.base ?? getV2BaseUrl();
    const limit = opts.limit ?? 100;
    const rows: V2Row[] = [];
    let cursor = 0;
    for (;;) {
        const { events, hasMore } = await fetchEvents(base, opts.token, opts.v2SessionId, cursor, 500);
        if (events.length === 0) break;
        for (const e of events) {
            const seq = Number(e.seq);
            if (seq >= opts.beforeSeq) continue;
            const row = toRow(e, opts.key);
            if (row) rows.push(row);
        }
        cursor = Number(events[events.length - 1].seq);
        if (!hasMore) break;
        if (cursor >= opts.beforeSeq) break;
    }
    const tail = rows.slice(-limit);
    return { messages: tail, hasMore: rows.length > tail.length };
}
