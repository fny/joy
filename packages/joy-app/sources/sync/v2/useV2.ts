/**
 * Live state hooks for the dev "Relay v2 Mode" screens.
 *
 * Polling is the BASELINE (works on every platform); the SSE stream attaches
 * opportunistically and only improves latency: pokes trigger an immediate
 * pull, ephemeral frames paint streaming text that the next durable output
 * block supersedes. Nothing here touches the main sync engine.
 */
import * as React from 'react';
import {
    v2, connectV2Stream, decodeContent,
    type V2SessionRow, type V2SessionState, type V2Message, type V2Event,
} from './api';

const POLL_MS = 2500;

export function useV2Sessions() {
    const [sessions, setSessions] = React.useState<V2SessionRow[] | null>(null);
    const [error, setError] = React.useState<string | null>(null);
    const pull = React.useCallback(async () => {
        try {
            const r = await v2.listSessions();
            setSessions(r.sessions);
            setError(null);
        } catch (e) {
            setError(String(e));
        }
    }, []);
    React.useEffect(() => {
        let alive = true;
        void pull();
        const timer = setInterval(() => { if (alive) void pull(); }, POLL_MS);
        const unsub = connectV2Stream({ onPoke: () => { if (alive) void pull(); } });
        return () => { alive = false; clearInterval(timer); unsub(); };
    }, [pull]);
    return { sessions, error, refresh: pull };
}

export interface V2SessionLive {
    state: V2SessionState | null;
    messages: V2Message[];
    events: V2Event[];
    /** Current streaming text per turn (ephemeral lane; cleared by durable output). */
    streaming: Record<string, string>;
    sseLive: boolean;
    error: string | null;
    refresh: () => Promise<void>;
}

export function useV2Session(sessionId: string): V2SessionLive {
    const [state, setState] = React.useState<V2SessionState | null>(null);
    const [messages, setMessages] = React.useState<V2Message[]>([]);
    const [events, setEvents] = React.useState<V2Event[]>([]);
    const [streaming, setStreaming] = React.useState<Record<string, string>>({});
    const [sseLive, setSseLive] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);
    const cursor = React.useRef('0');
    const known = React.useRef(new Set<string>());
    // Serialize pulls: an in-flight guard so overlapping timer/poke/refresh
    // calls can't interleave and let an older response clobber newer state or
    // walk the cursor backwards. A pull requested while one runs re-runs once.
    const pulling = React.useRef(false);
    const pending = React.useRef(false);
    // Turns that reached a durable terminal — a late ephemeral frame for one
    // must NOT resurrect its streaming bubble (poll-clears / SSE-arrives race).
    const settled = React.useRef(new Set<string>());

    // Reset ALL cursored state when the session id changes — otherwise a reused
    // component instance shows session A's events and asks B for events after
    // A's cursor, skipping B's history (per-session sequence spaces).
    React.useEffect(() => {
        cursor.current = '0';
        known.current = new Set();
        settled.current = new Set();
        setState(null); setMessages([]); setEvents([]); setStreaming({}); setError(null);
    }, [sessionId]);

    const pullOnce = React.useCallback(async () => {
        const [s, m] = await Promise.all([v2.sessionState(sessionId), v2.listMessages(sessionId)]);
        setState(s);
        setMessages(m.messages);
        for (;;) {
            const page = await v2.listEvents(sessionId, cursor.current);
            const fresh = page.messages.filter(e => !known.current.has(e.id));
            const lastSeq = page.messages[page.messages.length - 1]?.seq;
            // Cursor only ever moves FORWARD (a late duplicate page must not
            // rewind it and re-stream settled turns).
            if (lastSeq && Number(lastSeq) > Number(cursor.current)) cursor.current = lastSeq;
            if (fresh.length > 0) {
                for (const e of fresh) known.current.add(e.id);
                setEvents(prev => [...prev, ...fresh]);
                // ANY durable block for a turn (output OR a terminal event,
                // which may carry no content) ends its streaming text.
                setStreaming(prev => {
                    const next = { ...prev };
                    for (const e of fresh) {
                        if (!e.turnId) continue;
                        if (e.kind === 'turn.terminal') settled.current.add(e.turnId);
                        if (e.content || e.kind === 'turn.terminal') delete next[e.turnId];
                    }
                    return next;
                });
            }
            if (!page.hasMore) break;
        }
        setError(null);
    }, [sessionId]);

    const pull = React.useCallback(async () => {
        if (pulling.current) { pending.current = true; return; }
        pulling.current = true;
        try {
            do {
                pending.current = false;
                await pullOnce();
            } while (pending.current);
        } catch (e) {
            setError(String(e));
        } finally {
            pulling.current = false;
        }
    }, [pullOnce]);

    React.useEffect(() => {
        let alive = true;
        void pull();
        const timer = setInterval(() => { if (alive) void pull(); }, POLL_MS);
        const unsub = connectV2Stream({
            onPoke: (sid) => { if (alive && sid === sessionId) void pull(); },
            onEphemeral: (sid, turnId, text) => {
                if (!alive || sid !== sessionId || text === null) return;
                if (settled.current.has(turnId)) return; // turn already ended — ignore
                setStreaming(prev => ({ ...prev, [turnId]: (prev[turnId] ?? '') + text }));
            },
            onHello: () => { if (alive) setSseLive(true); },
            onClose: () => { if (alive) setSseLive(false); },
        });
        return () => { alive = false; clearInterval(timer); unsub(); };
    }, [sessionId, pull]);

    return { state, messages, events, streaming, sseLive, error, refresh: pull };
}

/** Human line for an event row in the feed. */
export function describeEvent(e: V2Event): { who: 'user' | 'agent' | 'system'; text: string } {
    const body = decodeContent(e.content?.ciphertext);
    switch (e.kind) {
        case 'turn.queued': return { who: 'user', text: body ?? '(empty prompt)' };
        case 'message.edited': return { who: 'system', text: `edited → ${body ?? ''}` };
        case 'turn.requeued': return { who: 'system', text: 'retried after orphan' };
        case 'turn.receipted': return { who: 'system', text: 'daemon receipted the prompt' };
        case 'turn.cancel_requested': return { who: 'system', text: 'cancellation requested' };
        case 'turn.terminal': return { who: 'system', text: body ? `turn ended — ${body}` : 'turn ended' };
        case 'session.provisioned': return { who: 'system', text: 'session provisioned' };
        default:
            if (body !== null) return { who: 'agent', text: body };
            return { who: 'system', text: e.kind };
    }
}
