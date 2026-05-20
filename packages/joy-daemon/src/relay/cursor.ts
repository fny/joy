/**
 * Cursor + snapshot fast-path — comm-layer-spec §11.
 *
 * The cursor pulls events strictly in `seq` order via `after_seq=N` in batches
 * and folds them into the projection. On startup it MAY first locate the
 * latest `snapshot` via `before_seq` paging to bound replay cost (§11.3).
 *
 * The cursor is persisted on disk so a daemon restart resumes from the same
 * place.
 *
 * Storage:
 *   ${sessionDir(id)}/cursor.json     {"lastAppliedSeq": N}
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '../util/log';
import { sessionDir } from '../util/paths';
import { decrypt, type EncryptionVariant, b64decode } from './encryption';
import { rawContentB64, type RelayClient, type RawMessage } from './relayClient';
import { EnvelopeSchema, type Envelope } from '../protocol/envelope';
import { AnyEventSchema, type AnyEvent } from '../protocol/events';
import { fold, type FoldEvent } from '../protocol/fold';
import {
    initialProjection,
    type Projection,
} from '../protocol/projection';

const log = logger('cursor');

interface CursorState {
    lastAppliedSeq: number;
}

export interface ParsedEvent {
    seq: number;
    envelope: Envelope;
    event: AnyEvent | null; // null = unknown/forward-compat
}

export interface CursorOpts {
    sessionId: string;
    relay: RelayClient;
    sessionKey: Uint8Array;
    variant: EncryptionVariant;
    /** Called for every parsed event in seq order, BEFORE the projection is
     * updated. Lets subsystems observe the live stream (e.g. outbox echo-ack
     * via eventId match, legacy facade emission). */
    onEvent?: (parsed: ParsedEvent) => void;
    /** Called when the projection advances. */
    onProjection?: (p: Projection) => void;
    signal: AbortSignal;
}

export class Cursor {
    private readonly path: string;
    private readonly opts: CursorOpts;
    private projection: Projection = initialProjection();
    private lastAppliedSeq = 0;
    private pulling = false;
    private pulseAgain = false;

    constructor(opts: CursorOpts) {
        this.opts = opts;
        this.path = join(sessionDir(opts.sessionId), 'cursor.json');
        this.loadCursor();
    }

    getProjection(): Projection {
        return this.projection;
    }

    getLastAppliedSeq(): number {
        return this.lastAppliedSeq;
    }

    private loadCursor(): void {
        if (!existsSync(this.path)) return;
        try {
            const s = JSON.parse(readFileSync(this.path, 'utf8')) as CursorState;
            if (typeof s.lastAppliedSeq === 'number') this.lastAppliedSeq = s.lastAppliedSeq;
        } catch {
            log.warn('cursor file unreadable, resetting');
        }
    }

    private saveCursor(): void {
        writeFileSync(this.path, JSON.stringify({ lastAppliedSeq: this.lastAppliedSeq } satisfies CursorState));
    }

    /** Optionally locate the latest snapshot to seed the projection (§11.3). */
    async tryLoadSnapshot(): Promise<boolean> {
        if (this.lastAppliedSeq > 0) return false; // only relevant for a cold start
        // Walk backwards in pages of 100 until we find a snapshot or hit the start.
        // Cheap in practice because the daemon writes snapshots periodically.
        const PAGE = 100;
        let cursor = Number.MAX_SAFE_INTEGER;
        for (let i = 0; i < 100; i++) {
            const page = await this.opts.relay.readBefore(this.opts.sessionId, cursor, PAGE);
            if (page.messages.length === 0) return false;
            for (const m of page.messages) {
                const parsed = this.parse(m);
                if (parsed?.event?.type === 'snapshot') {
                    const proj = parsed.event.payload.projection as Projection;
                    const upto = parsed.event.payload.uptoSeq;
                    this.projection = proj;
                    this.lastAppliedSeq = upto;
                    this.saveCursor();
                    log.info('seeded from snapshot', { sessionId: this.opts.sessionId, uptoSeq: upto });
                    this.opts.onProjection?.(this.projection);
                    return true;
                }
            }
            if (!page.hasMore) return false;
            cursor = page.messages[page.messages.length - 1].seq;
            if (cursor <= 0) return false;
        }
        return false;
    }

    /** Schedule a pull. Coalescing: concurrent calls collapse to one trailing pull. */
    poke(): void {
        if (this.pulling) {
            this.pulseAgain = true;
            return;
        }
        void this.pull();
    }

    private async pull(): Promise<void> {
        if (this.pulling) return;
        this.pulling = true;
        try {
            do {
                this.pulseAgain = false;
                let more = true;
                while (more && !this.opts.signal.aborted) {
                    const page = await this.opts.relay.readSince(this.opts.sessionId, this.lastAppliedSeq, 200);
                    for (const m of page.messages) {
                        const parsed = this.parse(m);
                        if (!parsed) continue;
                        this.opts.onEvent?.(parsed);
                        if (parsed.event) {
                            const fe: FoldEvent = { seq: parsed.seq, envelope: parsed.envelope, event: parsed.event };
                            this.projection = fold(this.projection, fe);
                        }
                        this.lastAppliedSeq = Math.max(this.lastAppliedSeq, parsed.seq);
                    }
                    more = page.hasMore;
                    if (page.messages.length > 0) {
                        this.saveCursor();
                        this.opts.onProjection?.(this.projection);
                    }
                }
            } while (this.pulseAgain && !this.opts.signal.aborted);
        } catch (e) {
            log.warn('pull failed', { err: String(e) });
        } finally {
            this.pulling = false;
        }
    }

    private parse(m: RawMessage): ParsedEvent | null {
        const b64 = rawContentB64(m.content);
        if (!b64) return null;
        const enc = b64decode(b64);
        const plain = decrypt(this.opts.variant, this.opts.sessionKey, enc);
        if (plain === null || typeof plain !== 'object') return null;
        const envParse = EnvelopeSchema.safeParse(plain);
        if (!envParse.success) return null;
        const envelope = envParse.data;
        const evParse = AnyEventSchema.safeParse({ type: envelope.type, payload: envelope.payload });
        return {
            seq: m.seq,
            envelope,
            event: evParse.success ? evParse.data : null,
        };
    }
}
