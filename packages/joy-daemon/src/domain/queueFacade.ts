// The one queue surface for operations, handoff and the relay lane (Wave
// C2): every session's queue is the coordinator's — its rows ARE the queue
// — and this facade is the app-facing vocabulary over it (the pre-C2
// per-item delivery states, the accept options every caller used).
import type { AgentSession } from "./agentSession";
import type { QueueItemState } from "../claude/session";
import { coordinatorFor, type SessionCoordinator, type CommandState, type QueueSnapshot } from "./coordinator";
import { TERMINAL_STATES } from "./ledger";

export interface QueueAccept {
  id: string; text: string; createdAt: number;
  /** The text was a joy command the adapter handled itself; nothing queued. */
  handled?: "command";
  reinjectionId?: string;
}
export interface QueueFacade {
  /** Durable by contract: returns after the ledger commit or throws. */
  accept(text: string, opts?: { source?: "relay" | "web" | "rpc"; mirrorToRelay?: boolean; visible?: boolean; seq?: number; id?: string; relayTurnId?: string; relayCommandId?: string }): QueueAccept;
  state(): QueueSnapshot;
  itemState(id: string): QueueItemState;
  cancel(id: string): boolean;
  edit(id: string, text: string): boolean;
  reorder(id: string, toIndex: number): boolean;
  resume(): void;
  /** Work in flight: a running turn, or (coordinator) anything not yet delivered. */
  busy(): boolean;
  /** Resolve once the command is in one of `states` (its terminal reason
   *  when it has one), with the current state after `timeoutMs`, or null
   *  when the command is unknown. */
  waitFor(id: string, states: readonly CommandState[], opts: WaitOpts): Promise<WaitResult>;
}
export interface WaitResult { state: CommandState | null; reason?: string }
export interface WaitOpts { timeoutMs: number; signal?: AbortSignal }

/** The app's per-item vocabulary from a coordinator state. */
export function itemStateOf(state: CommandState | null): QueueItemState {
  switch (state) {
    case null: return "unknown";
    case "queued": case "submitting": case "accepted": case "unknown": return "pending";
    case "running": case "cancelling": case "completed": return "delivered";
    case "failed": return "failed";
    case "cancelled": case "interrupted": return "cancelled";
  }
}

/** The queue of a session (live or ended — an ended one refuses with
 *  SessionEndedError), by its id. */
export function queueFor(session: Pick<AgentSession, "id">, coordinator: SessionCoordinator = coordinatorFor()): QueueFacade {
  {
    const id = session.id;
    return {
      accept: (text, opts = {}) => {
        const a = coordinator.accept({
          sessionId: id, text, source: opts.source ?? "rpc", mirrorToRelay: opts.mirrorToRelay ?? true, visible: opts.visible ?? false,
          seq: opts.seq, id: opts.id, relayTurnId: opts.relayTurnId, relayCommandId: opts.relayCommandId,
        });
        return { id: a.id, text, createdAt: a.createdAt, ...(a.handled ? { handled: a.handled } : {}), ...(a.reinjectionId ? { reinjectionId: a.reinjectionId } : {}) };
      },
      state: () => coordinator.snapshot(id),
      itemState: (cid) => itemStateOf(coordinator.state(cid)),
      cancel: (cid) => { const r = coordinator.cancel(cid); return r.kind === "cancelled" || r.kind === "cancelling"; },
      edit: (cid, text) => coordinator.edit(cid, text),
      reorder: (cid, to) => coordinator.reorder(cid, to),
      resume: () => coordinator.resume(id),
      busy: () => { const s = coordinator.snapshot(id); return s.busy || s.pendingCount > 0; },
      waitFor: async (cid, states, opts) => {
        const state = await coordinator.waitFor(cid, states, { timeoutMs: opts.timeoutMs, signal: opts.signal });
        const row = coordinator.command(cid);
        return { state, ...(row?.terminalReason ? { reason: row.terminalReason } : {}) };
      },
    };
  }
}

/** Is the state one the lane can terminalize on? */
const TERMINAL = new Set<string>(TERMINAL_STATES);
export const isTerminal = (s: CommandState | null): boolean => s !== null && TERMINAL.has(s);
