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
  /** One command by id — its durable state, terminal reason and the runtime
   *  turn attributed to it (#498): what `joy ask` / `wait --turn` bound their
   *  reply and completion on. null for an id this session does not own. */
  command(id: string): CommandInfo | null;
}
export interface CommandInfo {
  id: string; text: string; createdAt: number; state: CommandState; terminalReason: string | null;
  /** The attempt the state describes — the latest one: the delivered attempt
   *  of a running / completed command, the terminal one of a failed or
   *  interrupted command. null while the command is still queued. */
  attemptId: string | null;
  /** The runtime's own turn id for that attempt — the `turn` its records
   *  carry — once the runtime named it (codex, opencode, pi name their turns
   *  in the echo; claude's session names the transcript turn its dispatch
   *  opened, #498); null before that. */
  runtimeTurnId: string | null;
  /** Did the runtime start a turn for that attempt at all (a `turn_started`
   *  observation)? A command with none — a slash / `!` command the runtime
   *  handled, a message the daemon handled itself — has no runtime output to
   *  attribute: its completion IS its result. */
  turnStarted: boolean;
  attempts: number;
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
 *  SessionEndedError), by its id. Command ids are global in the ledger, so
 *  every per-command method first checks that the id belongs to THIS
 *  session: another session's command is "unknown" here — not readable,
 *  not editable, not cancellable, not movable (review 7652e686). A row
 *  never changes session, so the check cannot go stale. */
export function queueFor(session: Pick<AgentSession, "id">, coordinator: SessionCoordinator = coordinatorFor()): QueueFacade {
  {
    const id = session.id;
    const owned = (cid: string): boolean => coordinator.command(cid)?.sessionId === id;
    return {
      accept: (text, opts = {}) => {
        const a = coordinator.accept({
          sessionId: id, text, source: opts.source ?? "rpc", mirrorToRelay: opts.mirrorToRelay ?? true, visible: opts.visible ?? false,
          seq: opts.seq, id: opts.id, relayTurnId: opts.relayTurnId, relayCommandId: opts.relayCommandId,
        });
        return { id: a.id, text, createdAt: a.createdAt, ...(a.handled ? { handled: a.handled } : {}), ...(a.reinjectionId ? { reinjectionId: a.reinjectionId } : {}) };
      },
      state: () => coordinator.snapshot(id),
      itemState: (cid) => itemStateOf(owned(cid) ? coordinator.state(cid) : null),
      cancel: (cid) => { if (!owned(cid)) return false; const r = coordinator.cancel(cid); return r.kind === "cancelled" || r.kind === "cancelling"; },
      edit: (cid, text) => owned(cid) && coordinator.edit(cid, text),
      reorder: (cid, to) => owned(cid) && coordinator.reorder(cid, to),
      resume: () => coordinator.resume(id),
      busy: () => { const s = coordinator.snapshot(id); return s.busy || s.pendingCount > 0; },
      command: (cid) => {
        const row = coordinator.command(cid);
        if (!row || row.sessionId !== id) return null;
        const attempts = coordinator.ledger.attemptsForCommand(cid);
        const attempt = attempts.length ? attempts[attempts.length - 1] : null;
        const turn = [...attempts].reverse().find((a) => a.runtimeTurnId)?.runtimeTurnId ?? null;
        const turnStarted = attempt !== null && coordinator.ledger.listObservations(id, "turn_started").some((o) => o.attemptId === attempt.id);
        return { id: row.id, text: row.text, createdAt: row.createdAt, state: row.state, terminalReason: row.terminalReason, attemptId: attempt?.id ?? null, runtimeTurnId: turn, turnStarted, attempts: attempts.length };
      },
      waitFor: async (cid, states, opts) => {
        if (!owned(cid)) return { state: null };
        const state = await coordinator.waitFor(cid, states, { timeoutMs: opts.timeoutMs, signal: opts.signal });
        // Ownership is re-read AFTER the wait (review 11cf51b5): a row never
        // changes session, but a terminal row can be pruned during a long
        // wait and its id accepted again by another session — that row's
        // state and reason are not this session's to report.
        const row = coordinator.command(cid);
        if (!row || row.sessionId !== id) return { state: null };
        return { state, ...(row.terminalReason ? { reason: row.terminalReason } : {}) };
      },
    };
  }
}

/** Is the state one the lane can terminalize on? */
const TERMINAL = new Set<string>(TERMINAL_STATES);
export const isTerminal = (s: CommandState | null): boolean => s !== null && TERMINAL.has(s);
