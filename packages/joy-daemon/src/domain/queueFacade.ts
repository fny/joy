// One queue surface for operations, handoff and the relay lane while the
// adapters migrate onto the session coordinator (Wave C2). A session the
// coordinator has adopted is driven through it (its rows ARE the queue); an
// adapter not yet ported keeps its own enqueue/cancelQueued/queueState and
// is proxied. The facade disappears with the last legacy adapter.
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
   *  when the command is unknown. A legacy adapter is polled through the
   *  heuristics the lane used before C2 (see legacyWaitFor). */
  waitFor(id: string, states: readonly CommandState[], opts: WaitOpts): Promise<WaitResult>;
  /** True when the coordinator drives this session. */
  readonly coordinated: boolean;
}
export interface WaitResult { state: CommandState | null; reason?: string }
export interface WaitOpts {
  timeoutMs: number;
  signal?: AbortSignal;
  /** Legacy adapters only: how to observe the session between polls. */
  legacy?: LegacyWaitEnv;
}
export interface LegacyWaitEnv {
  /** The session under this id NOW (a restart replaces the object). */
  session: () => AgentSession | undefined;
  /** The adapter's own verdict on the running turn, once known (turn-end status). */
  outcome?: () => string | undefined;
  /** A cancel was requested for the turn this command carries. */
  cancelled?: () => boolean;
  pollMs?: number;
  idlePolls?: number;
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
  // A ported adapter has no queue surface of its own — its rows are the
  // coordinator's, live or ended (an ended one refuses with SessionEndedError).
  if (!session.enqueue) {
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
      waitFor: async (cid, states, opts) => {
        const state = await coordinator.waitFor(cid, states, { timeoutMs: opts.timeoutMs, signal: opts.signal });
        const row = coordinator.command(cid);
        return { state, ...(row?.terminalReason ? { reason: row.terminalReason } : {}) };
      },
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
    state: () => {
      const q = s.queueState?.() ?? { queue: [], pendingCount: 0, hidden: [], inFlight: null, paused: false };
      return { ...q, running: null, busy: typeof s.busy === "function" ? s.busy() : false, provenance: null, unresolvedCancels: [], drafts: [], commands: [] };
    },
    itemState: (cid) => s.queueItemState?.(cid) ?? "unknown",
    cancel: (cid) => s.cancelQueued?.(cid) ?? false,
    edit: (cid, text) => s.editQueued?.(cid, text) ?? false,
    reorder: (cid, to) => s.reorderQueued?.(cid, to) ?? false,
    resume: () => s.resumeQueue?.(),
    busy: () => s.busy(),
    waitFor: (cid, states, opts) => legacyWaitFor(s, cid, states, opts),
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TERMINAL = new Set<string>(TERMINAL_STATES);

/** The pre-C2 lane heuristics, kept ONLY for adapters not yet on a driver
 *  (claude): the per-item delivery state answers "did THIS prompt land"
 *  (delivered = running; cancelled/failed are terminal); a session-wide busy
 *  flag is the fallback for an adapter with no per-item tracking; idle for
 *  `idlePolls` consecutive polls says execution STOPPED and the adapter's
 *  own turn-end verdict says how (#584). A restart that replaces the session
 *  object under the id without carrying this item ends it
 *  interrupted{restart} (design table) — the dead object's busy() dropping
 *  used to read as "completed". Deleted with the last legacy adapter. */
export async function legacyWaitFor(original: AgentSession, id: string, states: readonly CommandState[], opts: WaitOpts): Promise<WaitResult> {
  const env = opts.legacy ?? { session: () => original };
  const pollMs = env.pollMs ?? 500;
  const idlePolls = env.idlePolls ?? 3;
  const deadline = Date.now() + opts.timeoutMs;
  const wantsRunning = states.includes("running");
  let idle = 0;
  let running = false;
  for (;;) {
    if (opts.signal?.aborted) return { state: null };
    const sess = env.session() ?? original;
    const q = queueFor(sess);
    const st = q.itemState(id);
    const tracked = st !== "unknown";
    if (env.cancelled?.()) return { state: "cancelled", reason: "cancelled" };
    if (sess !== original && !tracked) return { state: "interrupted", reason: "restart" };
    if (q.state().paused) return { state: "failed", reason: "queue_paused" };
    if (st === "cancelled") return { state: "cancelled", reason: "prompt_cancelled_locally" };
    if (st === "failed") return { state: "failed", reason: "prompt_rejected_by_agent" };
    if (!running) {
      // Phase A/B: our prompt reached the agent and the turn is running.
      if (tracked ? st === "delivered" : sess.busy()) {
        running = true;
        if (wantsRunning) return { state: "running" };
      }
    } else {
      // Phase C: idle says execution STOPPED; the adapter's turn-end says how.
      if (sess.busy()) idle = 0;
      else if (++idle >= idlePolls) {
        const outcome = env.outcome?.();
        if (outcome === "failed") return { state: "failed", reason: "agent_reported_failed" };
        if (outcome === "cancelled") return { state: "cancelled", reason: "agent_reported_cancelled" };
        return { state: "completed" };
      }
    }
    if (Date.now() > deadline) return { state: running ? "running" : (tracked ? "submitting" : "queued") };
    await sleep(pollMs);
  }
}
/** Is the state one the lane can terminalize on? */
export const isTerminal = (s: CommandState | null): boolean => s !== null && TERMINAL.has(s);
