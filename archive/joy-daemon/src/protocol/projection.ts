/**
 * Session projection — the derived state computed by the pure fold (§11.2/§17).
 * Same log ⇒ identical projection on every consumer (I5).
 *
 * Display-only message content (turn-output bodies, tool result text) is NOT
 * stored here — consumers render that lazily from the events list. The
 * projection is the lean state machine: turns, permissions, bg tasks, config,
 * lease, liveness watermarks.
 */

export type TurnState =
    | 'pending'
    | 'running'
    | 'completed'
    | 'failed'
    | 'cancelled'
    | 'interrupted';

export interface Turn {
    id: string;
    requestEventId: string;
    state: TurnState;
    usage?: unknown;
    costUsd?: number;
}

export interface OpenPermission {
    reqId: string;
    turnId: string;
    options: unknown[];
}

export interface AnsweredPermission {
    optionId: string;
    auto: boolean;
}

export type BgStatus = 'started' | 'completed' | 'failed' | 'stopped' | 'exited';
export interface BgTaskState {
    taskId: string;
    turnId: string;
    status: BgStatus;
}

export interface AgentMeta {
    tools: string[];
    slashCommands: string[];
    models: string[];
    mcpServers: unknown[];
    skills: unknown[];
}

export interface Projection {
    config: { permissionMode: string | null; model: string | null };
    turns: Record<string, Turn>;
    /** Turn ids in `turn-started` order (or user-message order when not yet started). */
    order: string[];
    /** Cancels that arrived before their target's `turn-started` (§14 pre-emptive). */
    cancelTombstones: string[];
    /** Permission requests with no answer yet. */
    openPermissions: Record<string, OpenPermission>;
    /** Answered permissions, kept so a re-emitted request after respawn is a no-op (§18). */
    permissionsAnswered: Record<string, AnsweredPermission>;
    bgTasks: Record<string, BgTaskState>;
    agentMeta: AgentMeta;
    /** Highest `writer-claim.epoch` observed (§13). */
    writerEpoch: number;
    /** `seq` of the claim that established the current writerEpoch, or null. */
    writerClaimSeq: number | null;
    /** Highest event `seq` folded into this projection. */
    lastEventSeq: number;
    /** Last heartbeat seen, used by status §17 (skew-free, server-seq based). */
    lastHeartbeat: { turnId: string; hbCounter: number; atSeq: number } | null;
}

export function initialProjection(): Projection {
    return {
        config: { permissionMode: null, model: null },
        turns: {},
        order: [],
        cancelTombstones: [],
        openPermissions: {},
        permissionsAnswered: {},
        bgTasks: {},
        agentMeta: { tools: [], slashCommands: [], models: [], mcpServers: [], skills: [] },
        writerEpoch: 0,
        writerClaimSeq: null,
        lastEventSeq: 0,
        lastHeartbeat: null,
    };
}

export function isTerminalState(s: TurnState): boolean {
    return s !== 'pending' && s !== 'running';
}
