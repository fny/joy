/**
 * Pure fold — comm-layer-spec §11/§17.
 *
 * fold(state, event) is total: every event type maps to a deterministic
 * transition; unknown types and out-of-order/duplicate seq are identity. Same
 * log ⇒ identical Projection on every consumer (I5).
 *
 * Convention adopted by this implementation: a Turn's `id` IS the eventId of
 * the originating `user-message`. The daemon's `turn-started` uses that same
 * id as both `turnId` and `requestEventId`. The spec keeps the fields
 * distinct (allowing a daemon-assigned turnId) but does not forbid this 1:1
 * choice; we take it because it removes an indirection.
 */
import type { AnyEvent } from './events';
import type { Envelope } from './envelope';
import {
    type Projection,
    type Turn,
    type TurnState,
    initialProjection,
    isTerminalState,
} from './projection';

/** An event as the fold receives it: server seq + envelope + typed body. */
export interface FoldEvent {
    seq: number;
    envelope: Envelope;
    event: AnyEvent;
}

/**
 * Apply one event to a projection. Pure. Idempotent on out-of-order/duplicate
 * seq. Unknown event types are identity (forward-compat per §7).
 */
export function fold(state: Projection, e: FoldEvent): Projection {
    if (e.seq <= state.lastEventSeq) return state;
    let next: Projection = { ...state, lastEventSeq: e.seq };
    const ev = e.event;
    switch (ev.type) {
        case 'writer-claim': {
            if (ev.payload.epoch > next.writerEpoch) {
                next.writerEpoch = ev.payload.epoch;
                next.writerClaimSeq = e.seq;
            }
            return next;
        }

        case 'mode-change': {
            next.config = { ...next.config };
            if (ev.payload.permissionMode !== undefined) {
                next.config.permissionMode = ev.payload.permissionMode;
            }
            if (ev.payload.model !== undefined) {
                next.config.model = ev.payload.model;
            }
            return next;
        }

        case 'user-message': {
            // Turn id == originating user-message envelope.eventId (see header).
            const tid = e.envelope.eventId;
            if (next.turns[tid]) return next; // dedupe
            next.turns = { ...next.turns, [tid]: { id: tid, requestEventId: tid, state: 'pending' } };
            next.order = [...next.order, tid];
            return next;
        }

        case 'turn-started': {
            const tid = ev.payload.turnId;
            const existing = next.turns[tid];
            // Pre-emptive cancel: tombstone applied here (§14).
            const tombstoned = next.cancelTombstones.includes(tid);
            const startState: TurnState = tombstoned ? 'cancelled' : 'running';
            if (tombstoned) {
                next.cancelTombstones = next.cancelTombstones.filter((x) => x !== tid);
            }
            if (!existing) {
                next.turns = {
                    ...next.turns,
                    [tid]: { id: tid, requestEventId: ev.payload.requestEventId, state: startState },
                };
                next.order = next.order.includes(tid) ? next.order : [...next.order, tid];
            } else {
                if (isTerminalState(existing.state)) return next; // idempotent
                next.turns = { ...next.turns, [tid]: { ...existing, state: startState } };
            }
            return next;
        }

        case 'turn-completed':
        case 'turn-failed':
        case 'turn-cancelled':
        case 'turn-interrupted': {
            const tid = ev.payload.turnId;
            const t = next.turns[tid];
            if (!t || isTerminalState(t.state)) return next;
            const newState: TurnState =
                ev.type === 'turn-completed'
                    ? 'completed'
                    : ev.type === 'turn-failed'
                        ? 'failed'
                        : ev.type === 'turn-cancelled'
                            ? 'cancelled'
                            : 'interrupted';
            const updated: Turn = { ...t, state: newState };
            if (ev.type === 'turn-completed') {
                if (ev.payload.usage !== undefined) updated.usage = ev.payload.usage;
                if (ev.payload.costUsd !== undefined) updated.costUsd = ev.payload.costUsd;
            }
            next.turns = { ...next.turns, [tid]: updated };
            return next;
        }

        case 'cancel': {
            const target = ev.payload.targetTurnId;
            if (target === null || target === '*') {
                // Stop button: cancel running + drain pending.
                const updates: Record<string, Turn> = {};
                for (const t of Object.values(next.turns)) {
                    if (t.state === 'pending' || t.state === 'running') {
                        updates[t.id] = { ...t, state: 'cancelled' };
                    }
                }
                if (Object.keys(updates).length > 0) {
                    next.turns = { ...next.turns, ...updates };
                }
                // Any prior tombstones are now moot.
                if (next.cancelTombstones.length > 0) next.cancelTombstones = [];
                return next;
            }
            const t = next.turns[target];
            if (!t) {
                // Pre-emptive cancel: record tombstone (§14).
                if (!next.cancelTombstones.includes(target)) {
                    next.cancelTombstones = [...next.cancelTombstones, target];
                }
                return next;
            }
            if (isTerminalState(t.state)) return next;
            next.turns = { ...next.turns, [target]: { ...t, state: 'cancelled' } };
            return next;
        }

        case 'interrupt': {
            // The fold records nothing here; the daemon executes the ladder and
            // then emits `turn-interrupted` which terminalizes the turn above.
            return next;
        }

        case 'steer': {
            // Pure fold: steer does not mutate the projection. The daemon
            // applies steer to the live agent input or reifies it per §12;
            // resulting turn state changes flow via turn-* events.
            return next;
        }

        case 'permission-request': {
            const reqId = ev.payload.reqId;
            if (next.openPermissions[reqId]) return next;
            if (next.permissionsAnswered[reqId]) return next; // re-emit after respawn (§18)
            next.openPermissions = {
                ...next.openPermissions,
                [reqId]: { reqId, turnId: ev.payload.turnId, options: ev.payload.options },
            };
            return next;
        }

        case 'permission-response': {
            const reqId = ev.payload.reqId;
            if (next.permissionsAnswered[reqId]) return next; // first by seq wins
            next.permissionsAnswered = {
                ...next.permissionsAnswered,
                [reqId]: { optionId: ev.payload.optionId, auto: !!ev.payload.auto },
            };
            if (next.openPermissions[reqId]) {
                const { [reqId]: _drop, ...rest } = next.openPermissions;
                next.openPermissions = rest;
            }
            return next;
        }

        case 'bg-started': {
            const id = ev.payload.taskId;
            if (next.bgTasks[id]) return next;
            next.bgTasks = {
                ...next.bgTasks,
                [id]: { taskId: id, turnId: ev.payload.turnId, status: 'started' },
            };
            return next;
        }
        case 'bg-progress': {
            return next; // advisory; coalesced upstream
        }
        case 'bg-notification': {
            const cur = next.bgTasks[ev.payload.taskId];
            if (!cur) return next;
            next.bgTasks = {
                ...next.bgTasks,
                [ev.payload.taskId]: { ...cur, status: ev.payload.status },
            };
            return next;
        }
        case 'bg-exited': {
            const cur = next.bgTasks[ev.payload.taskId];
            if (!cur) return next;
            next.bgTasks = {
                ...next.bgTasks,
                [ev.payload.taskId]: { ...cur, status: 'exited' },
            };
            return next;
        }

        case 'agent-metadata': {
            next.agentMeta = {
                tools: ev.payload.tools ?? next.agentMeta.tools,
                slashCommands: ev.payload.slashCommands ?? next.agentMeta.slashCommands,
                models: ev.payload.models ?? next.agentMeta.models,
                mcpServers: ev.payload.mcpServers ?? next.agentMeta.mcpServers,
                skills: ev.payload.skills ?? next.agentMeta.skills,
            };
            return next;
        }

        case 'heartbeat': {
            next.lastHeartbeat = {
                turnId: ev.payload.turnId,
                hbCounter: ev.payload.hbCounter,
                atSeq: e.seq,
            };
            return next;
        }

        case 'cursor':
        case 'snapshot':
        case 'projection-digest':
        case 'rejected':
        case 'tool-call':
        case 'tool-result':
        case 'turn-output':
            // Structural fold tracks turns/perms/bg/meta/lease only. Content,
            // tool calls, and observability events are visible to consumers
            // via the raw event stream; they are not part of the projection.
            return next;
        default:
            // Unknown event types are identity (forward-compat per §7). The
            // TypeScript-enforced exhaustive switch above only catches *known*
            // variants; a runtime value with an unrecognized `type` falls here.
            return next;
    }
}

/** Convenience: fold an ordered sequence of events (by seq). Pure. */
export function foldAll(events: FoldEvent[], start: Projection = initialProjection()): Projection {
    return events.reduce(fold, start);
}
