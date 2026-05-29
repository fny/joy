/**
 * Relay client — the daemon's single connection to happy-server.
 *
 * Implements only what the comm layer needs (spec §6, server untouched):
 *  - append(sessionId, encrypted) → POST /v3/sessions/:id/messages
 *  - readSince(sessionId, afterSeq, limit) → GET …?after_seq=N
 *  - readBefore(sessionId, beforeSeq, limit) → GET …?before_seq=N
 *  - subscribe(sessionId, onPoke) → transient socket "poke" notifier
 *
 * Reconnection is built-in for the socket; HTTP retries are the outbox's
 * responsibility (§10).
 */
import { io, Socket } from 'socket.io-client';
import { logger } from '../util/log';
import {
    b64encode,
    b64decode,
    encrypt,
    libsodiumEncryptForPublicKey,
    randomBytesU8,
    type EncryptionVariant,
} from './encryption';
import type { Credentials } from './credentials';

const log = logger('relay');

/**
 * Wire-shape of `content` as RETURNED by GET /v3/.../messages:
 * either a plain base64 string (POSTed by older clients) or an object
 * envelope `{ c: <base64>, t: 'encrypted' }`. We accept both.
 */
export type RawContent = string | { c: string; t?: string };

export interface RawMessage {
    id: string;
    seq: number;
    content: RawContent;
    localId: string | null;
    createdAt: number;
    updatedAt: number;
}

/** Extract the base64 ciphertext from either wire shape. */
export function rawContentB64(content: RawContent): string | null {
    if (typeof content === 'string') return content;
    if (content && typeof content === 'object' && typeof content.c === 'string') return content.c;
    return null;
}

export interface AppendResult {
    /** Server-assigned seq for the appended record. */
    seq: number;
    id: string;
}

export interface ReadResult {
    messages: RawMessage[];
    hasMore: boolean;
}

export interface CreateSessionResult {
    /** Server-assigned session id (canonical). */
    sessionId: string;
    /** Per-session content key (32 bytes). */
    sessionKey: Uint8Array;
    /** Wire-encryption variant used for this session's payloads. */
    variant: EncryptionVariant;
}

export class RelayClient {
    private readonly creds: Credentials;
    private socket: Socket | null = null;
    private listeners: Map<string, Set<() => void>> = new Map();

    constructor(creds: Credentials) {
        this.creds = creds;
    }

    /** Open the persistent socket connection used for pokes. */
    connect(): void {
        if (this.socket) return;
        this.socket = io(this.creds.serverUrl, {
            transports: ['websocket'],
            auth: { token: this.creds.token, clientType: 'machine-scoped' },
            reconnection: true,
            reconnectionDelay: 1_000,
            reconnectionDelayMax: 10_000,
        });
        this.socket.on('connect', () => log.info('socket connected'));
        this.socket.on('disconnect', (r) => log.warn('socket disconnected', { reason: r }));
        this.socket.on('update', (payload: unknown) => this.handlePoke(payload));
    }

    close(): void {
        this.socket?.close();
        this.socket = null;
    }

    private handlePoke(payload: unknown): void {
        // The server's broadcast carries a sessionId when relevant; if absent,
        // poke every subscriber (loss-tolerant — they will pull and no-op if
        // there is nothing new).
        const sid = isObj(payload) ? String(payload.sessionId ?? '') : '';
        if (sid && this.listeners.has(sid)) {
            for (const cb of this.listeners.get(sid)!) try { cb(); } catch (e) { log.error('poke handler threw', { e: String(e) }); }
            return;
        }
        for (const set of this.listeners.values()) for (const cb of set) try { cb(); } catch (e) { log.error('poke handler threw', { e: String(e) }); }
    }

    subscribe(sessionId: string, onPoke: () => void): () => void {
        let set = this.listeners.get(sessionId);
        if (!set) {
            set = new Set();
            this.listeners.set(sessionId, set);
        }
        set.add(onPoke);
        return () => {
            set!.delete(onPoke);
            if (set!.size === 0) this.listeners.delete(sessionId);
        };
    }

    private url(path: string): string {
        return `${this.creds.serverUrl.replace(/\/$/, '')}${path}`;
    }

    private headers(extra: Record<string, string> = {}): Record<string, string> {
        return { Authorization: `Bearer ${this.creds.token}`, 'Content-Type': 'application/json', ...extra };
    }

    /**
     * Create (or load by tag) a session on the relay. Mirrors happy-cli's
     * getOrCreateSession (POST /v1/sessions). Returns the server-assigned
     * session id and the per-session content key joy will use for all
     * subsequent append/read calls.
     *
     * For dataKey variant credentials, this mints a fresh 32-byte content
     * key, encrypts it for the account's publicKey (libsodium box), prefixes
     * the version byte 0x00 and ships it as `dataEncryptionKey`. For legacy
     * credentials, the per-session key IS the master secret and the server
     * stores no key material.
     */
    async createSession(opts: {
        tag: string;
        metadata: unknown;
    }): Promise<CreateSessionResult> {
        let sessionKey: Uint8Array;
        let variant: EncryptionVariant;
        let dataEncryptionKeyB64: string | null = null;
        if (this.creds.encryption.type === 'dataKey') {
            sessionKey = randomBytesU8(32);
            variant = 'dataKey';
            const encryptedKey = libsodiumEncryptForPublicKey(sessionKey, this.creds.encryption.publicKey);
            const bundle = new Uint8Array(1 + encryptedKey.length);
            bundle.set([0], 0);
            bundle.set(encryptedKey, 1);
            dataEncryptionKeyB64 = b64encode(bundle);
        } else {
            sessionKey = this.creds.encryption.secret;
            variant = 'legacy';
        }
        const metadataB64 = b64encode(encrypt(variant, sessionKey, opts.metadata));
        const body = JSON.stringify({
            tag: opts.tag,
            metadata: metadataB64,
            agentState: null,
            dataEncryptionKey: dataEncryptionKeyB64,
        });
        const res = await fetch(this.url('/v1/sessions'), {
            method: 'POST',
            headers: this.headers(),
            body,
        });
        if (!res.ok) {
            const text = await res.text().catch(() => '');
            throw new Error(`relay createSession failed: HTTP ${res.status} ${text}`);
        }
        const data = (await res.json()) as { session: { id: string; seq: number; dataEncryptionKey?: string | null } };
        // If the server returned an existing session with a stored
        // dataEncryptionKey, that means a prior client created it; we have
        // no private key to decrypt that blob from inside the daemon, so we
        // surface only what we minted locally. For legacy variant the key is
        // the master secret regardless.
        return { sessionId: data.session.id, sessionKey, variant };
    }

    async append(sessionId: string, encrypted: Uint8Array, localId: string): Promise<AppendResult> {
        const body = JSON.stringify({
            messages: [{ content: b64encode(encrypted), localId }],
        });
        const res = await fetch(this.url(`/v3/sessions/${encodeURIComponent(sessionId)}/messages`), {
            method: 'POST',
            headers: this.headers(),
            body,
        });
        if (!res.ok) {
            const text = await res.text().catch(() => '');
            throw new Error(`relay append failed: HTTP ${res.status} ${text}`);
        }
        const data = (await res.json()) as { messages: RawMessage[] };
        const m = data.messages?.[0];
        if (!m) throw new Error('relay append: server returned no message');
        return { seq: m.seq, id: m.id };
    }

    async readSince(sessionId: string, afterSeq: number, limit = 100): Promise<ReadResult> {
        const u = this.url(`/v3/sessions/${encodeURIComponent(sessionId)}/messages?after_seq=${afterSeq}&limit=${limit}`);
        const res = await fetch(u, { headers: this.headers() });
        if (!res.ok) throw new Error(`relay readSince failed: HTTP ${res.status}`);
        return (await res.json()) as ReadResult;
    }

    /**
     * Mark a session as active by emitting `session-alive` over the socket.
     * The server flips `session.active = true` and the UI sidebar starts
     * showing it. Without this the session is created but reads as inactive.
     */
    emitSessionAlive(sessionId: string, opts?: { thinking?: boolean; mode?: 'local' | 'remote' }): void {
        if (!this.socket) return;
        this.socket.volatile.emit('session-alive', {
            sid: sessionId,
            time: Date.now(),
            thinking: opts?.thinking ?? false,
            mode: opts?.mode ?? 'remote',
        });
    }

    async readBefore(sessionId: string, beforeSeq: number, limit = 100): Promise<ReadResult> {
        const u = this.url(`/v3/sessions/${encodeURIComponent(sessionId)}/messages?before_seq=${beforeSeq}&limit=${limit}`);
        const res = await fetch(u, { headers: this.headers() });
        if (!res.ok) throw new Error(`relay readBefore failed: HTTP ${res.status}`);
        return (await res.json()) as ReadResult;
    }
}

function isObj(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null;
}
