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

    const pull = React.useCallback(async () => {
        try {
            const [s, m] = await Promise.all([v2.sessionState(sessionId), v2.listMessages(sessionId)]);
            setState(s);
            setMessages(m.messages);
            // Cursored event pull; loop while the log is ahead of us.
            for (;;) {
                const page = await v2.listEvents(sessionId, cursor.current);
                const fresh = page.messages.filter(e => !known.current.has(e.id));
                if (fresh.length > 0) {
                    for (const e of fresh) known.current.add(e.id);
                    cursor.current = page.messages[page.messages.length - 1]?.seq ?? cursor.current;
                    setEvents(prev => [...prev, ...fresh]);
                    // A durable output/terminal block supersedes the streaming text.
                    setStreaming(prev => {
                        const next = { ...prev };
                        for (const e of fresh) if (e.turnId && e.content) delete next[e.turnId];
                        return next;
                    });
                } else if (page.messages.length > 0) {
                    cursor.current = page.messages[page.messages.length - 1].seq;
                }
                if (!page.hasMore) break;
            }
            setError(null);
        } catch (e) {
            setError(String(e));
        }
    }, [sessionId]);

    React.useEffect(() => {
        let alive = true;
        void pull();
        const timer = setInterval(() => { if (alive) void pull(); }, POLL_MS);
        const unsub = connectV2Stream({
            onPoke: (sid) => { if (alive && sid === sessionId) void pull(); },
            onEphemeral: (sid, turnId, text) => {
                if (!alive || sid !== sessionId || text === null) return;
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
