/**
 * SessionManager — the daemon's registry of hosted sessions. Multi-agent
 * across sessions; 1:1 within a session (no fan-out). Owned by main().
 */
import { logger } from './util/log';
import type { RelayClient } from './relay/relayClient';
import type { EncryptionVariant } from './relay/encryption';
import { Session } from './session';
import type { AnyEvent } from './protocol/events';
import type { Projection } from './protocol/projection';

const log = logger('sessionManager');

export interface SessionSpec {
    sessionId: string;
    sessionKey: Uint8Array;
    variant: EncryptionVariant;
    agentBin: string;
    agentArgs?: string[];
    agentEnv?: Record<string, string>;
}

export class SessionManager {
    private readonly sessions = new Map<string, Session>();
    private readonly relay: RelayClient;

    constructor(relay: RelayClient) {
        this.relay = relay;
    }

    list(): string[] {
        return Array.from(this.sessions.keys());
    }

    get(sessionId: string): Session | undefined {
        return this.sessions.get(sessionId);
    }

    async start(spec: SessionSpec): Promise<Session> {
        const existing = this.sessions.get(spec.sessionId);
        if (existing) return existing;
        const s = new Session({
            sessionId: spec.sessionId,
            relay: this.relay,
            sessionKey: spec.sessionKey,
            variant: spec.variant,
            agentBin: spec.agentBin,
            agentArgs: spec.agentArgs,
            agentEnv: spec.agentEnv,
        });
        this.sessions.set(spec.sessionId, s);
        try {
            await s.start();
        } catch (e) {
            this.sessions.delete(spec.sessionId);
            throw e;
        }
        log.info('session started', { sessionId: spec.sessionId });
        return s;
    }

    async stop(sessionId: string, reason: string): Promise<void> {
        const s = this.sessions.get(sessionId);
        if (!s) return;
        await s.stop(reason);
        this.sessions.delete(sessionId);
        log.info('session stopped', { sessionId, reason });
    }

    async stopAll(reason: string): Promise<void> {
        await Promise.all(Array.from(this.sessions.values()).map((s) => s.stop(reason)));
        this.sessions.clear();
    }

    attachInput(sessionId: string, event: AnyEvent): string | null {
        const s = this.sessions.get(sessionId);
        if (!s) return null;
        return s.attachInput(event);
    }

    getProjection(sessionId: string): Projection | null {
        return this.sessions.get(sessionId)?.getProjection() ?? null;
    }
}
