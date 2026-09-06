/**
 * Relay v2 client — the native /joy/v2 durable plane, spoken directly.
 *
 * This is the app's ONLY transport: sessions are driven through the v2 REST +
 * SSE surface. Content rides the relay as an opaque "ciphertext" string; the
 * dev "Relay v2 Mode" screens use a readable JSON envelope
 * (encodeContent/decodeContent) instead of real sealing — the encryption seam
 * is those two functions.
 *
 * The relay must be running the v2-mounted server.mjs (the dev relay
 * entrypoint). The base URL is overridable per install (setV2BaseUrl) so the
 * mode can target a local relay without touching the app's main server URL.
 */
import { randomUUID } from 'expo-crypto';
import { getCurrentAuth } from '@/auth/AuthContext';
import { getServerUrl } from '../serverConfig';
import { MMKV } from 'react-native-mmkv';
import { createSseParser } from './sse';
import { encodeSpawnSpec } from './spawnSpec';

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

export const v2 = {
    listSessions: (): Promise<{ sessions: V2SessionRow[] }> => v2fetch('GET', '/sessions'),
    listMachines: (): Promise<{ machines: V2Machine[] }> => v2fetch('GET', '/machines'),
    deleteMachine: (id: string) => v2fetch('DELETE', `/machines/${id}`),
    /** CAS update of the sealed machine metadata; `version-mismatch` returns the current record. */
    patchMachine: (id: string, body: { metadata: string; expectedMetadataVersion: number }): Promise<{
        result: 'success' | 'version-mismatch' | 'error';
        metadataVersion?: number;
        metadata?: string;
        error?: string;
    }> => v2fetch('PATCH', `/machines/${id}`, body),
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
        /** Clone this repository into cwd before launching (the daemon clones
         *  first and reports `clone_failed:<msg>` as a spawn failure; #151). */
        gitUrl?: string;
    }, opts?: {
        /** The creation's identity at the relay. The relay dedupes by
         *  (account, actor, creationIntentId) and REPLAYS the accepted
         *  session for a repeat — so a retry after a lost response must pass
         *  the SAME id (spawn.ts allocates it before the first POST; #417).
         *  Omitted → a fresh id, i.e. a distinct creation. */
        creationIntentId?: string;
        /** Seal the spec (see spawnSpec.ts) instead of sending plain JSON.
         *  Only valid once the target daemon opens sealed specs — today no
         *  caller passes a key, so the wire is unchanged (#107). */
        sealKey?: Uint8Array | null;
    }) =>
        v2fetch('POST', '/sessions', {
            mode: 'spawn', daemonId: machineId, creationIntentId: opts?.creationIntentId ?? randomUUID(),
            // The daemon's nucleus lane decodes this envelope to launch the
            // real agent session. Plain JSON until the daemon side of #107
            // lands (the relay stores it verbatim, so cwd/extraArgs are
            // readable there — see spawnSpec.ts for the sealed contract).
            ...(spec ? { spawnSpec: encodeSpawnSpec(spec, opts?.sealKey ?? null) } : {}),
        }),
    deleteSession: (id: string) => v2fetch('DELETE', `/sessions/${id}`),
    // Retry a spawn that FAILED (e.g. directory missing), opting into
    // directory creation — the client half of the v1-parity approval flow.
    retrySpawn: (id: string, createDir: boolean) =>
        v2fetch('POST', `/sessions/${id}/spawn/retry`, { createDir }),
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

/** Send a PRE-SEALED ciphertext (the dual-path seam encrypts before calling).
 *  `attachments` are the relay ids the sealed content cites — the relay
 *  validates they exist for this session and pins them to the message. */
/** `clientIntentId` is the message's identity at the relay: a retry MUST
 *  reuse it (the draft-release path passes its persisted localId) so the
 *  relay replays the first acceptance instead of queueing a second turn. */
export function v2SendCiphertext(base: string, v2SessionId: string, ciphertext: string, clientIntentId: string, attachments?: string[]): Promise<{ messageId: string; turnId: string }> {
    return v2fetchAt(base, 'POST', `/sessions/${v2SessionId}/messages`, {
        ciphertext, clientIntentId,
        ...(attachments?.length ? { attachments } : {}),
    });
}

/** Upload PRE-SEALED attachment bytes for a session. `cipherHash` is the
 *  sha256 hex of exactly these bytes (the relay rejects a mismatch, and
 *  dedupes a retried upload to the same id). */
export async function v2UploadAttachment(base: string, v2SessionId: string, bytes: Uint8Array, cipherHash: string): Promise<{ attachmentId: string; size: number }> {
    const res = await fetch(`${base}/joy/v2/attachments`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token()}`,
            'Content-Type': 'application/octet-stream',
            'X-Session': v2SessionId,
            'X-Cipher-Hash': cipherHash,
        },
        body: bytes as unknown as BodyInit,
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) throw new V2ApiError(res.status, (json as any)?.error ?? `http_${res.status}`, json);
    return json as { attachmentId: string; size: number };
}

/** Download the sealed bytes of an attachment (opened by the caller). */
export async function v2FetchAttachment(base: string, attachmentId: string): Promise<Uint8Array> {
    const res = await fetch(`${base}/joy/v2/attachments/${attachmentId}`, {
        headers: { 'Authorization': `Bearer ${token()}` },
    });
    if (!res.ok) throw new V2ApiError(res.status, `http_${res.status}`, null);
    return new Uint8Array(await res.arrayBuffer());
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
    /** An ephemeral output frame landed (the app only re-reads; the text stays sealed). */
    onEphemeral?: (sessionId: string, turnId: string) => void;
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
            // Frame splitting lives in sse.ts: it carries a CR across chunk
            // boundaries so a CRLF split by the network still ends a frame
            // and never leaks into an event name (#414).
            const parser = createSseParser(({ event, data }) => {
                try {
                    const d = JSON.parse(data);
                    if (event === 'hello') handlers.onHello?.(d.sessions ?? []);
                    else if (event === 'ephemeral') handlers.onEphemeral?.(d.sessionId, d.turnId);
                    else handlers.onPoke?.(d.sessionId ?? d.id, d.changed ?? []);
                } catch { /* malformed frame — skip */ }
            });
            while (!stopped) {
                const { value, done } = await reader.read();
                if (done) break;
                parser.push(decoder.decode(value, { stream: true }));
            }
        } catch { /* aborted or network drop */ }
        if (!stopped) handlers.onClose?.();
    })();
    return () => { stopped = true; ctrl.abort(); };
}
