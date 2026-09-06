// The session coordinator (review campaign 2026-09, architecture item 4 /
// Wave C2). ONE owner of execution policy for every agent flavour: durable
// command states over the ledger (domain/ledger.ts), a generation per
// session replacement, an attempt per submission, cancellation as a durable
// requested transition retried until confirmed or explicitly unresolved.
// Adapters are DRIVERS (submit, interrupt, observe, reconcile) that keep
// protocol buffering only; they own no second queue and no outcome cache.
//
// The rules, so a reader can check a transition against them:
//   R1  accept returns after the ledger COMMIT or throws (no opt-out);
//   R4  recordAttempt commits `submitting` (with the op token) BEFORE
//       driver.submit; a failed commit = no token = no submit (#514);
//   R6  rows are session-keyed and generation-fenced; retire never deletes
//       a queued row — the replacement takes it (#481 #36 #49 #421);
//   R7  a command completes only on the runtime's terminal for ITS attempt;
//   R8  a turn nobody submitted is a FOREIGN turn with its own provenance —
//       it never confirms an attempt (#78 #32);
//   R9  the row exists before any preparation; cancel is a durable flag
//       consulted at every op boundary (#77 #35 #453);
//   R10 cancel of a non-queued command → `cancelling`, interrupt retried
//       with backoff until confirmed, else flagged `unresolved` (#66 #79);
//   R14 a permanent rejection → `failed`; terminal rows are never
//       re-submitted; `unknown` is reconciled, never blindly retried;
//   R15 one driver operation per session at a time; a steer is a command;
//   R16 confirmation kind is declared by the driver; a turn start never
//       confirms an attempt; a submit timeout → `unknown` → reconcile;
//   R17 the terminal state IS the attempt's outcome; an idle runtime with no
//       terminal for the running attempt = `interrupted` (#463);
//   R18 observations that arrived before the submit response are applied
//       when the response names their turn (#512 #513);
//   R19 accept refuses a closed generation (#553, in the ledger);
//   R20 steer-from-queue = cancel + accept in one ledger transaction (#135).
//
// Serialize state TRANSITIONS, never I/O: an op token is committed, the
// driver call runs with no lock held, and its result is applied only if the
// token and the generation still own the row (#34 deadlock class).
import { randomUUID } from "node:crypto";
import {
  Ledger, ledgerFor, isTerminalState,
  StaleCommandError, StaleGenerationError, LedgerWriteError, SessionEndedError,
  type CommandRow, type AttemptRow, type CommandState, type NewReceipt,
} from "./ledger";

// ── driver contract ──────────────────────────────────────────────────────────

export interface DriverCapabilities {
  /** The runtime can take a message INTO a running turn (OpenCode
   *  delivery:'steer', pi steer, Claude /steer). */
  steer: boolean;
  /** Interrupt names a turn (codex turnInterrupt(turnId)); false = the
   *  interrupt is session-wide (opencode/pi/agy) or a keystroke (claude). */
  targetedInterrupt: boolean;
  /** A submit that times out or loses its socket may still have landed
   *  (codex): the result is `unknown`, never a resend. */
  ambiguousSubmit: boolean;
  /** A human may be typing in the same input (claude's pane). */
  terminalDraft: boolean;
  /** What proves delivery of a submission. */
  echo: "clientId" | "admission" | "transcript" | "rpc_response" | "process";
  /** The runtime accepts another submission while a turn is running. */
  concurrentSubmit: boolean;
}

/** What a driver sees of a command (never the row's bookkeeping columns). */
export interface CommandView {
  id: string; sessionId: string; text: string; origin: string; source: string;
  seq: number | null; relayTurnId: string | null; relayCommandId: string | null;
  visible: boolean; mirrorToRelay: boolean; payloadVersion: number; createdAt: number;
}
/** One submission. `runtimeRef` is what the runtime will echo back
 *  (codex clientUserMessageId, opencode messageID, …); `token` is the op
 *  token the coordinator committed with the attempt. */
export interface AttemptRef {
  attemptId: string; commandId: string; attemptNo: number; runtimeRef: string; token: string;
  runtimeTurnId: string | null;
}
export type SubmitResult =
  | { kind: "accepted"; runtimeTurnId?: string | null }
  | { kind: "rejected"; permanent: boolean; detail: string; /** a busy/already-active refusal: retried on the next idle, not counted */ busy?: boolean; retryAfterMs?: number }
  | { kind: "unknown"; detail: string };
export type InterruptResult = { kind: "sent" | "failed" | "noop"; error?: string };
export interface ReconcileOutcome { attemptId: string; outcome: "accepted" | "running" | "absent" | "unknown"; runtimeTurnId?: string | null }

/** What a driver reports. Attribution is the coordinator's: an observation
 *  naming a runtimeRef/runtimeTurnId of one of this session's attempts is
 *  that attempt's; anything else is a foreign (terminal-started) turn. */
export type Observation =
  | { kind: "ready" }
  | { kind: "echo"; runtimeRef: string; runtimeTurnId?: string | null; receiptKind?: string }
  | { kind: "turn_started"; runtimeTurnId?: string | null; runtimeRef?: string | null }
  | { kind: "turn_ended"; runtimeTurnId?: string | null; runtimeRef?: string | null; status: TurnStatus; detail?: string }
  | { kind: "idle" }
  | { kind: "interrupted"; runtimeTurnId?: string | null }
  | { kind: "process_exited"; reason?: string }
  | { kind: "draft_preserved"; text: string }
  | { kind: "checkpoint"; checkpointKind: string; ref: string; offset: number }
  | { kind: "paused"; reason: QueuePauseReason }
  | { kind: "resumed" };
export type TurnStatus = "completed" | "failed" | "cancelled" | "interrupted";
export type QueuePauseReason = "input_dirty" | "dispatch_timeout" | "dispatch_mismatch" | "dispatch_failed";

export type HandledCommand =
  | { handled: true; /** text to queue as a hidden follow-up (e.g. /joy-prompt's reinjection) */ reinjection?: string }
  /** The text is a steer: accept `steer` as a command of origin `steer` (R15/#34). */
  | { handled?: false; steer: string };

export interface RuntimeDriver {
  readonly sessionId: string;
  readonly generation: number;
  readonly capabilities: DriverCapabilities;
  submit(cmd: CommandView, attempt: AttemptRef, signal: AbortSignal): Promise<SubmitResult>;
  /** Wait until the runtime can take a submission (claude: the pane gate —
   *  idle, ready prompt, empty box). Runs BEFORE the attempt is committed, so
   *  a row waiting at the gate stays `queued` and a cancel meanwhile is an
   *  ordinary queued → cancelled. `cancelled` = the command is no longer
   *  dispatchable; `retired` = the driver is gone. */
  prepare?(cmd: CommandView, signal: AbortSignal): Promise<"ready" | "cancelled" | "retired">;
  /** Stop the attempt (targeted when the driver can), or whatever is running
   *  when no attempt is named. `noop` = nothing was running. */
  interrupt(target: { attempt: AttemptRef | null }): Promise<InterruptResult>;
  observe(sink: (o: Observation) => void): () => void;
  /** After a restart: what became of attempts still awaiting evidence. */
  reconcile(pending: AttemptRef[]): Promise<ReconcileOutcome[]>;
  steer?(cmd: CommandView, attempt: AttemptRef, signal: AbortSignal): Promise<SubmitResult>;
  /** A joy-owned slash command the harness handles itself (/title …):
   *  returns how it was handled, or null for ordinary text. */
  handleCommand?(text: string, opts: { source: string; mirrorToRelay: boolean; seq?: number | null }): HandledCommand | null;
  /** Post-commit hook for a freshly accepted command (mirror its user row). */
  accepted?(cmd: CommandView): void;
  /** A queue pause the driver reported was lifted by the app / CLI. */
  resume?(): void;
  /** The runtime ref a submission carries. Default: the command id, then
   *  `<id>#a<n>` per resend so two submissions stay distinguishable. A
   *  runtime whose ids are idempotent server-side (opencode messageID)
   *  returns the SAME ref for every attempt. */
  runtimeRef?(cmd: CommandView, attemptNo: number): string;
}

// ── the pure state machine ───────────────────────────────────────────────────

export type MachineEvent =
  | { type: "attempt" }
  | { type: "submit_accepted" }
  | { type: "submit_unknown" }
  | { type: "submit_rejected"; permanent: boolean }
  | { type: "evidence" }
  | { type: "turn_ended"; status: TurnStatus }
  | { type: "reconcile"; outcome: ReconcileOutcome["outcome"] }
  | { type: "cancel" }
  | { type: "interrupt_confirmed" }
  | { type: "interrupt_failed"; exhausted: boolean }
  | { type: "generation_closed"; reason: string; keepQueued: boolean }
  | { type: "idle" }
  | { type: "edit" };
export const MACHINE_EVENT_TYPES: ReadonlyArray<MachineEvent["type"]> = [
  "attempt", "submit_accepted", "submit_unknown", "submit_rejected", "evidence", "turn_ended", "reconcile",
  "cancel", "interrupt_confirmed", "interrupt_failed", "generation_closed", "idle", "edit",
];
export const COMMAND_STATES: readonly CommandState[] = ["queued", "submitting", "accepted", "unknown", "running", "cancelling", "completed", "failed", "cancelled", "interrupted"];
export interface Transition { to: CommandState; terminalReason?: string; /** the interrupt budget is spent: surface `unresolved` */ unresolved?: boolean }

const ended = (status: TurnStatus): Transition => status === "completed" ? { to: "completed", terminalReason: "completed" } : { to: status, terminalReason: `agent_reported_${status}` };
const closed = (ev: { reason: string; keepQueued: boolean }, inFlight: boolean): Transition =>
  ev.keepQueued ? { to: inFlight ? "unknown" : "queued" } : { to: "interrupted", terminalReason: ev.reason };

/** The one answer for every (state, event) pair, or null = the event is not
 *  meaningful in that state (a late duplicate, a stray signal) and changes
 *  nothing. Terminal states answer null to everything: a row that ended is
 *  never re-submitted, re-completed or re-cancelled (R14). */
export function nextState(state: CommandState, ev: MachineEvent): Transition | null {
  if (isTerminalState(state)) return null;
  switch (state) {
    case "queued": switch (ev.type) {
      case "attempt": return { to: "submitting" };
      case "cancel": return { to: "cancelled", terminalReason: "cancelled" };
      case "edit": return { to: "queued" };
      case "evidence": return { to: "running" }; // a late echo of an earlier (unknown) submission: it landed after all
      case "generation_closed": return closed(ev, false);
      default: return null;
    }
    case "submitting": switch (ev.type) {
      case "submit_accepted": return { to: "accepted" };
      case "submit_unknown": return { to: "unknown" };
      case "submit_rejected": return ev.permanent ? { to: "failed", terminalReason: "rejected" } : { to: "queued" };
      case "evidence": return { to: "running" }; // the echo beat the response (R18)
      case "turn_ended": return ended(ev.status);
      case "cancel": return { to: "cancelling" };
      case "generation_closed": return closed(ev, true);
      default: return null;
    }
    case "accepted": switch (ev.type) {
      case "evidence": return { to: "running" };
      case "turn_ended": return ended(ev.status);
      case "cancel": return { to: "cancelling" };
      case "idle": return { to: "interrupted", terminalReason: "idle_without_terminal" };
      case "generation_closed": return closed(ev, true);
      default: return null;
    }
    case "unknown": switch (ev.type) {
      case "reconcile": return ev.outcome === "accepted" ? { to: "accepted" } : ev.outcome === "running" ? { to: "running" } : ev.outcome === "absent" ? { to: "queued" } : { to: "unknown" };
      case "evidence": return { to: "running" };
      case "turn_ended": return ended(ev.status);
      case "cancel": return { to: "cancelling" };
      case "generation_closed": return closed(ev, true);
      default: return null;
    }
    case "running": switch (ev.type) {
      case "evidence": return { to: "running" };
      case "turn_ended": return ended(ev.status);
      case "cancel": return { to: "cancelling" };
      case "idle": return { to: "interrupted", terminalReason: "idle_without_terminal" };
      case "generation_closed": return closed(ev, true);
      default: return null;
    }
    case "cancelling": switch (ev.type) {
      case "interrupt_confirmed": return { to: "cancelled", terminalReason: "cancelled" };
      case "interrupt_failed": return { to: "cancelling", unresolved: ev.exhausted };
      // The runtime finished the work before the interrupt landed: its own
      // verdict stands — completed stays completed, failed stays failed.
      case "turn_ended": return ev.status === "completed" || ev.status === "failed" ? ended(ev.status) : { to: "cancelled", terminalReason: "cancelled" };
      case "idle": return { to: "cancelled", terminalReason: "cancelled" };
      case "submit_accepted": case "submit_unknown": case "evidence": return { to: "cancelling" }; // now there is something to interrupt
      case "submit_rejected": return { to: "cancelled", terminalReason: "cancelled" }; // never ran
      case "cancel": return { to: "cancelling" };
      case "generation_closed": return { to: "cancelled", terminalReason: `cancelled:${ev.reason}` };
      default: return null;
    }
  }
  return null;
}

// ── public shapes ────────────────────────────────────────────────────────────

export interface AcceptInput {
  sessionId: string; text: string;
  /** relay | local | handoff | reinjection | steer | import */
  origin?: string;
  /** DeliverySource: relay | web | rpc */
  source: string;
  seq?: number | null; relayTurnId?: string | null; relayCommandId?: string | null;
  visible: boolean; mirrorToRelay: boolean;
  /** A caller-chosen id (a restart carrying a prompt keeps its id). */
  id?: string;
  mode?: "queue" | "steer";
}
export interface Accepted {
  id: string; state: CommandState;
  deduped: "none" | "pending" | "receipt";
  /** The driver handled the text itself (a joy slash command): the row is
   *  already terminal; nothing will be dispatched for it. */
  handled?: "command";
  /** The hidden follow-up a handled command queued (/joy-prompt). */
  reinjectionId?: string;
  createdAt: number;
}
export type CancelResult = { kind: "cancelled" | "cancelling" | "already" | "unknown"; state: CommandState | null };

export interface CommandSummary { id: string; text: string; createdAt: number; state: CommandState; origin: string; visible: boolean }
/** The app's queue view of a session (joy__queue + queue ops). The first
 *  five fields are the pre-C2 QueueState; the rest carry the coordinator's
 *  states so a caller never has to guess from a busy flag. */
export interface QueueSnapshot {
  queue: Array<{ id: string; text: string; createdAt: number }>;
  pendingCount: number;
  hidden: Array<{ id: string; text: string; createdAt: number }>;
  inFlight: string | null;
  paused: boolean;
  pauseReason?: QueuePauseReason;
  /** The command whose turn is executing (running | cancelling), if any. */
  running: CommandSummary | null;
  /** Something is executing: a command, or a turn started at the terminal. */
  busy: boolean;
  provenance: "command" | "terminal" | null;
  /** Commands whose interrupt budget is spent without confirmation (R10). */
  unresolvedCancels: string[];
  /** A human draft the driver cleared for a dispatch and will restore. */
  drafts: string[];
  /** Non-terminal commands in FIFO order, with their states. */
  commands: CommandSummary[];
}

export type CoordinatorEvent =
  | { type: "command"; sessionId: string; commandId: string; state: CommandState; terminalReason: string | null; row: CommandRow | null }
  | { type: "session"; sessionId: string }
  | { type: "cancel_unresolved"; sessionId: string; commandId: string }
  | { type: "foreign_turn"; sessionId: string; runtimeTurnId: string | null; phase: "started" | "ended" };

export class SessionNotAdoptedError extends Error {
  constructor(sessionId: string) { super(`${sessionId}: no runtime driver is adopted for this session`); this.name = "SessionNotAdoptedError"; }
}

export interface CoordinatorOpts {
  ledger?: Ledger;
  log?: (line: string) => void;
  now?: () => number;
  /** Timer seam (tests drive a manual clock). Returns a canceller. */
  schedule?: (fn: () => void, ms: number) => () => void;
  /** Interrupt tries before a cancel is flagged unresolved. */
  maxCancelAttempts?: number;
  cancelBackoffMs?: number;
  /** Transient (non-busy) rejections before a command fails. */
  maxTransientRejections?: number;
  rejectionBackoffMs?: number;
  /** Delay before re-trying a refused attempt commit (#514). */
  persistRetryMs?: number;
  /** How long to wait for the runtime to confirm a sent interrupt before trying again. */
  interruptConfirmMs?: number;
}

const PERSIST_RETRY_MS = 2_000;

interface Actor {
  sessionId: string; driver: RuntimeDriver; generation: number;
  ready: boolean; retired: boolean; paused: boolean; pauseReason?: QueuePauseReason;
  unsubscribe: () => void;
  pumping: boolean; pumpAgain: boolean;
  /** Earliest time the pump may dispatch again (rejection / persist backoff). */
  holdUntil: number; holdTimer: (() => void) | null;
  abort: AbortController;
  foreignTurn: { runtimeTurnId: string | null; since: number } | null;
  unresolved: Set<string>;
  cancelTimers: Map<string, () => void>;
  cancelOps: Map<string, string>;
  /** Cancelled rows whose late evidence named a turn still running (the
   *  tombstone rule): commandId → the attempt that surfaced. Owned by the
   *  same interrupt scheduler as `cancelling` rows. */
  tombstones: Map<string, string>;
  /** A session-wide interrupt in flight (untargeted drivers). */
  sessionInterrupt: Promise<void> | null;
  /** Aborts the driver's `prepare` wait so the pump re-plans (a steer arrived). */
  prepareAbort: AbortController | null;
  drafts: string[];
  reconciling: boolean;
}

// ── the coordinator ──────────────────────────────────────────────────────────

export class SessionCoordinator {
  readonly ledger: Ledger;
  #log: (line: string) => void;
  #now: () => number;
  #schedule: (fn: () => void, ms: number) => () => void;
  #o: Required<Pick<CoordinatorOpts, "maxCancelAttempts" | "cancelBackoffMs" | "maxTransientRejections" | "rejectionBackoffMs" | "persistRetryMs" | "interruptConfirmMs">>;
  #actors = new Map<string, Actor>();
  #listeners = new Set<(ev: CoordinatorEvent) => void>();

  constructor(opts: CoordinatorOpts = {}) {
    this.ledger = opts.ledger ?? ledgerFor();
    this.#log = opts.log ?? ((line) => process.stderr.write(`[coordinator] ${line}\n`));
    this.#now = opts.now ?? Date.now;
    this.#schedule = opts.schedule ?? ((fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return () => clearTimeout(t); });
    this.#o = {
      maxCancelAttempts: opts.maxCancelAttempts ?? 5,
      cancelBackoffMs: opts.cancelBackoffMs ?? 1_000,
      maxTransientRejections: opts.maxTransientRejections ?? 3,
      rejectionBackoffMs: opts.rejectionBackoffMs ?? 2_000,
      persistRetryMs: opts.persistRetryMs ?? PERSIST_RETRY_MS,
      interruptConfirmMs: opts.interruptConfirmMs ?? 3_000,
    };
  }

  // ── events ──
  subscribe(fn: (ev: CoordinatorEvent) => void): () => void {
    this.#listeners.add(fn);
    return () => { this.#listeners.delete(fn); };
  }
  #emit(ev: CoordinatorEvent): void {
    for (const l of [...this.#listeners]) { try { l(ev); } catch (e) { this.#log(`listener threw: ${e instanceof Error ? e.message : e}`); } }
  }
  #emitCommand(id: string): CommandRow | null {
    const row = this.ledger.getCommand(id);
    this.#emit({ type: "command", sessionId: row?.sessionId ?? "", commandId: id, state: row?.state ?? "interrupted", terminalReason: row?.terminalReason ?? null, row });
    if (row) this.#emit({ type: "session", sessionId: row.sessionId });
    return row;
  }

  // ── sessions ──
  has(sessionId: string): boolean { return this.#actors.has(sessionId); }
  driverFor(sessionId: string): RuntimeDriver | null { return this.#actors.get(sessionId)?.driver ?? null; }
  generationOf(sessionId: string): number | null { return this.#actors.get(sessionId)?.generation ?? null; }

  /** Take a runtime driver for a session (create / recover / restart). The
   *  driver's generation must be the ledger's current open one. Unknown
   *  attempts are reconciled once the driver reports `ready`, then the pump
   *  takes the queued rows (a replacement finds its predecessor's queue,
   *  R6). */
  adopt(sessionId: string, driver: RuntimeDriver): void {
    const prev = this.#actors.get(sessionId);
    if (prev) this.#detach(prev);
    const cur = this.ledger.currentGeneration(sessionId);
    if (!cur || cur.generation !== driver.generation || !cur.open) throw new StaleGenerationError(sessionId, driver.generation, cur?.generation ?? null);
    const actor: Actor = {
      sessionId, driver, generation: driver.generation, ready: false, retired: false, paused: false,
      unsubscribe: () => {}, pumping: false, pumpAgain: false, holdUntil: 0, holdTimer: null,
      abort: new AbortController(), foreignTurn: null, unresolved: new Set(), cancelTimers: new Map(), cancelOps: new Map(),
      tombstones: new Map(), sessionInterrupt: null, prepareAbort: null, drafts: [], reconciling: false,
    };
    actor.unsubscribe = driver.observe((o) => this.#observe(actor, o));
    this.#actors.set(sessionId, actor);
    this.#emit({ type: "session", sessionId });
  }

  /** The session's runtime is gone (killed | process_exited | restart). The
   *  generation closes: queued rows stay for a restart / the next daemon,
   *  are interrupted on a kill; anything mid-flight becomes an explicit
   *  `unknown` for the replacement to reconcile, or `interrupted` on a kill.
   *  A cancel still in flight is confirmed by the runtime's death. Never
   *  awaits the driver. */
  retire(sessionId: string, reason: "killed" | "process_exited" | "restart"): void {
    const actor = this.#actors.get(sessionId);
    const generation = actor?.generation ?? this.ledger.currentGeneration(sessionId)?.generation;
    if (actor) this.#detach(actor);
    if (generation == null) return;
    const before = this.ledger.listPending(sessionId);
    const keepQueued = reason !== "killed";
    try {
      this.ledger.tx(() => {
        for (const row of before) {
          if (row.state === "cancelling") {
            const t = nextState("cancelling", { type: "generation_closed", reason, keepQueued })!;
            this.ledger.transition(row.id, ["cancelling"], t.to, { terminalReason: t.terminalReason, generation });
          } else if (keepQueued && (row.state === "running" || row.state === "accepted")) {
            // The runtime had this turn live and is being torn down on
            // purpose (restart) or died (process_exited): the turn is over,
            // and re-running a prompt the agent already took would duplicate
            // it. Design table: interrupted{reason}. Only rows with no
            // evidence of delivery (submitting → unknown) are reconciled.
            this.ledger.transition(row.id, [row.state], "interrupted", { terminalReason: reason, generation });
          }
        }
        this.ledger.closeGeneration(sessionId, generation, reason, { keepQueued });
      }, "retire");
    } catch (e) {
      this.#log(`${sessionId}: retire(${reason}) could not commit: ${e instanceof Error ? e.message : e}`);
    }
    for (const row of before) {
      const now = this.ledger.getCommand(row.id);
      if (now && now.state !== row.state) this.#emitCommand(row.id);
    }
    this.#emit({ type: "session", sessionId });
  }

  #detach(actor: Actor): void {
    actor.retired = true;
    actor.ready = false;
    try { actor.unsubscribe(); } catch { /* driver gone */ }
    actor.abort.abort();
    actor.holdTimer?.(); actor.holdTimer = null;
    for (const cancel of actor.cancelTimers.values()) cancel();
    actor.cancelTimers.clear();
    actor.tombstones.clear();
    if (this.#actors.get(actor.sessionId) === actor) this.#actors.delete(actor.sessionId);
  }

  // ── intake ──
  /** Accept a text for a session. Returns only after the ledger commit (R1)
   *  or throws: LedgerWriteError (nothing accepted), SessionEndedError
   *  (#553), SessionNotAdoptedError (no runtime here). A duplicate (same
   *  id / relay seq / relay turn) returns the existing row, never a second
   *  one. A joy-owned command the driver handles completes in the same
   *  transaction. */
  accept(input: AcceptInput): Accepted {
    const actor = this.#actors.get(input.sessionId);
    if (!actor) {
      const g = this.ledger.currentGeneration(input.sessionId);
      if (g && !g.open) throw new SessionEndedError(input.sessionId);
      throw new SessionNotAdoptedError(input.sessionId);
    }
    const origin = input.origin ?? (input.mode === "steer" ? "steer" : input.seq != null || input.relayTurnId ? "relay" : "local");
    if (input.mode !== "steer" && actor.driver.handleCommand) {
      const h = actor.driver.handleCommand(input.text, { source: input.source, mirrorToRelay: input.mirrorToRelay, seq: input.seq });
      if (h && "steer" in h && typeof h.steer === "string") {
        // A steer is never an editable chip: it goes ahead of the FIFO now.
        return this.accept({ ...input, text: h.steer, mode: "steer", origin: "steer", visible: false });
      }
      if (h && h.handled) {
        const out = this.ledger.tx(() => {
          const r = this.ledger.acceptCommand({ ...input, origin: "command", state: "queued", generation: actor.generation });
          if (r.deduped === "none") this.ledger.transition(r.id, ["queued"], "completed", { terminalReason: "handled_as_command", generation: actor.generation });
          let reinjectionId: string | undefined;
          if (h.reinjection && r.deduped === "none") {
            reinjectionId = this.ledger.acceptCommand({ sessionId: input.sessionId, text: h.reinjection, origin: "reinjection", source: input.source, visible: false, mirrorToRelay: false, generation: actor.generation }).id;
          }
          return { id: r.id, deduped: r.deduped, reinjectionId, createdAt: r.row?.createdAt ?? this.#now() };
        }, "accept");
        this.#emitCommand(out.id);
        if (out.reinjectionId) { this.#emitCommand(out.reinjectionId); this.#pump(actor.sessionId); }
        return { id: out.id, state: "completed", deduped: out.deduped, handled: "command", reinjectionId: out.reinjectionId, createdAt: out.createdAt };
      }
    }
    const r = this.ledger.acceptCommand({ ...input, origin, generation: actor.generation });
    if (r.deduped === "none") {
      const view = this.#view(r.row!);
      try { actor.driver.accepted?.(view); } catch (e) { this.#log(`${input.sessionId}: driver.accepted threw: ${e instanceof Error ? e.message : e}`); }
      if (origin === "steer") actor.prepareAbort?.abort(); // a steer goes ahead of a prompt waiting at the gate
    }
    this.#emitCommand(r.id);
    this.#pump(actor.sessionId);
    return { id: r.id, state: r.row?.state ?? "completed", deduped: r.deduped, createdAt: r.row?.createdAt ?? this.#now() };
  }

  /** Durable cancel (R9/R10). A queued row is cancelled at once; a row in
   *  flight becomes `cancelling` and its interrupt is scheduled and retried
   *  until the runtime confirms (turn_ended / interrupted / idle) or the
   *  budget is spent (`unresolved`, surfaced in the snapshot). */
  cancel(commandId: string): CancelResult {
    const row = this.ledger.getCommand(commandId);
    if (!row) return { kind: "unknown", state: null };
    if (isTerminalState(row.state)) return { kind: "already", state: row.state };
    const t = nextState(row.state, { type: "cancel" })!;
    const actor = this.#actors.get(row.sessionId);
    this.ledger.tx(() => {
      if (row.cancelRequestedAt == null) this.ledger.requestCancel(commandId);
      if (row.state !== "queued") this.ledger.transition(commandId, [row.state], t.to, { terminalReason: t.terminalReason, ...(actor ? { generation: actor.generation } : {}) });
    }, "cancel");
    const after = this.#emitCommand(commandId);
    if (after?.state === "cancelling" && row.state !== "cancelling" && actor) this.#scheduleInterrupt(actor, commandId, 0); // once, on the transition: a repeated cancel does not re-fire the interrupt
    if (actor) this.#pump(actor.sessionId);
    return { kind: after?.state === "cancelled" ? "cancelled" : "cancelling", state: after?.state ?? null };
  }

  /** Only a queued row is editable (the payload version bumps). */
  edit(commandId: string, text: string): boolean {
    const ok = this.ledger.editCommand(commandId, text);
    if (ok) this.#emitCommand(commandId);
    return ok;
  }
  reorder(commandId: string, toIndex: number): boolean {
    const ok = this.ledger.reorderCommand(commandId, toIndex);
    if (ok) this.#emitCommand(commandId);
    return ok;
  }
  /** Lift a driver-reported pause (the driver clears what it paused on —
   *  claude wipes a dirty box first) and pump. */
  resume(sessionId: string): void {
    const actor = this.#actors.get(sessionId);
    if (!actor) return;
    actor.paused = false; actor.pauseReason = undefined;
    actor.holdUntil = 0;
    try { actor.driver.resume?.(); } catch (e) { this.#log(`${sessionId}: driver.resume threw: ${e instanceof Error ? e.message : e}`); }
    this.#emit({ type: "session", sessionId });
    this.#pump(sessionId);
  }

  /** Steer-from-queue (R20): the queued row is cancelled and the same text
   *  accepted as a steer in one transaction. */
  steerFromQueue(commandId: string): Accepted | null {
    const row = this.ledger.getCommand(commandId);
    if (!row || row.state !== "queued") return null;
    return this.ledger.tx(() => {
      this.ledger.requestCancel(commandId);
      return this.accept({ sessionId: row.sessionId, text: row.text, source: row.source, visible: row.visible, mirrorToRelay: row.mirrorToRelay, mode: "steer" });
    }, "steer");
  }

  /** Stop whatever is executing: every command in flight is cancelled
   *  (durably) and its FIRST interrupt is driven here so the caller gets the
   *  runtime's verdict (retries stay in the background); a foreign turn — or
   *  a runtime with nothing attributable — gets a session-wide interrupt.
   *  `ok:false` when an interrupt was refused; the app's Stop must not read
   *  success while the agent runs (#8). */
  async abortRunning(sessionId: string): Promise<{ ok: boolean; error?: string }> {
    const actor = this.#actors.get(sessionId);
    if (!actor) return { ok: false, error: "no runtime" };
    const inFlight = this.ledger.listPending(sessionId).filter((r) => r.state !== "queued");
    const errors: string[] = [];
    for (const r of inFlight) this.cancel(r.id);
    // A session-wide interrupt stops everything at once: one op covers them all.
    const ops = actor.driver.capabilities.targetedInterrupt ? inFlight : inFlight.slice(0, 1);
    let invoked = 0;
    for (const r of ops) {
      actor.cancelTimers.get(r.id)?.(); actor.cancelTimers.delete(r.id);
      const res = await this.#interruptOp(actor, r.id);
      if (res) invoked++;
      if (res?.kind === "failed") errors.push(res.error ?? "interrupt failed");
    }
    // Nothing reached the driver (every attempt still submitting — its
    // completion consults the cancel flag) — but Stop means the runtime
    // itself, so the session-wide interrupt still goes out once.
    if (inFlight.length && !actor.foreignTurn && invoked > 0) return errors.length ? { ok: false, error: errors.join("; ") } : { ok: true };
    try {
      const r = await actor.driver.interrupt({ attempt: null });
      if (r.kind === "failed") return { ok: false, error: r.error ?? "interrupt failed" };
      return errors.length ? { ok: false, error: errors.join("; ") } : { ok: true };
    } catch (e) {
      return { ok: false, error: `interrupt failed: ${e instanceof Error ? e.message : e}` };
    }
  }

  // ── reads ──
  state(commandId: string): CommandState | null { return this.ledger.getCommand(commandId)?.state ?? null; }
  command(commandId: string): CommandRow | null { return this.ledger.getCommand(commandId); }
  commandForRelayTurn(relayTurnId: string): CommandRow | null { return this.ledger.commandForRelayTurn(relayTurnId); }

  /** Resolve once the command is in one of `states` (or already is), on
   *  abort (`signal`) or after `timeoutMs` with the current state. */
  waitFor(commandId: string, states: readonly CommandState[], opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<CommandState | null> {
    const cur = this.state(commandId);
    if (cur === null || states.includes(cur)) return Promise.resolve(cur);
    return new Promise((resolve) => {
      let done = false;
      let unsub = () => {};
      let cancelTimer = () => {};
      const finish = (s: CommandState | null) => { if (done) return; done = true; unsub(); cancelTimer(); opts.signal?.removeEventListener("abort", onAbort); resolve(s); };
      const onAbort = () => finish(this.state(commandId));
      unsub = this.subscribe((ev) => {
        if (ev.type !== "command" || ev.commandId !== commandId) return;
        if (states.includes(ev.state)) finish(ev.state);
      });
      if (opts.timeoutMs != null) cancelTimer = this.#schedule(() => finish(this.state(commandId)), opts.timeoutMs);
      if (opts.signal) { if (opts.signal.aborted) onAbort(); else opts.signal.addEventListener("abort", onAbort, { once: true }); }
      // The state may have moved between the first read and the subscription.
      const again = this.state(commandId);
      if (again === null || states.includes(again)) finish(again);
    });
  }

  snapshot(sessionId: string): QueueSnapshot {
    const actor = this.#actors.get(sessionId);
    const rows = this.ledger.listPending(sessionId);
    const sum = (r: CommandRow): CommandSummary => ({ id: r.id, text: r.text, createdAt: r.createdAt, state: r.state, origin: r.origin, visible: r.visible });
    const slim = (r: CommandRow) => ({ id: r.id, text: r.text, createdAt: r.createdAt });
    const running = rows.find((r) => r.state === "running" || r.state === "cancelling") ?? null;
    const dispatching = rows.find((r) => r.state === "submitting" || r.state === "accepted" || r.state === "unknown") ?? null;
    return {
      queue: rows.filter((r) => r.state === "queued" && r.visible).map(slim),
      hidden: rows.filter((r) => r.state === "queued" && !r.visible).map(slim),
      pendingCount: rows.filter((r) => r.state !== "running" && r.state !== "cancelling").length,
      inFlight: dispatching?.text ?? null,
      paused: actor?.paused ?? false,
      ...(actor?.pauseReason ? { pauseReason: actor.pauseReason } : {}),
      running: running ? sum(running) : null,
      busy: !!running || !!actor?.foreignTurn,
      provenance: running ? "command" : actor?.foreignTurn ? "terminal" : null,
      unresolvedCancels: actor ? [...actor.unresolved] : [],
      drafts: actor ? [...actor.drafts] : [],
      commands: rows.map(sum),
    };
  }
  /** Is a turn executing on the session (a command's or a foreign one)? */
  busy(sessionId: string): boolean {
    const actor = this.#actors.get(sessionId);
    if (actor?.foreignTurn) return true;
    return this.ledger.listPending(sessionId).some((r) => r.state === "running" || r.state === "cancelling");
  }
  /** Take (and clear) the drafts the driver preserved for restoration. */
  takeDrafts(sessionId: string): string[] {
    const actor = this.#actors.get(sessionId);
    if (!actor) return [];
    const d = actor.drafts.splice(0);
    if (d.length) this.#emit({ type: "session", sessionId });
    return d;
  }

  // ── the pump: one driver operation per session at a time (R15) ──
  #pump(sessionId: string): void {
    const actor = this.#actors.get(sessionId);
    if (!actor) return;
    if (actor.pumping) { actor.pumpAgain = true; return; }
    actor.pumping = true;
    // The loop starts on a microtask: accept() returns the committed row
    // before any driver call, and a driver that observes synchronously
    // from inside submit never re-enters the pump.
    void Promise.resolve().then(() => this.#pumpLoop(actor))
      .catch((e) => this.#log(`${sessionId}: pump crashed: ${e instanceof Error ? e.stack ?? e.message : e}`))
      .finally(() => {
        actor.pumping = false;
        if (actor.pumpAgain) { actor.pumpAgain = false; this.#pump(sessionId); }
      });
  }

  async #pumpLoop(actor: Actor): Promise<void> {
    const { sessionId, driver } = actor;
    for (;;) {
      if (actor.retired || !actor.ready || actor.paused) return;
      const pending = this.ledger.listPending(sessionId);
      // An attempt still awaiting its verdict is THE operation in flight.
      if (this.ledger.attemptsAwaiting(sessionId).some((a) => pending.some((p) => p.id === a.commandId && p.state !== "queued"))) return;
      const running = pending.some((r) => r.state === "running" || r.state === "cancelling");
      const head = this.#queueHead(sessionId);
      if (!head) return;
      // A steer goes through the driver's steer op whenever it has one: into
      // the running turn, or — a turn the coordinator does not own (typed at
      // the terminal), or none — typed and submitted now, bypassing the gate.
      const asSteer = head.origin === "steer" && driver.capabilities.steer && !!driver.steer;
      if (running && !asSteer && !driver.capabilities.concurrentSubmit) return;
      if (this.ledger.outboundPressure(sessionId).over) return; // the outbox scheduler pumps when it drains
      const wait = actor.holdUntil - this.#now();
      if (wait > 0) { this.#holdPump(actor, wait); return; }
      if (driver.prepare && !asSteer) {
        // The gate wait is pre-emptible: a steer accepted meanwhile aborts it
        // and the loop re-plans with the steer at the head.
        const pre = new AbortController();
        actor.prepareAbort = pre;
        const onRetire = () => pre.abort();
        actor.abort.signal.addEventListener("abort", onRetire, { once: true });
        let r: "ready" | "cancelled" | "retired";
        try { r = await driver.prepare(this.#view(head), pre.signal); }
        catch (e) { this.#log(`${sessionId}: driver.prepare threw: ${e instanceof Error ? e.message : e}`); actor.holdUntil = this.#now() + this.#o.persistRetryMs; continue; }
        finally { actor.abort.signal.removeEventListener("abort", onRetire); if (actor.prepareAbort === pre) actor.prepareAbort = null; }
        if (actor.retired) return;
        if (r === "retired") continue; // pre-empted: re-plan
        if (r === "cancelled") continue; // the row is settled (cancelled / gone); the loop takes the next head
        // The gate wait is unbounded and the queue is editable meanwhile: the
        // head may have been reordered behind another row, cancelled, or
        // edited (its payload version advanced). Re-plan from the ledger
        // rather than submit the row — or the text — the wait began with
        // (Astra on e8f8b2cc); the head that is still current is dispatched.
        const fresh = this.#queueHead(sessionId);
        if (!fresh || fresh.id !== head.id || fresh.payloadVersion !== head.payloadVersion) continue;
      }
      await this.#dispatch(actor, head.id, asSteer);
    }
  }
  /** The row the pump would dispatch next: a steer first, else the FIFO head. */
  #queueHead(sessionId: string): CommandRow | null {
    const pending = this.ledger.listPending(sessionId);
    return pending.find((r) => r.state === "queued" && r.origin === "steer") ?? pending.find((r) => r.state === "queued") ?? null;
  }
  #holdPump(actor: Actor, ms: number): void {
    actor.holdTimer?.();
    actor.holdTimer = this.#schedule(() => { actor.holdTimer = null; this.#pump(actor.sessionId); }, ms);
  }

  #view(r: CommandRow): CommandView {
    return { id: r.id, sessionId: r.sessionId, text: r.text, origin: r.origin, source: r.source, seq: r.seq, relayTurnId: r.relayTurnId, relayCommandId: r.relayCommandId, visible: r.visible, mirrorToRelay: r.mirrorToRelay, payloadVersion: r.payloadVersion, createdAt: r.createdAt };
  }
  #ref(a: AttemptRow, token: string | null = null): AttemptRef {
    return { attemptId: a.id, commandId: a.commandId, attemptNo: a.attemptNo, runtimeRef: a.runtimeRef ?? a.commandId, token: token ?? "", runtimeTurnId: a.runtimeTurnId };
  }
  /** The runtime ref a submission carries: the command id itself first, a
   *  fresh id per resend so two submissions — and their echoes — stay
   *  distinguishable (campaign decision, 2026-09-06). */
  static runtimeRef(commandId: string, attemptNo: number): string { return attemptNo <= 1 ? commandId : `${commandId}#a${attemptNo}`; }

  async #dispatch(actor: Actor, commandId: string, asSteer: boolean): Promise<void> {
    const { sessionId, driver } = actor;
    let attempt: AttemptRow;
    const token = randomUUID();
    // The row is read HERE, in the same synchronous span as the attempt
    // commit: the text the driver receives and the payload version the
    // attempt records are one and the same (no await separates them).
    const cmd = this.ledger.getCommand(commandId);
    if (!cmd || cmd.state !== "queued") return;
    try {
      const attemptNo = this.ledger.attemptsForCommand(cmd.id).length + 1;
      const ref = driver.runtimeRef ? driver.runtimeRef(this.#view(cmd), attemptNo) : SessionCoordinator.runtimeRef(cmd.id, attemptNo);
      attempt = this.ledger.recordAttempt(cmd.id, actor.generation, ref, token);
    } catch (e) {
      if (e instanceof StaleGenerationError) { this.#log(`${sessionId}: generation ${actor.generation} is no longer current — pump stopped`); actor.retired = true; return; }
      if (e instanceof StaleCommandError) { this.#emitCommand(cmd.id); return; } // cancelled before dispatch (R9): the loop takes the next head
      // The ledger refused the commit — sending now would let a crash before
      // the echo resend a prompt the runtime accepted. Never send; retry the
      // commit, not the send (#514).
      this.#log(`${sessionId}: could not commit the attempt for ${cmd.id} (${e instanceof Error ? e.message : e}) — holding the send`);
      actor.holdUntil = this.#now() + this.#o.persistRetryMs;
      this.#holdPump(actor, this.#o.persistRetryMs);
      return;
    }
    this.#emitCommand(cmd.id);
    const ref = this.#ref(attempt, token);
    const view = this.#view(cmd);
    if (attempt.payloadVersion !== view.payloadVersion) {
      // Cannot happen (same synchronous span) — but a driver must never be
      // handed a text the committed attempt does not vouch for.
      this.#log(`${sessionId}: attempt ${attempt.id} records payload v${attempt.payloadVersion} but the row is v${view.payloadVersion} — not sending`);
      try { this.ledger.settleAttempt(attempt.id, "rejected", { detail: "payload_version_mismatch", command: { to: "queued" }, generation: actor.generation }); } catch { /* the pump re-plans */ }
      this.#emitCommand(cmd.id);
      return;
    }
    let result: SubmitResult;
    try {
      result = await (asSteer ? driver.steer!(view, ref, actor.abort.signal) : driver.submit(view, ref, actor.abort.signal));
    } catch (e) {
      // A driver that throws could not tell whether the prompt landed.
      result = { kind: "unknown", detail: `submit threw: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200) };
    }
    this.#applySubmit(actor, cmd.id, ref, result);
  }

  /** Apply a submit result only if the op token and the generation still
   *  own the row; a stale result is an orphan — logged, and interrupted when
   *  it accepted a turn nobody is tracking. */
  #applySubmit(actor: Actor, commandId: string, ref: AttemptRef, result: SubmitResult): void {
    let followUp: "interrupt" | "pump" | "hold" | null = null;
    let holdMs = 0;
    let orphanAccepted = false;
    try {
      this.ledger.tx(() => {
        const row = this.ledger.getCommand(commandId);
        const gen = this.ledger.currentGeneration(actor.sessionId);
        const owns = !!row && row.activeOp === ref.token && !!gen && gen.open && gen.generation === actor.generation && !actor.retired;
        if (!owns) {
          // The row moved on without us. An attempt the runtime's own
          // evidence already settled (the echo / turn end beat the response
          // and completed the command) is a late result, nothing more. One
          // still unsettled is an orphan (a cancel confirmed by a generation
          // close, a restart): record what the runtime said, apply nothing —
          // and interrupt the turn it accepted, which nobody tracks.
          const a = this.ledger.getAttempt(ref.attemptId);
          const unsettled = !!a && (a.state === "submitting" || a.state === "unknown");
          orphanAccepted = result.kind === "accepted" && unsettled;
          if (a && a.state === "submitting") this.ledger.settleAttempt(ref.attemptId, result.kind === "accepted" ? "accepted" : result.kind === "unknown" ? "unknown" : "rejected", { runtimeTurnId: result.kind === "accepted" ? result.runtimeTurnId ?? undefined : undefined, detail: "orphaned: the op no longer owns the row", command: null , generation: actor.generation });
          return;
        }
        if (result.kind === "accepted") {
          const a = this.ledger.getAttempt(ref.attemptId);
          // An echo that beat the response already settled the attempt as
          // done: the response only binds the turn id (R18).
          if (a?.state === "submitting") this.ledger.settleAttempt(ref.attemptId, "accepted", { runtimeTurnId: result.runtimeTurnId ?? undefined, command: null, generation: actor.generation });
          else if (result.runtimeTurnId && a && a.runtimeTurnId !== result.runtimeTurnId) this.ledger.setAttemptTurn(ref.attemptId, result.runtimeTurnId);
          const t = nextState(row!.state, { type: "submit_accepted" });
          if (t) this.ledger.transition(commandId, [row!.state], t.to, { terminalReason: t.terminalReason, generation: actor.generation, expectedAttemptId: ref.attemptId });
          const after = this.ledger.getCommand(commandId)!;
          if (after.state === "cancelling") followUp = "interrupt";
          // R18: the runtime already reported this turn while the response
          // was in flight — apply what it said now.
          if (result.runtimeTurnId) this.#applyBackloggedTurn(actor, after, ref.attemptId, result.runtimeTurnId);
          if (actor.foreignTurn && result.runtimeTurnId && actor.foreignTurn.runtimeTurnId === result.runtimeTurnId) actor.foreignTurn = null;
        } else if (result.kind === "unknown") {
          this.ledger.settleAttempt(ref.attemptId, "unknown", { detail: result.detail.slice(0, 200), command: null, generation: actor.generation });
          const t = nextState(row!.state, { type: "submit_unknown" });
          if (t) this.ledger.transition(commandId, [row!.state], t.to, { terminalReason: t.terminalReason, generation: actor.generation, expectedAttemptId: ref.attemptId });
          if (this.ledger.getCommand(commandId)?.state === "cancelling") followUp = "interrupt";
        } else {
          const detail = (result.busy ? `busy:${result.detail}` : result.detail).slice(0, 200);
          this.ledger.settleAttempt(ref.attemptId, "rejected", { detail, command: null, generation: actor.generation });
          const transient = this.ledger.attemptsForCommand(commandId).filter((a) => a.state === "rejected" && !(a.detail ?? "").startsWith("busy:")).length;
          const permanent = result.permanent || transient >= this.#o.maxTransientRejections;
          const t = nextState(row!.state, { type: "submit_rejected", permanent })!;
          this.ledger.transition(commandId, [row!.state], t.to, { terminalReason: t.to === "failed" ? detail : t.terminalReason, generation: actor.generation, expectedAttemptId: ref.attemptId });
          if (t.to === "queued") {
            // A busy refusal is retried when the runtime goes idle (turn_ended,
            // idle, resume lift the hold) or after a plain backoff — never in a
            // hot loop; a real refusal backs off per transient try.
            followUp = "hold";
            holdMs = result.retryAfterMs ?? (result.busy ? this.#o.rejectionBackoffMs : this.#o.rejectionBackoffMs * transient);
          }
        }
      }, "submit");
    } catch (e) {
      this.#log(`${actor.sessionId}: could not commit the submit result for ${commandId}: ${e instanceof Error ? e.message : e}`);
    }
    if (orphanAccepted) {
      this.#log(`${actor.sessionId}: submit for ${commandId} completed after the op lost the row — interrupting the orphan turn`);
      void actor.driver.interrupt({ attempt: { ...ref, runtimeTurnId: result.kind === "accepted" ? result.runtimeTurnId ?? null : null } }).catch(() => {});
    }
    this.#emitCommand(commandId);
    if (followUp === "interrupt") this.#scheduleInterrupt(actor, commandId, 0);
    if (followUp === "hold") { actor.holdUntil = this.#now() + holdMs; }
    this.#pump(actor.sessionId);
  }

  /** A turn_ended (or turn_started) the driver reported for `turnId` before
   *  the submit response named it: it is this attempt's (#512/#513). */
  #applyBackloggedTurn(actor: Actor, row: CommandRow, attemptId: string, turnId: string): void {
    const obs = this.ledger.listObservations(actor.sessionId).filter((o) => o.generation === actor.generation && o.attemptId == null && (o.payload as { runtimeTurnId?: string } | null)?.runtimeTurnId === turnId);
    if (!obs.length) return;
    const started = obs.some((o) => o.kind === "turn_started");
    const endedObs = obs.filter((o) => o.kind === "turn_ended").pop();
    if (started && !endedObs) {
      const t = nextState(row.state, { type: "evidence" });
      if (t) this.ledger.transition(row.id, [row.state], t.to, { generation: actor.generation, expectedAttemptId: attemptId });
    }
    if (endedObs) {
      const status = ((endedObs.payload as { status?: TurnStatus } | null)?.status ?? "completed");
      const cur = this.ledger.getCommand(row.id)!;
      const t = nextState(cur.state, { type: "turn_ended", status });
      if (t) this.ledger.recordObservation({ sessionId: actor.sessionId, generation: actor.generation, attemptId, kind: "turn_ended", ref: turnId, payload: { status, runtimeTurnId: turnId, backlogged: true } }, {
        command: { id: row.id, from: [cur.state], to: t.to, terminalReason: t.terminalReason },
        attempt: { id: attemptId, outcome: t.to === "completed" ? "done" : "superseded" },
      });
    }
  }

  // ── cancellation: interrupt until confirmed or unresolved (R10) ──
  #scheduleInterrupt(actor: Actor, commandId: string, ms: number): void {
    actor.cancelTimers.get(commandId)?.();
    actor.cancelTimers.set(commandId, this.#schedule(() => { actor.cancelTimers.delete(commandId); void this.#interruptOp(actor, commandId); }, ms));
  }

  /** Is the row still the scheduler's to interrupt: `cancelling`, or a
   *  cancelled tombstone whose late turn is not yet known to be over? */
  #interruptLive(actor: Actor, commandId: string): boolean {
    const r = this.ledger.getCommand(commandId);
    return !!r && (r.state === "cancelling" || (r.state === "cancelled" && actor.tombstones.has(commandId)));
  }

  /** THE interrupt path — for a `cancelling` row and for a cancelled
   *  tombstone alike (Astra on e8f8b2cc: a bare driver.interrupt for late
   *  evidence bypassed every fence below). Serialized per command, fenced
   *  against collateral for session-wide interrupts, bounded by the cancel
   *  budget. */
  async #interruptOp(actor: Actor, commandId: string): Promise<InterruptResult | null> {
    if (actor.retired) return null;
    const row = this.ledger.getCommand(commandId);
    if (!row) return null;
    const tombstone = row.state === "cancelled" ? actor.tombstones.get(commandId) ?? null : null;
    if (row.state !== "cancelling" && !tombstone) return null;
    const attempt = tombstone ? this.ledger.getAttempt(tombstone) : this.ledger.latestAttempt(commandId);
    // The submit is still in flight: its completion consults the cancel flag
    // and schedules the interrupt with the turn identity it learns (#35).
    if (attempt?.state === "submitting") return null;
    // One interrupt op per command at a time: a second trigger (another late
    // echo, a re-fired cancel) rides the verdict of the one in flight, which
    // schedules the retry.
    if (actor.cancelOps.has(commandId)) return null;
    // A session-wide interrupt (opencode, pi, claude's Escape) would also
    // stop commands nobody cancelled: refuse it while such work runs — the
    // cancel keeps retrying and is surfaced as unresolved rather than
    // stopping the wrong turn (Astra on af76c787, #77). A second session-wide
    // op in flight already covers this one: wait for its verdict instead of
    // doubling it.
    if (!actor.driver.capabilities.targetedInterrupt) {
      if (actor.sessionInterrupt) { await actor.sessionInterrupt; if (!this.#interruptLive(actor, commandId) || actor.cancelOps.has(commandId)) return null; }
      const collateral = this.ledger.listPending(actor.sessionId).filter((r) => (r.state === "running" || r.state === "accepted") && r.id !== commandId);
      if (collateral.length) {
        // Not an interrupt attempt (the budget is untouched): the cancel
        // stays pending and resolves with the turn's own end, or once the
        // other work is cancelled too (abortRunning).
        this.#scheduleInterrupt(actor, commandId, Math.min(30_000, this.#o.interruptConfirmMs * 4));
        return { kind: "failed", error: `a session-wide interrupt would also stop ${collateral.map((c) => c.id).join(", ")}` };
      }
    }
    const tries = this.ledger.noteCancelAttempt(commandId);
    if (tries > this.#o.maxCancelAttempts) { actor.tombstones.delete(commandId); this.#markUnresolved(actor, commandId, attempt?.id ?? null, tries - 1); return { kind: "failed", error: "unresolved" }; }
    const token = randomUUID();
    actor.cancelOps.set(commandId, token);
    const call = (async (): Promise<InterruptResult> => {
      try { return await actor.driver.interrupt({ attempt: attempt ? this.#ref(attempt) : null }); }
      catch (e) { return { kind: "failed", error: e instanceof Error ? e.message : String(e) }; }
    })();
    if (!actor.driver.capabilities.targetedInterrupt) actor.sessionInterrupt = call.then(() => {}, () => {}).finally(() => { actor.sessionInterrupt = null; });
    const r = await call;
    if (actor.retired || actor.cancelOps.get(commandId) !== token) return r;
    actor.cancelOps.delete(commandId);
    if (!this.#interruptLive(actor, commandId)) return r; // confirmed meanwhile by an observation
    if (tombstone && r.kind === "noop") {
      // Nothing is running: the late turn is over (or never was). The
      // tombstone is spent; the row was cancelled all along.
      this.#dropTombstone(actor, commandId);
      this.#recordFree(actor, "interrupt", commandId, { result: "noop", tombstone: true });
      this.#pump(actor.sessionId);
      return r;
    }
    if (r.kind === "noop" && (!attempt || attempt.state === "rejected" || attempt.state === "superseded" || attempt.runtimeTurnId == null && attempt.state !== "accepted" && attempt.state !== "done")) {
      // Nothing is running and nothing is known to have landed: the cancel
      // holds. Should the submission surface later, its evidence meets a
      // cancelled row and is interrupted then (the tombstone rule).
      const t = nextState("cancelling", { type: "interrupt_confirmed" })!;
      try {
        this.ledger.recordObservation({ sessionId: actor.sessionId, generation: actor.generation, attemptId: attempt?.id ?? null, kind: "interrupt", ref: commandId, payload: { result: "noop" } }, {
          command: { id: commandId, from: ["cancelling"], to: t.to, terminalReason: t.terminalReason },
        });
      } catch (e) { this.#log(`${actor.sessionId}: cancel commit for ${commandId} failed: ${e instanceof Error ? e.message : e}`); }
      this.#emitCommand(commandId);
      this.#pump(actor.sessionId);
      return r;
    }
    // sent (await the runtime's confirmation), failed, or a noop against a
    // turn we know landed: try again after a backoff.
    const backoff = Math.min(30_000, this.#o.cancelBackoffMs * Math.pow(2, Math.max(0, tries - 1)));
    this.#scheduleInterrupt(actor, commandId, r.kind === "sent" ? Math.max(backoff, this.#o.interruptConfirmMs) : backoff);
    if (r.kind === "failed") this.#log(`${actor.sessionId}: interrupt for ${commandId} failed (${r.error ?? "?"}) — retry ${tries}/${this.#o.maxCancelAttempts} in ${backoff}ms`);
    return r;
  }

  #markUnresolved(actor: Actor, commandId: string, attemptId: string | null, tries: number): void {
    if (actor.unresolved.has(commandId)) return;
    actor.unresolved.add(commandId);
    try { this.ledger.recordObservation({ sessionId: actor.sessionId, generation: actor.generation, attemptId, kind: "cancel_unresolved", ref: commandId, payload: { tries } }); } catch { /* informational */ }
    this.#log(`${actor.sessionId}: cancel of ${commandId} unresolved after ${tries} interrupt attempts — the runtime never confirmed`);
    this.#emit({ type: "cancel_unresolved", sessionId: actor.sessionId, commandId });
    this.#emit({ type: "session", sessionId: actor.sessionId });
  }

  // ── observations ──
  #observe(actor: Actor, o: Observation): void {
    if (actor.retired) return;
    try { this.#observeInner(actor, o); }
    catch (e) { this.#log(`${actor.sessionId}: observation ${o.kind} failed: ${e instanceof Error ? e.message : e}`); }
  }

  #observeInner(actor: Actor, o: Observation): void {
    const sid = actor.sessionId;
    switch (o.kind) {
      case "ready": {
        actor.ready = true;
        void this.#reconcile(actor).finally(() => this.#pump(sid));
        return;
      }
      case "echo": {
        const attempt = this.ledger.matchAttemptByRef(sid, o.runtimeRef) ?? this.ledger.attemptByRef(sid, o.runtimeRef);
        if (!attempt) { this.#recordFree(actor, "echo", o.runtimeRef, { runtimeTurnId: o.runtimeTurnId ?? null }); return; }
        const cmd = this.ledger.getCommand(attempt.commandId);
        const owns = !!cmd && this.#ownsCommand(cmd, attempt);
        const receipts: NewReceipt[] = [];
        if (o.receiptKind) receipts.push({ kind: o.receiptKind, ref: o.runtimeRef, commandId: attempt.commandId, attemptId: attempt.id });
        if (cmd?.seq != null) receipts.push({ kind: "seq", ref: String(cmd.seq), commandId: attempt.commandId, attemptId: attempt.id });
        const t = cmd && owns ? nextState(cmd.state, { type: "evidence" }) : null;
        if (cmd && !owns) this.#logLateEvidence(sid, "echo", cmd, attempt);
        this.ledger.recordObservation({ sessionId: sid, generation: actor.generation, attemptId: attempt.id, kind: "echo", ref: o.runtimeRef, payload: { runtimeTurnId: o.runtimeTurnId ?? null, ...(owns ? {} : { late: true }) } }, {
          receipts,
          ...(attempt.state === "submitting" || attempt.state === "accepted" || attempt.state === "unknown" ? { attempt: { id: attempt.id, outcome: "done", runtimeTurnId: o.runtimeTurnId ?? undefined } } : {}),
          ...(t && cmd ? { command: { id: cmd.id, from: [cmd.state], to: t.to, terminalReason: t.terminalReason, expectedAttemptId: attempt.id } } : {}),
        });
        if (o.runtimeTurnId && attempt.runtimeTurnId !== o.runtimeTurnId) this.ledger.setAttemptTurn(attempt.id, o.runtimeTurnId);
        if (actor.foreignTurn && (o.runtimeTurnId == null || actor.foreignTurn.runtimeTurnId === o.runtimeTurnId)) actor.foreignTurn = null;
        const after = cmd ? this.#emitCommand(cmd.id) : null;
        if (after) this.#afterEvidence(actor, after, attempt.id);
        this.#pump(sid);
        return;
      }
      case "turn_started": {
        const attempt = (o.runtimeRef ? this.ledger.matchAttemptByRef(sid, o.runtimeRef) ?? this.ledger.attemptByRef(sid, o.runtimeRef) : null)
          ?? (o.runtimeTurnId ? this.ledger.attemptByRuntimeTurnId(sid, o.runtimeTurnId) : null);
        if (!attempt) {
          // Foreign: started at the terminal, or ours before the response
          // named it (then the response claims it, R18). Own provenance,
          // never a confirmation (#78 #32).
          actor.foreignTurn = { runtimeTurnId: o.runtimeTurnId ?? null, since: this.#now() };
          this.#recordFree(actor, "turn_started", o.runtimeTurnId ?? null, { runtimeTurnId: o.runtimeTurnId ?? null });
          this.#emit({ type: "foreign_turn", sessionId: sid, runtimeTurnId: o.runtimeTurnId ?? null, phase: "started" });
          this.#emit({ type: "session", sessionId: sid });
          return;
        }
        const cmd = this.ledger.getCommand(attempt.commandId);
        const owns = !!cmd && this.#ownsCommand(cmd, attempt);
        const t = cmd && owns ? nextState(cmd.state, { type: "evidence" }) : null;
        if (cmd && !owns) this.#logLateEvidence(sid, "turn_started", cmd, attempt);
        this.ledger.recordObservation({ sessionId: sid, generation: actor.generation, attemptId: attempt.id, kind: "turn_started", ref: o.runtimeTurnId ?? null, payload: { runtimeTurnId: o.runtimeTurnId ?? null, ...(owns ? {} : { late: true }) } }, {
          ...(t && cmd ? { command: { id: cmd.id, from: [cmd.state], to: t.to, terminalReason: t.terminalReason, expectedAttemptId: attempt.id } } : {}),
        });
        if (o.runtimeTurnId && attempt.runtimeTurnId !== o.runtimeTurnId) this.ledger.setAttemptTurn(attempt.id, o.runtimeTurnId);
        const after = cmd ? this.#emitCommand(cmd.id) : null;
        if (after) this.#afterEvidence(actor, after, attempt.id);
        return;
      }
      case "turn_ended": {
        // Every command that rode this turn ends with it: a steered message
        // shares the running turn (opencode, pi), and an id-less runtime's
        // "the run ended" applies to everything executing.
        const attempts = o.runtimeTurnId ? this.ledger.attemptsByRuntimeTurnId(sid, o.runtimeTurnId)
          : o.runtimeRef ? [this.ledger.attemptByRef(sid, o.runtimeRef)].filter((a): a is AttemptRow => !!a)
          : this.#executingAttempts(sid);
        if (o.runtimeTurnId == null && o.runtimeRef == null) this.#dropAllTombstones(actor); // "the run ended": no late turn is left to interrupt
        else for (const a of attempts) if (actor.tombstones.get(a.commandId) === a.id) this.#dropTombstone(actor, a.commandId);
        if (!attempts.length) {
          if (actor.foreignTurn && (o.runtimeTurnId == null || actor.foreignTurn.runtimeTurnId === o.runtimeTurnId || actor.foreignTurn.runtimeTurnId == null)) actor.foreignTurn = null;
          this.#recordFree(actor, "turn_ended", o.runtimeTurnId ?? null, { runtimeTurnId: o.runtimeTurnId ?? null, status: o.status });
          this.#emit({ type: "foreign_turn", sessionId: sid, runtimeTurnId: o.runtimeTurnId ?? null, phase: "ended" });
          this.#emit({ type: "session", sessionId: sid });
          actor.holdUntil = 0;
          this.#pump(sid);
          return;
        }
        for (const attempt of attempts) {
          const cmd = this.ledger.getCommand(attempt.commandId);
          const owns = !!cmd && this.#ownsCommand(cmd, attempt);
          const t = cmd && owns ? nextState(cmd.state, { type: "turn_ended", status: o.status }) : null;
          if (cmd && !owns) this.#logLateEvidence(sid, "turn_ended", cmd, attempt);
          this.ledger.recordObservation({ sessionId: sid, generation: actor.generation, attemptId: attempt.id, kind: "turn_ended", ref: o.runtimeTurnId ?? null, payload: { runtimeTurnId: o.runtimeTurnId ?? null, status: o.status, detail: o.detail ?? null, ...(owns ? {} : { late: true }) } }, {
            ...(t && cmd ? { command: { id: cmd.id, from: [cmd.state], to: t.to, terminalReason: t.terminalReason, expectedAttemptId: attempt.id }, attempt: { id: attempt.id, outcome: t.to === "completed" ? "done" : "superseded" } }
              // An older attempt's turn ended: settled on ITS row (the ledger's
              // stale rule keeps it history), the command untouched.
              : cmd && !owns ? { attempt: { id: attempt.id, outcome: o.status === "completed" ? "done" : "superseded" } } : {}),
          });
          if (cmd) {
            if (owns) { actor.unresolved.delete(cmd.id); actor.cancelTimers.get(cmd.id)?.(); actor.cancelTimers.delete(cmd.id); }
            this.#emitCommand(cmd.id);
          }
        }
        if (actor.foreignTurn && (o.runtimeTurnId == null || actor.foreignTurn.runtimeTurnId === o.runtimeTurnId)) actor.foreignTurn = null;
        actor.holdUntil = 0; // the runtime is free again: a busy-refused head may go now
        this.#pump(sid);
        return;
      }
      case "idle": {
        actor.foreignTurn = null;
        actor.holdUntil = 0;
        this.#dropAllTombstones(actor);
        for (const row of this.ledger.listPending(sid)) {
          const t = nextState(row.state, { type: "idle" });
          if (!t) continue;
          const attempt = this.ledger.latestAttempt(row.id);
          this.ledger.recordObservation({ sessionId: sid, generation: actor.generation, attemptId: attempt?.id ?? null, kind: "idle", ref: row.id }, {
            command: { id: row.id, from: [row.state], to: t.to, terminalReason: t.terminalReason },
          });
          actor.unresolved.delete(row.id); actor.cancelTimers.get(row.id)?.(); actor.cancelTimers.delete(row.id);
          this.#emitCommand(row.id);
        }
        this.#emit({ type: "session", sessionId: sid });
        this.#pump(sid);
        return;
      }
      case "interrupted": {
        const attempt = (o.runtimeTurnId ? this.ledger.attemptByRuntimeTurnId(sid, o.runtimeTurnId) : null) ?? this.#soleExecutingAttempt(sid);
        const cmd = attempt ? this.ledger.getCommand(attempt.commandId) : null;
        if (o.runtimeTurnId == null) this.#dropAllTombstones(actor); // a session-wide interrupt landed: whatever ran is over
        else if (attempt && actor.tombstones.get(attempt.commandId) === attempt.id) this.#dropTombstone(actor, attempt.commandId);
        if (!cmd) { actor.foreignTurn = null; this.#recordFree(actor, "interrupted", o.runtimeTurnId ?? null, {}); this.#emit({ type: "session", sessionId: sid }); this.#pump(sid); return; }
        const owns = this.#ownsCommand(cmd, attempt!);
        const t = owns ? nextState(cmd.state, cmd.state === "cancelling" ? { type: "interrupt_confirmed" } : { type: "turn_ended", status: "interrupted" }) : null;
        if (!owns) this.#logLateEvidence(sid, "interrupted", cmd, attempt!);
        this.ledger.recordObservation({ sessionId: sid, generation: actor.generation, attemptId: attempt!.id, kind: "interrupted", ref: o.runtimeTurnId ?? null, payload: owns ? undefined : { late: true } }, {
          ...(t ? { command: { id: cmd.id, from: [cmd.state], to: t.to, terminalReason: t.terminalReason, expectedAttemptId: attempt!.id }, attempt: { id: attempt!.id, outcome: "superseded" } }
            : !owns ? { attempt: { id: attempt!.id, outcome: "superseded" } } : {}),
        });
        if (owns) { actor.unresolved.delete(cmd.id); actor.cancelTimers.get(cmd.id)?.(); actor.cancelTimers.delete(cmd.id); }
        this.#emitCommand(cmd.id);
        this.#pump(sid);
        return;
      }
      case "process_exited": {
        actor.ready = false;
        this.#recordFree(actor, "process_exited", null, { reason: o.reason ?? null });
        return;
      }
      case "draft_preserved": {
        actor.drafts.push(o.text);
        this.#recordFree(actor, "draft_preserved", null, { chars: o.text.length });
        this.#emit({ type: "session", sessionId: sid });
        return;
      }
      case "checkpoint": {
        this.ledger.setCheckpoint(sid, o.checkpointKind, o.ref, o.offset, { throughSeq: "latest", generation: actor.generation });
        return;
      }
      case "paused": { actor.paused = true; actor.pauseReason = o.reason; this.#emit({ type: "session", sessionId: sid }); return; }
      case "resumed": { actor.paused = false; actor.pauseReason = undefined; this.#emit({ type: "session", sessionId: sid }); this.#pump(sid); return; }
    }
  }

  /** Evidence for a command that is cancelled/cancelling: the runtime
   *  is running something we asked to stop — interrupt it now that its
   *  identity is known (the tombstone rule, #66). */
  #afterEvidence(actor: Actor, row: CommandRow, attemptId: string): void {
    if (row.state === "cancelling") { this.#scheduleInterrupt(actor, row.id, 0); return; }
    if (row.state !== "cancelled") return;
    const a = this.ledger.getAttempt(attemptId);
    if (!a) return;
    // Already the scheduler's (a second echo of the same late turn): the op
    // in flight, or the deferred retry, covers it — never a second call.
    if (actor.tombstones.has(row.id)) return;
    actor.tombstones.set(row.id, a.id);
    this.#log(`${actor.sessionId}: ${row.id} was cancelled — its late turn ${a.runtimeTurnId ?? "(unnamed)"} goes to the interrupt scheduler`);
    void this.#interruptOp(actor, row.id);
  }
  #dropTombstone(actor: Actor, commandId: string): void {
    if (!actor.tombstones.delete(commandId)) return;
    actor.cancelTimers.get(commandId)?.(); actor.cancelTimers.delete(commandId);
    actor.cancelOps.delete(commandId); // a verdict still in flight is stale: the runtime spoke
  }
  /** The runtime reported an id-less end / idle: every tombstoned turn is over. */
  #dropAllTombstones(actor: Actor): void {
    for (const id of [...actor.tombstones.keys()]) this.#dropTombstone(actor, id);
  }

  /** The current-owner rule for an observation's COMMAND effect (Astra on
   *  e8f8b2cc): the attempt it names must be the command's newest AND made
   *  for the command's current payload. Late evidence of an older attempt —
   *  a timed-out submission that landed after all, the row since edited
   *  and re-submitted — is history on that attempt (the ledger's stale
   *  rule keeps it) and never advances the newer payload or attempt. */
  #ownsCommand(cmd: CommandRow, attempt: AttemptRow): boolean {
    const latest = this.ledger.latestAttempt(cmd.id);
    return !!latest && latest.id === attempt.id && attempt.payloadVersion === cmd.payloadVersion;
  }
  #logLateEvidence(sid: string, kind: string, cmd: CommandRow, attempt: AttemptRow): void {
    this.#log(`${sid}: late ${kind} for attempt ${attempt.attemptNo} of ${cmd.id} (payload v${attempt.payloadVersion}, row v${cmd.payloadVersion}) — recorded on that attempt; the command stays ${cmd.state}`);
  }

  /** The latest attempt of every command executing (accepted | running |
   *  cancelling) — what an id-less turn signal applies to. */
  #executingAttempts(sessionId: string): AttemptRow[] {
    return this.ledger.listPending(sessionId)
      .filter((r) => r.state === "running" || r.state === "cancelling" || r.state === "accepted")
      .map((r) => this.ledger.latestAttempt(r.id))
      .filter((a): a is AttemptRow => !!a);
  }
  #soleExecutingAttempt(sessionId: string): AttemptRow | null {
    const all = this.#executingAttempts(sessionId);
    return all.length === 1 ? all[0] : null;
  }

  #recordFree(actor: Actor, kind: string, ref: string | null, payload: unknown): void {
    try { this.ledger.recordObservation({ sessionId: actor.sessionId, generation: actor.generation, kind, ref, payload }); }
    catch (e) { this.#log(`${actor.sessionId}: could not record ${kind}: ${e instanceof Error ? e.message : e}`); }
  }

  // ── reconcile after a restart ──
  async #reconcile(actor: Actor): Promise<void> {
    if (actor.reconciling) return;
    actor.reconciling = true;
    try {
      const unknownRows = this.ledger.listPending(actor.sessionId).filter((r) => r.state === "unknown");
      if (!unknownRows.length) return;
      const refs: AttemptRef[] = [];
      for (const r of unknownRows) { const a = this.ledger.latestAttempt(r.id); if (a) refs.push(this.#ref(a)); }
      let outcomes: ReconcileOutcome[] = [];
      try { outcomes = refs.length ? await actor.driver.reconcile(refs) : []; }
      catch (e) { this.#log(`${actor.sessionId}: reconcile failed (${e instanceof Error ? e.message : e}) — ${refs.length} attempt(s) stay unknown`); return; }
      if (actor.retired) return;
      for (const r of unknownRows) {
        const a = this.ledger.latestAttempt(r.id);
        const out = outcomes.find((x) => x.attemptId === a?.id) ?? { attemptId: a?.id ?? "", outcome: a ? "unknown" as const : "absent" as const };
        const cur = this.ledger.getCommand(r.id);
        if (!cur || cur.state !== "unknown") continue;
        const t = nextState("unknown", { type: "reconcile", outcome: out.outcome })!;
        if (t.to === "unknown") continue;
        try {
          this.ledger.recordObservation({ sessionId: actor.sessionId, generation: actor.generation, attemptId: a?.id ?? null, kind: "reconcile", ref: r.id, payload: { outcome: out.outcome, runtimeTurnId: out.runtimeTurnId ?? null } }, {
            command: { id: r.id, from: ["unknown"], to: t.to, terminalReason: t.terminalReason },
            ...(a ? { attempt: { id: a.id, outcome: out.outcome === "absent" ? "superseded" : "accepted", runtimeTurnId: out.runtimeTurnId ?? undefined } } : {}),
          });
        } catch (e) { this.#log(`${actor.sessionId}: reconcile commit for ${r.id} failed: ${e instanceof Error ? e.message : e}`); }
        this.#emitCommand(r.id);
      }
    } finally {
      actor.reconciling = false;
    }
  }
}

// ── process-wide handle ──────────────────────────────────────────────────────

const open = new Map<Ledger, SessionCoordinator>();
/** The coordinator over a ledger — one per ledger per process. */
export function coordinatorFor(ledger: Ledger = ledgerFor()): SessionCoordinator {
  let c = open.get(ledger);
  if (!c) { c = new SessionCoordinator({ ledger }); open.set(ledger, c); }
  return c;
}
/** Tests: forget every cached coordinator. */
export function resetCoordinators(): void { open.clear(); }

export { LedgerWriteError, SessionEndedError, StaleCommandError, StaleGenerationError };
export type { CommandState, CommandRow, AttemptRow };
