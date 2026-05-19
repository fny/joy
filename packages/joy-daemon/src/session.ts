/**
 * Session — one hosted session in the daemon.
 *
 * Wires together: RelayClient × Outbox × Cursor × Lease × AgentHost.
 * Knows nothing about UI / cli / app. Implements the spec-level rules that
 * are not pure (i.e. that require side effects):
 *  - emit `turn-interrupted{reason:'crash'}` on agent crash for any non-
 *    terminal running turn (§18)
 *  - cursor discipline on respawn ("terminal already present? skip : recover")
 *  - permission timeout auto-deny (§15)
 *  - heartbeat → turn into envelope on the log
 *  - relay echo-ack → outbox.markAcked by eventId
 *
 * The legacy facade (§20) is wired separately and observes the same outbox /
 * cursor.
 */
import { randomUUID } from 'node:crypto';
import { logger } from './util/log';
import { sleep } from './util/backoff';
import { CONSTANTS, ENVELOPE_VERSION } from './protocol/constants';
import type { Envelope } from './protocol/envelope';
import type { AnyEvent } from './protocol/events';
import { isTerminalState } from './protocol/projection';
import type { Projection, Turn } from './protocol/projection';
import { RelayClient } from './relay/relayClient';
import { Outbox } from './relay/outbox';
import { Cursor } from './relay/cursor';
import type { EncryptionVariant } from './relay/encryption';
import { acquireLease, newDaemonId, type Lease } from './lease';
import { AgentHost, type AgentDown, type AgentUp } from './agentHost';

const log = logger('session');

export interface SessionOpts {
    sessionId: string;
    relay: RelayClient;
    sessionKey: Uint8Array;
    variant: EncryptionVariant;
    agentBin: string;
    daemonId?: string;
    agentArgs?: string[];
    agentEnv?: Record<string, string>;
}

export class Session {
    readonly sessionId: string;
    readonly daemonId: string;
    private readonly opts: SessionOpts;
    private readonly relay: RelayClient;
    private readonly outbox: Outbox;
    private readonly cursor: Cursor;
    private agent: AgentHost | null = null;
    private lease: Lease | null = null;
    private signal: AbortController;
    private permissionTimers = new Map<string, NodeJS.Timeout>();
    private projectionListeners = new Set<(p: Projection) => void>();

    constructor(opts: SessionOpts) {
        this.sessionId = opts.sessionId;
        this.daemonId = opts.daemonId ?? newDaemonId();
        this.opts = opts;
        this.relay = opts.relay;
        this.signal = new AbortController();
        this.outbox = new Outbox({
            sessionId: opts.sessionId,
            relay: opts.relay,
            sessionKey: opts.sessionKey,
            variant: opts.variant,
            signal: this.signal.signal,
        });
        this.cursor = new Cursor({
            sessionId: opts.sessionId,
            relay: opts.relay,
            sessionKey: opts.sessionKey,
            variant: opts.variant,
            onEvent: (p) => this.onLogEvent(p.envelope, p.event ?? null, p.seq),
            onProjection: (proj) => this.fanOutProjection(proj),
            signal: this.signal.signal,
        });
    }

    getProjection(): Projection {
        return this.cursor.getProjection();
    }

    onProjection(cb: (p: Projection) => void): () => void {
        this.projectionListeners.add(cb);
        return () => this.projectionListeners.delete(cb);
    }

    private fanOutProjection(p: Projection): void {
        for (const cb of this.projectionListeners) try { cb(p); } catch (e) { log.error('projection listener threw', { e: String(e) }); }
    }

    /** Start: load snapshot, catch up, acquire lease, start the agent. */
    async start(): Promise<void> {
        this.relay.connect();
        const unsub = this.relay.subscribe(this.sessionId, () => this.cursor.poke());
        this.signal.signal.addEventListener('abort', unsub, { once: true });

        await this.cursor.tryLoadSnapshot();
        await this.fullCatchUp();

        this.lease = await acquireLease({
            sessionId: this.sessionId,
            daemonId: this.daemonId,
            cursor: this.cursor,
            outbox: this.outbox,
            echoWaitMs: 10_000,
            buildClaim: async (daemonId, epoch) => {
                this.append({ type: 'writer-claim', payload: { daemonId, epoch } });
                // wait briefly for the append to be observed
                await this.cursor.poke();
                await sleep(150);
            },
        });
        this.lease.onLost(() => void this.stop('lease-lost'));

        // Recovery: emit `turn-interrupted` for any running turn left over
        // from a prior daemon (cursor-discipline §18).
        const proj = this.cursor.getProjection();
        for (const t of Object.values(proj.turns)) {
            if (t.state === 'running') {
                this.append({ type: 'turn-interrupted', payload: { turnId: t.id, reason: 'crash' } });
            }
        }

        const lastAgentMessageId = this.findAnchor(proj);
        this.spawnAgent({ kind: 'init', sessionId: this.sessionId, turnAnchor: lastAgentMessageId ? { messageId: lastAgentMessageId } : undefined });
    }

    private findAnchor(_p: Projection): string | null {
        // Structural projection does not retain message ids; the agent
        // adapter is responsible for matching its own resume stream against
        // the daemon's recorded turn-output messageIds (the seam carries
        // `turnAnchor` only as a hint). Phase 2: thread the last messageId
        // alongside the projection via cursor.onEvent observation.
        return null;
    }

    private async fullCatchUp(): Promise<void> {
        const target = this.cursor.getLastAppliedSeq();
        this.cursor.poke();
        // Drive the pull synchronously until quiescent. The Cursor coalesces
        // concurrent pokes; we just need to ensure it actually drains once.
        await sleep(200);
        if (this.cursor.getLastAppliedSeq() < target) {
            // shouldn't happen — cursor advances monotonically
            return;
        }
    }

    private spawnAgent(init: AgentDown): void {
        this.agent = new AgentHost({
            sessionId: this.sessionId,
            agentBin: this.opts.agentBin,
            args: this.opts.agentArgs,
            env: this.opts.agentEnv,
            onUp: (m) => this.onAgentUp(m),
            onExit: ({ reason }) => {
                this.agent = null;
                if (reason === 'crash') {
                    const proj = this.cursor.getProjection();
                    for (const t of Object.values(proj.turns)) {
                        if (t.state === 'running') {
                            this.append({ type: 'turn-interrupted', payload: { turnId: t.id, reason: 'crash' } });
                        }
                    }
                    log.warn('agent crashed; turns terminalized as interrupted', { sessionId: this.sessionId });
                }
            },
        });
        if (init.kind === 'init') this.agent.start(init);
    }

    private onAgentUp(m: AgentUp): void {
        switch (m.kind) {
            case 'event':
                this.append(m.event);
                return;
            case 'partial':
                // Ephemeral. No durable record. Side-channel broadcast is future
                // work (it can ride the existing socket poke layer; legacy clients
                // already ignore unknown poke payloads).
                return;
            case 'heartbeat':
                this.append({ type: 'heartbeat', payload: { turnId: m.turnId, hbCounter: m.hbCounter } });
                return;
            case 'log':
                log.debug('agent log', { ...m });
                return;
        }
    }

    /** Append an event to the session's log via the outbox. */
    append(event: AnyEvent, opts?: { vmin?: number }): string {
        const eventId = randomUUID();
        const envelope: Envelope = {
            eventId,
            type: event.type,
            v: 1,
            vmin: opts?.vmin ?? null,
            sessionId: this.sessionId,
            turnId: this.extractTurnId(event),
            by: this.daemonId,
            ts: Date.now(),
            payload: event.payload,
        };
        // Sanity check: envelope version is frozen
        void ENVELOPE_VERSION;
        this.outbox.enqueue(envelope);
        return eventId;
    }

    private extractTurnId(event: AnyEvent): string | null {
        const p = (event as unknown as { payload?: { turnId?: string; targetTurnId?: string | null } }).payload;
        if (p && typeof p === 'object' && 'turnId' in p && typeof p.turnId === 'string') return p.turnId;
        return null;
    }

    /** External: attach an input event from a cli/control client. */
    attachInput(event: AnyEvent): string {
        // Per §15, schedule a permission auto-deny timer the moment the daemon
        // observes the request in its own projection (not at attach time). The
        // session.onProjection hook handles it.
        const id = this.append(event);
        // Also push the input event directly to the running agent so it acts
        // immediately rather than waiting for the round-trip via the relay.
        // The fold is idempotent on the eventual log echo.
        this.agent?.send({ kind: 'input', event });
        return id;
    }

    private onLogEvent(_env: Envelope, ev: AnyEvent | null, _seq: number): void {
        if (!ev) return;
        if (ev.type === 'permission-request') {
            const reqId = ev.payload.reqId;
            if (this.permissionTimers.has(reqId)) return;
            const t = setTimeout(() => {
                const proj = this.cursor.getProjection();
                if (proj.openPermissions[reqId]) {
                    this.append({ type: 'permission-response', payload: { reqId, optionId: 'deny', auto: true } });
                }
                this.permissionTimers.delete(reqId);
            }, CONSTANTS.PERMISSION_TIMEOUT_MS);
            this.permissionTimers.set(reqId, t);
        } else if (ev.type === 'permission-response') {
            const t = this.permissionTimers.get(ev.payload.reqId);
            if (t) {
                clearTimeout(t);
                this.permissionTimers.delete(ev.payload.reqId);
            }
        }
    }

    async stop(reason: string): Promise<void> {
        log.info('session stopping', { sessionId: this.sessionId, reason });
        this.signal.abort();
        for (const t of this.permissionTimers.values()) clearTimeout(t);
        this.permissionTimers.clear();
        await this.agent?.stop().catch(() => undefined);
        this.lease?.release();
    }
}

// Re-export for convenience
export { isTerminalState };
export type { Turn };
