/**
 * Legacy-wire compatibility facade — comm-layer-spec §20.
 *
 * The daemon emits new event-log records (§9) AND legacy envelopes so an
 * unmodified relay + stock/old `happy-app` continue to work. New clients
 * derive truth from §9 events; legacy clients see legacy envelopes. No
 * client mixes the two authorities, so no dual-truth.
 *
 * Mapping (initial subset — extend as upstream wire grows):
 *   turn-output     → legacy {role:'agent', content:<passthrough>}
 *   turn-completed  → legacy "session turn closed: completed"
 *   turn-failed     → legacy "session turn closed: failed"
 *   turn-cancelled  → legacy "session turn closed: cancelled"
 *
 * Implemented as an observer of `Session.onProjection` + raw event stream;
 * it never reads from internal state, only from the canonical log events.
 *
 * IMPORTANT: the legacy envelope is itself appended via the daemon's own
 * outbox so it is durable and ordered alongside the new events — the relay
 * is untouched and treats both kinds as opaque message records.
 */
import { logger } from './util/log';
import type { AnyEvent } from './protocol/events';
import type { Session } from './session';

const log = logger('legacy');

export interface LegacyEnvelope {
    role: 'agent' | 'session' | 'user';
    content: unknown;
}

export interface LegacyFacadeOpts {
    session: Session;
    /** Build and append a legacy envelope as an opaque payload. The wire is
     * an existing format; we encode it inside a separate event type the
     * relay does not interpret. New clients ignore this `legacy-envelope`
     * event type (per §7 unknown-type tolerance); old clients receive only
     * this kind because they never see the new event types. */
    enabled?: boolean;
}

export function attachLegacyFacade(opts: LegacyFacadeOpts): () => void {
    if (opts.enabled === false) return () => undefined;

    const off = opts.session.onProjection(() => undefined);
    // The actual translation happens off the live event stream rather than
    // the (lossy) projection. Hooking into the cursor is done in main()
    // where the Cursor's onEvent callback is constructed; for now we expose
    // the converter so the entry can plug it in.
    return off;
}

export function legacyForEvent(ev: AnyEvent): LegacyEnvelope | null {
    switch (ev.type) {
        case 'turn-output':
            return { role: 'agent', content: ev.payload.content };
        case 'turn-completed':
            return { role: 'session', content: { kind: 'turn-closed', status: 'completed', turnId: ev.payload.turnId } };
        case 'turn-failed':
            return { role: 'session', content: { kind: 'turn-closed', status: 'failed', turnId: ev.payload.turnId, error: ev.payload.errorSubtype } };
        case 'turn-cancelled':
            return { role: 'session', content: { kind: 'turn-closed', status: 'cancelled', turnId: ev.payload.turnId } };
        case 'turn-interrupted':
            return { role: 'session', content: { kind: 'turn-closed', status: 'interrupted', turnId: ev.payload.turnId, reason: ev.payload.reason } };
        default:
            return null;
    }
}

export function logLegacy(env: LegacyEnvelope): void {
    log.debug('legacy envelope', env);
}
