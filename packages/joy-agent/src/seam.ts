/**
 * Agent-agnostic seam — docs/joy-agent-spec.md §2.1.
 *
 * One internal interface every backend adapter implements. joy-daemon and
 * the protocol never see backend-specific types; only this seam.
 *
 * Down (control verbs invoked on the agent):
 *   start(turn)       — start the model loop for the given turn
 *   steer(content)    — push input into the live in-flight turn
 *   interrupt()       — graceful turn stop (no drain)
 *   abort()           — hard turn stop after grace
 *   close()           — terminate the agent subprocess; no further events
 *   stopTask(taskId)  — stop a live background task
 *
 * Up (events emitted by the agent — see comm-layer-spec §9):
 *   turn-started / turn-output / tool-call / tool-result
 *   turn-completed / turn-failed / turn-interrupted (cancelled is emitted
 *     by the daemon when the ladder completes; agent reports the underlying
 *     facts)
 *   bg-started / bg-progress / bg-notification
 *   permission-request (the answer is delivered back by the daemon)
 *   agent-metadata
 *   PARTIAL deltas — see EphemeralPartial (ephemeral; not logged)
 *
 * The seam is intentionally synchronous-shaped (callbacks/streams) and free of
 * any relay/durability concerns. joy-daemon owns persistence, ordering,
 * dedupe, lease, and recovery.
 */
import type { AnyEvent } from 'joy-daemon/src/protocol';

export interface TurnStart {
    turnId: string;
    requestEventId: string;
    content: unknown;
}

/** Streaming delta of an in-progress turn message. Ephemeral. Never logged. */
export interface EphemeralPartial {
    messageId: string;
    deltaText: string;
}

export type AgentUp =
    | { kind: 'event'; event: AnyEvent }
    | { kind: 'partial'; partial: EphemeralPartial };

export interface AgentBackend {
    start(turn: TurnStart): Promise<void>;
    steer(content: unknown): Promise<void>;
    interrupt(): Promise<void>;
    abort(): Promise<void>;
    close(): Promise<void>;
    stopTask(taskId: string): Promise<void>;
    /** Subscribe to up-channel facts. Returns an unsubscribe. */
    subscribe(handler: (up: AgentUp) => void): () => void;
}
