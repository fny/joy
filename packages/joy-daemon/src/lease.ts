/**
 * Per-session writer lease — comm-layer-spec §13.
 *
 * The lease is implemented as a `writer-claim` event appended to the session's
 * own log. The fold's writerEpoch tracks the highest seen. A daemon that
 * intends to act as the agent writer:
 *   1. Folds the log; observes current `writerEpoch`.
 *   2. Appends `writer-claim { daemonId, epoch = writerEpoch + 1 }`.
 *   3. Waits to *observe* its claim by `seq` (echo-ack) before emitting any
 *      agent events.
 *   4. While running, watches for a higher `writer-claim`; if seen, relinquishes
 *      immediately (stop the agent, stop emitting).
 *
 * Returns a `Lease` handle with `held()` / `onLost(cb)` / `release()`.
 */
import { randomUUID } from 'node:crypto';
import { logger } from './util/log';
import type { Outbox } from './relay/outbox';
import type { Cursor } from './relay/cursor';

const log = logger('lease');

export interface Lease {
    sessionId: string;
    daemonId: string;
    epoch: number;
    held(): boolean;
    onLost(cb: () => void): () => void;
    release(): void;
}

export interface AcquireOpts {
    sessionId: string;
    daemonId: string;
    cursor: Cursor;
    outbox: Outbox;
    /** How long to wait for our own claim to echo back before giving up. */
    echoWaitMs: number;
    /** Build an envelope for an event of type `writer-claim`. */
    buildClaim: (daemonId: string, epoch: number) => Promise<void>;
}

export async function acquireLease(opts: AcquireOpts): Promise<Lease> {
    const curEpoch = opts.cursor.getProjection().writerEpoch;
    const myEpoch = curEpoch + 1;
    const lostListeners = new Set<() => void>();
    let lost = false;
    const checkLost = () => {
        const p = opts.cursor.getProjection();
        if (p.writerEpoch > myEpoch && !lost) {
            lost = true;
            log.warn('lease lost: higher writerEpoch seen', { sessionId: opts.sessionId, myEpoch, observedEpoch: p.writerEpoch });
            for (const cb of lostListeners) try { cb(); } catch (e) { log.error('lease onLost threw', { e: String(e) }); }
        }
    };
    const id = setInterval(checkLost, 1_000);

    await opts.buildClaim(opts.daemonId, myEpoch);
    // Wait for our claim to be observed by seq.
    const deadline = Date.now() + opts.echoWaitMs;
    while (Date.now() < deadline) {
        const p = opts.cursor.getProjection();
        if (p.writerEpoch >= myEpoch) break;
        opts.cursor.poke();
        await new Promise((r) => setTimeout(r, 200));
    }
    const observed = opts.cursor.getProjection().writerEpoch;
    if (observed > myEpoch) {
        clearInterval(id);
        throw new Error(`lease lost during acquire: observed epoch ${observed} > mine ${myEpoch}`);
    }

    const lease: Lease = {
        sessionId: opts.sessionId,
        daemonId: opts.daemonId,
        epoch: myEpoch,
        held: () => !lost,
        onLost: (cb) => {
            lostListeners.add(cb);
            return () => lostListeners.delete(cb);
        },
        release: () => {
            clearInterval(id);
            lost = true;
        },
    };
    log.info('lease acquired', { sessionId: opts.sessionId, epoch: myEpoch });
    return lease;
}

export function newDaemonId(): string {
    return 'd-' + randomUUID();
}
