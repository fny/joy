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
import { b64encode } from './encryption';
import type { Credentials } from './credentials';

const log = logger('relay');

export interface RawMessage {
    id: string;
    seq: number;
    /** base64-encoded encrypted blob */
    content: string;
    localId: string | null;
    createdAt: number;
    updatedAt: number;
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
