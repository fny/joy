/**
 * Persisted idempotent outbox — comm-layer-spec §10.
 *
 * Each event is keyed by its `eventId` (uuidv4). The outbox is durable on
 * disk so a daemon restart preserves unacked work. An item is removed only
 * once the consumer observes its `eventId` echoed back from the relay
 * carrying a server `seq` ("echo-ack"). Retry is exponential with full
 * jitter (CONSTANTS.BACKOFF_*).
 *
 * Storage layout (per session):
 *   ${sessionDir(id)}/outbox.ndjson   — one JSON object per line, in append order
 */
import { existsSync, readFileSync, writeFileSync, appendFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '../util/log';
import { CONSTANTS } from '../protocol/constants';
import { backoffMs, sleep } from '../util/backoff';
import { sessionDir } from '../util/paths';
import { encrypt, type EncryptionVariant } from './encryption';
import type { RelayClient } from './relayClient';
import type { Envelope } from '../protocol/envelope';
import { encodeForWire } from '../wire/legacyFacade';

const log = logger('outbox');

export interface OutboxEntry {
    eventId: string;
    envelope: Envelope;
    /** Server-assigned seq once echoed. null until then. */
    ackedSeq: number | null;
    createdAt: number;
    attempts: number;
}

interface OutboxLineEntry {
    kind?: 'entry';
    entry: OutboxEntry;
}
interface OutboxLineAck {
    kind: 'ack';
    eventId: string;
    seq: number;
}

export interface OutboxOpts {
    sessionId: string;
    relay: RelayClient;
    sessionKey: Uint8Array;
    variant: EncryptionVariant;
    onAck?: (entry: OutboxEntry) => void;
    signal: AbortSignal;
}

export class Outbox {
    private readonly path: string;
    private readonly opts: OutboxOpts;
    private entries: OutboxEntry[] = [];
    private inFlight: Promise<void> | null = null;

    constructor(opts: OutboxOpts) {
        this.opts = opts;
        this.path = join(sessionDir(opts.sessionId), 'outbox.ndjson');
        this.load();
    }

    private load(): void {
        if (!existsSync(this.path)) return;
        const lines = readFileSync(this.path, 'utf8').split('\n').filter(Boolean);
        const byId = new Map<string, OutboxEntry>();
        for (const ln of lines) {
            try {
                const obj = JSON.parse(ln) as OutboxLineEntry | OutboxLineAck;
                if ('kind' in obj && obj.kind === 'ack') {
                    const e = byId.get(obj.eventId);
                    if (e) e.ackedSeq = obj.seq;
                } else if ('entry' in obj) {
                    byId.set(obj.entry.eventId, { ...obj.entry });
                }
            } catch {
                log.warn('skipped malformed outbox line');
            }
        }
        this.entries = Array.from(byId.values()).sort((a, b) => a.createdAt - b.createdAt);
        const pending = this.entries.filter((e) => e.ackedSeq === null).length;
        log.info('outbox loaded', { sessionId: this.opts.sessionId, total: this.entries.length, pending });
    }

    pendingCount(): number {
        return this.entries.filter((e) => e.ackedSeq === null).length;
    }

    enqueue(envelope: Envelope): void {
        const e: OutboxEntry = { eventId: envelope.eventId, envelope, ackedSeq: null, createdAt: Date.now(), attempts: 0 };
        this.entries.push(e);
        const line: OutboxLineEntry = { entry: e };
        appendFileSync(this.path, JSON.stringify(line) + '\n');
        void this.flush();
    }

    markAcked(eventId: string, seq: number): void {
        const e = this.entries.find((x) => x.eventId === eventId);
        if (!e || e.ackedSeq !== null) return;
        e.ackedSeq = seq;
        this.opts.onAck?.(e);
        const line: OutboxLineAck = { kind: 'ack', eventId, seq };
        appendFileSync(this.path, JSON.stringify(line) + '\n');
        this.maybeCompact();
    }

    private maybeCompact(): void {
        const total = this.entries.length;
        if (total < 200) return;
        const acked = this.entries.filter((e) => e.ackedSeq !== null).length;
        if (acked / total < 0.8) return;
        const live = this.entries.filter((e) => e.ackedSeq === null);
        const tmp = this.path + '.tmp';
        writeFileSync(tmp, live.map((e) => JSON.stringify({ entry: e } satisfies OutboxLineEntry)).join('\n') + (live.length ? '\n' : ''));
        renameSync(tmp, this.path);
        this.entries = live;
        log.debug('outbox compacted', { sessionId: this.opts.sessionId, kept: live.length });
    }

    flush(): Promise<void> {
        if (this.inFlight) return this.inFlight;
        this.inFlight = this.drain().finally(() => { this.inFlight = null; });
        return this.inFlight;
    }

    private async drain(): Promise<void> {
        while (!this.opts.signal.aborted) {
            const next = this.entries.find((e) => e.ackedSeq === null);
            if (!next) return;
            try {
                const wire = encodeForWire(next.envelope);
                const enc = encrypt(this.opts.variant, this.opts.sessionKey, wire);
                const res = await this.opts.relay.append(this.opts.sessionId, enc, next.eventId);
                next.ackedSeq = res.seq;
                this.opts.onAck?.(next);
                const line: OutboxLineAck = { kind: 'ack', eventId: next.eventId, seq: res.seq };
                appendFileSync(this.path, JSON.stringify(line) + '\n');
            } catch (e) {
                next.attempts += 1;
                const d = backoffMs(next.attempts, CONSTANTS.BACKOFF_BASE_MS, CONSTANTS.BACKOFF_CAP_MS);
                log.warn('append failed, retrying', { eventId: next.eventId, attempt: next.attempts, delayMs: d, err: String(e) });
                await sleep(d, this.opts.signal);
            }
        }
    }
}
