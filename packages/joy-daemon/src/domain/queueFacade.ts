// One queue surface for operations, handoff and the relay lane while the
// adapters migrate onto the session coordinator (Wave C2). A session the
// coordinator has adopted is driven through it (its rows ARE the queue); an
// adapter not yet ported keeps its own enqueue/cancelQueued/queueState and
// is proxied. The facade disappears with the last legacy adapter.
import type { AgentSession } from "./agentSession";
import type { QueueItemState, QueueState } from "../claude/session";
import { coordinatorFor, type SessionCoordinator, type CommandState } from "./coordinator";

export interface QueueAccept {
  id: string; text: string; createdAt: number;
  /** The text was a joy command the adapter handled itself; nothing queued. */
  handled?: "command";
  reinjectionId?: string;
}
export interface QueueFacade {
  /** Durable by contract: returns after the ledger commit or throws. */
  accept(text: string, opts?: { source?: "relay" | "web" | "rpc"; mirrorToRelay?: boolean; visible?: boolean; seq?: number; id?: string; relayTurnId?: string; relayCommandId?: string }): QueueAccept;
  state(): QueueState;
  itemState(id: string): QueueItemState;
  cancel(id: string): boolean;
  edit(id: string, text: string): boolean;
  reorder(id: string, toIndex: number): boolean;
  resume(): void;
  /** Work in flight: a running turn, or (coordinator) anything not yet delivered. */
  busy(): boolean;
  /** True when the coordinator drives this session. */
  readonly coordinated: boolean;
}

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

export function queueFor(session: AgentSession, coordinator: SessionCoordinator = coordinatorFor()): QueueFacade {
  if (coordinator.has(session.id)) {
    const id = session.id;
    return {
      coordinated: true,
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
    };
  }
  const s = session;
  return {
    coordinated: false,
    accept: (text, opts = {}) => {
      if (!s.enqueue) throw new Error(`${s.id}: session has no queue`);
      const q = s.enqueue(text, { source: opts.source, mirrorToRelay: opts.mirrorToRelay, visible: opts.visible, seq: opts.seq, id: opts.id });
      return { id: q.id, text: q.text, createdAt: q.createdAt, ...(q.handled ? { handled: q.handled } : {}), ...(q.reinjectionId ? { reinjectionId: q.reinjectionId } : {}) };
    },
    state: () => s.queueState?.() ?? { queue: [], pendingCount: 0, hidden: [], inFlight: null, paused: false },
    itemState: (cid) => s.queueItemState?.(cid) ?? "unknown",
    cancel: (cid) => s.cancelQueued?.(cid) ?? false,
    edit: (cid, text) => s.editQueued?.(cid, text) ?? false,
    reorder: (cid, to) => s.reorderQueued?.(cid, to) ?? false,
    resume: () => s.resumeQueue?.(),
    busy: () => s.busy(),
  };
}
