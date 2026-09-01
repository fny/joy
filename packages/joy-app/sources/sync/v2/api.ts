/**
 * Relay v2 client — the native /joy/v2 durable plane, spoken directly.
 *
 * TESTING MODE ONLY (dev "Relay v2 Mode" screens): this bypasses the happy
 * socket sync engine entirely and drives sessions through the v2 REST + SSE
 * surface. Content rides the relay as an opaque "ciphertext" string; this
 * mode uses a readable JSON envelope (encodeContent/decodeContent) instead of
 * real sealing — the encryption seam is those two functions.
 *
 * The relay must be running the v2-mounted server.mjs (the dev relay
 * entrypoint). The base URL is overridable per install (setV2BaseUrl) so the
 * mode can target a local relay without touching the app's main server URL.
 */
import { randomUUID } from 'expo-crypto';
import { getCurrentAuth } from '@/auth/AuthContext';
import { getServerUrl } from '../serverConfig';
import { MMKV } from 'react-native-mmkv';

const v2Config = new MMKV({ id: 'v2-mode-config' });
const V2_URL_KEY = 'v2-base-url';

export function getV2BaseUrl(): string {
    return v2Config.getString(V2_URL_KEY) || getServerUrl();
}
export function setV2BaseUrl(url: string | null): void {
    if (!url || !url.trim()) { v2Config.delete(V2_URL_KEY); return; }
    // Reject non-http(s) and strip a trailing slash — `${base}/joy/v2` with a
    // trailing slash becomes `//joy/v2`, which misses the v2 dispatcher and
    // gets proxied upstream. A malformed value clears the override.
    try {
        const u = new URL(url.trim());
        if (u.protocol !== 'http:' && u.protocol !== 'https:') { v2Config.delete(V2_URL_KEY); return; }
        v2Config.set(V2_URL_KEY, url.trim().replace(/\/+$/, ''));
    } catch { v2Config.delete(V2_URL_KEY); }
}
export function isV2UrlOverridden(): boolean {
    return !!v2Config.getString(V2_URL_KEY);
}

export class V2ApiError extends Error {
    constructor(public status: number, public code: string, public body: unknown) {
        super(`v2 ${status}: ${code}`);
        this.name = 'V2ApiError';
    }
}

function token(): string {
    const t = getCurrentAuth()?.credentials?.token;
    if (!t) throw new V2ApiError(401, 'not_logged_in', null);
    return t;
}

async function v2fetch(method: string, path: string, body?: unknown): Promise<any> {
    const res = await fetch(`${getV2BaseUrl()}/joy/v2${path}`, {
        method,
        headers: {
            'Authorization': `Bearer ${token()}`,
            ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* non-json */ }
    if (!res.ok) throw new V2ApiError(res.status, json?.error ?? `http_${res.status}`, json);
    return json;
}

// ── content envelope (the encryption seam) ──────────────────────────────────

export function encodeContent(text: string): string {
    return JSON.stringify({ v: 1, t: 'plain', text });
}
export function decodeContent(ciphertext: string | null | undefined): string | null {
    if (!ciphertext) return null;
    try {
        const p = JSON.parse(ciphertext);
        if (p && p.t === 'plain' && typeof p.text === 'string') return p.text;
    } catch { /* not our envelope */ }
    // Foreign/undecodable payload: show a marker, never crash the feed.
    return `⟨${ciphertext.length}b payload⟩`;
}

// ── types (mirror the relay projections) ────────────────────────────────────

export interface V2SessionRow {
    sessionId: string;
    daemonId: string;
    localSessionId: string | null;
    state: string;
    revision: string;
    headSeq: string;
    queuedTurns: number;
    sessionKeyEnvelope: string | null;
    encryptedMetadata: string | null;
    online: boolean;
    createdAt: number;
    updatedAt: number;
    lastTurnAt: number | null;
}

export interface V2Machine {
    id: string;
    metadata: string | null;
    metadataVersion: number;
    daemonState: string | null;
    daemonStateVersion: number;
    dataEncryptionKey: string | null;
    seq: number;
    active: boolean;
    activeAt: number;
    createdAt: number;
    updatedAt: number;
    /** Merged by the relay from v2 lease liveness — the queue's own authority. */
    leaseAlive: boolean;
}

export interface V2SessionState {
    sessionId: string;
    revision: string;
    headSeq: string;
    sessionState: string;
    recoveryRequired: boolean;
    /** Set when a spawn failed pre-bind (e.g. 'dir_missing:/path'); the client
     *  offers to create the directory and calls retrySpawn. */
    spawnFailure?: string | null;
    daemon: { daemonId: string; status: 'online' | 'offline'; lastSeenAt: string | null; epoch: string | null };
    queue: { queuedTurns: number; deliveredTurns: number };
    execution: {
        state: 'idle' | 'dispatching' | 'running' | 'cancelling' | 'orphaned';
        turnId: string | null;
        lastProgressAt: string | null;
        suspectedStalled: boolean;
        cancelRequested: boolean;
    };
}

export interface V2Message {
    id: string;
    ciphertext: string;
    status: 'queued' | 'delivering' | 'delivered' | 'failed' | 'cancelled';
    failure?: { reason: string; retryable: boolean; mayHaveDelivered: boolean };
    turnId: string;
    seq: string;
    createdAt: number;
}

export interface V2Event {
    id: string;
    seq: string;
    kind: string;
    turnId: string | null;
    commandId: string | null;
    content: { ciphertext: string } | null;
    createdAt: number;
}

// ── sessions ────────────────────────────────────────────────────────────────

export const v2 = {
    listSessions: (): Promise<{ sessions: V2SessionRow[] }> => v2fetch('GET', '/sessions'),
    listMachines: (): Promise<{ machines: V2Machine[] }> => v2fetch('GET', '/machines'),
    accountProfile: (): Promise<Record<string, unknown>> => v2fetch('GET', '/account/profile'),
    registerPushToken: (token: string) => v2fetch('POST', '/push-tokens', { token }),
    sessionState: (id: string): Promise<V2SessionState> => v2fetch('GET', `/sessions/${id}`),
    // The full option set the new-session screen can set. Keep in sync with the
    // daemon's SpawnSpec (packages/joy-daemon/src/relay/nucleusLane.ts) — a
    // field missing there is an option the user silently cannot use.
    createSession: (machineId: string, spec?: {
        cwd: string;
        agent?: string;
        model?: string;
        effort?: string;
        createDir?: boolean;
        continue?: boolean;
        resume_id?: string;
        resumeLimitMb?: number;
        permissionMode?: string;
        fallbackModel?: string;
        forkSession?: boolean;
        extraArgs?: string;
    }) =>
        v2fetch('POST', '/sessions', {
            mode: 'spawn', daemonId: machineId, creationIntentId: randomUUID(),
            // The daemon's nucleus lane decodes this envelope to launch the
            // real agent session (same plaintext seam as message content).
            ...(spec ? { spawnSpec: JSON.stringify({ v: 1, t: 'spawn', ...spec }) } : {}),
        }),
    deleteSession: (id: string) => v2fetch('DELETE', `/sessions/${id}`),
    // Retry a spawn that FAILED (e.g. directory missing), opting into
    // directory creation — the client half of the v1-parity approval flow.
    retrySpawn: (id: string, createDir: boolean) =>
        v2fetch('POST', `/sessions/${id}/spawn/retry`, { createDir }),

    listMessages: (id: string, status?: string): Promise<{ messages: V2Message[] }> =>
        v2fetch('GET', `/sessions/${id}/messages${status ? `?status=${status}` : ''}`),
    sendMessage: (id: string, text: string, attachments?: string[]) =>
        v2fetch('POST', `/sessions/${id}/messages`, {
            ciphertext: encodeContent(text),
            clientIntentId: randomUUID(),
            ...(attachments?.length ? { attachments } : {}),
        }) as Promise<{ messageId: string; turnId: string; seq: string }>,
    editMessage: (id: string, messageId: string, text: string): Promise<V2Message> =>
        v2fetch('PATCH', `/sessions/${id}/messages/${messageId}`, { ciphertext: encodeContent(text) }),
    moveMessage: (id: string, messageId: string, position: number): Promise<V2Message> =>
        v2fetch('PATCH', `/sessions/${id}/messages/${messageId}`, { position }),
    deleteMessage: (id: string, messageId: string) => v2fetch('DELETE', `/sessions/${id}/messages/${messageId}`),
    retryMessage: (id: string, messageId: string) => v2fetch('POST', `/sessions/${id}/messages/${messageId}/retry`),

    cancelTurn: (id: string, turnId: string) =>
        v2fetch('POST', `/sessions/${id}/turns/${turnId}/cancellations`, { clientIntentId: randomUUID() }),

    listEvents: (id: string, after?: string, limit = 200): Promise<{ messages: V2Event[]; hasMore: boolean }> =>
        v2fetch('GET', `/sessions/${id}/events?after=${after ?? '0'}&limit=${limit}`),

    /** Upload sealed (here: envelope-encoded) bytes; returns the attachment id. */
    uploadAttachment: async (sessionId: string, bytes: Uint8Array): Promise<{ attachmentId: string; size: number }> => {
        const res = await fetch(`${getV2BaseUrl()}/joy/v2/attachments`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token()}`, 'X-Session': sessionId },
            body: bytes as unknown as BodyInit,
        });
        const json = await res.json();
        if (!res.ok) throw new V2ApiError(res.status, (json as any)?.error ?? `http_${res.status}`, json);
        return json as { attachmentId: string; size: number };
    },
};

// ── dual-path helpers (explicit relay base — the session's own v2 relay from
// its metadata link, which may differ from this screen's override) ──────────

async function v2fetchAt(base: string, method: string, path: string, body?: unknown): Promise<any> {
    const res = await fetch(`${base}/joy/v2${path}`, {
        method,
        headers: {
            'Authorization': `Bearer ${token()}`,
            ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) throw new V2ApiError(res.status, (json as any)?.error ?? `http_${res.status}`, json);
    return json;
}

/** Send a PRE-SEALED ciphertext (the dual-path seam encrypts before calling). */
export function v2SendCiphertext(base: string, v2SessionId: string, ciphertext: string): Promise<{ messageId: string; turnId: string }> {
    return v2fetchAt(base, 'POST', `/sessions/${v2SessionId}/messages`, { ciphertext, clientIntentId: randomUUID() });
}

/** The currently executing turn id, or null. */
export async function v2ActiveTurn(base: string, v2SessionId: string): Promise<string | null> {
    const s = await v2fetchAt(base, 'GET', `/sessions/${v2SessionId}`) as V2SessionState;
    return s.execution?.turnId ?? null;
}

export function v2CancelTurn(base: string, v2SessionId: string, turnId: string): Promise<unknown> {
    return v2fetchAt(base, 'POST', `/sessions/${v2SessionId}/turns/${turnId}/cancellations`, { clientIntentId: randomUUID() });
}

// ── SSE doorbell + ephemeral lane ───────────────────────────────────────────

export interface V2StreamHandlers {
    /** Content-free poke: something changed for a session — go pull. */
    onPoke?: (sessionId: string, changed: string[]) => void;
    /** Streaming delta (never persisted); superseded by the durable block. */
    onEphemeral?: (sessionId: string, turnId: string, text: string | null) => void;
    onHello?: (sessions: Array<{ sessionId: string; headSeq: string }>) => void;
    /** Stream ended (network drop, unsupported platform) — poll-only from here. */
    onClose?: () => void;
}

/**
 * Live SSE where the platform supports streaming fetch (web/desktop). On
 * native the reader may be unavailable — callers must ALWAYS poll as the
 * baseline and treat this stream purely as a latency win.
 * Returns an unsubscribe function.
 */
export function connectV2Stream(handlers: V2StreamHandlers): () => void {
    let stopped = false;
    const ctrl = new AbortController();
    (async () => {
        try {
            const res = await fetch(`${getV2BaseUrl()}/joy/v2/events/stream`, {
                headers: { 'Authorization': `Bearer ${token()}` },
                signal: ctrl.signal,
            });
            const reader = (res.body as any)?.getReader?.();
            if (!res.ok || !reader || typeof TextDecoder === 'undefined') {
                if (!stopped) handlers.onClose?.();
                return;
            }
            const decoder = new TextDecoder();
            let buf = '';
            // Frames end on a blank line; normalize CRLF so \r\n\r\n splits too.
            const frameEnd = () => {
                const lf = buf.indexOf('\n\n');
                return lf; // CRLF already normalized to LF below
            };
            while (!stopped) {
                const { value, done } = await reader.read();
                if (done) break;
                buf += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
                let idx: number;
                while ((idx = frameEnd()) >= 0) {
                    const frame = buf.slice(0, idx);
                    buf = buf.slice(idx + 2);
                    let event = 'message';
                    const dataLines: string[] = [];
                    for (const line of frame.split('\n')) {
                        if (line === '' || line.startsWith(':')) continue; // blank / comment
                        const colon = line.indexOf(':');
                        const field = colon === -1 ? line : line.slice(0, colon);
                        // Per the SSE grammar a single leading space after the
                        // colon is stripped; `data:x` (no space) is also valid.
                        let val = colon === -1 ? '' : line.slice(colon + 1);
                        if (val.startsWith(' ')) val = val.slice(1);
                        if (field === 'event') event = val;
                        else if (field === 'data') dataLines.push(val); // multiple → joined
                    }
                    if (dataLines.length === 0) continue;
                    const data = dataLines.join('\n');
                    try {
                        const d = JSON.parse(data);
                        if (event === 'hello') handlers.onHello?.(d.sessions ?? []);
                        else if (event === 'ephemeral') handlers.onEphemeral?.(d.sessionId, d.turnId, decodeContent(d.ciphertext));
                        else handlers.onPoke?.(d.sessionId ?? d.id, d.changed ?? []);
                    } catch { /* malformed frame — skip */ }
                }
            }
        } catch { /* aborted or network drop */ }
        if (!stopped) handlers.onClose?.();
    })();
    return () => { stopped = true; ctrl.abort(); };
}
