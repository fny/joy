// The daemon's side of one relay turn, as an explicit machine.
//
// Wire phases (relay/nucleusLane.ts header): offer → received → submitted →
// /start → output facts → terminal. The daemon's OWN picture of where a
// turn is used to live in five places at once — the ledger's CommandState,
// the `activeTurns` entry ({started, adoptionPending, adoptionAnswer,
// adoptionEpoch, wake}), the `inFlight` set, and driveTurn's locals
// (startPosted, adoptionPending, cancelClosed, stalled) — and its answers to
// the relay's refusals were spread over three catch blocks that did not
// always agree. This module is that picture in one place: a pure
// `nextTurnState(state, event)` total switch (the coordinator's pattern,
// domain/coordinator.ts), exhaustively tabled in relayTurnMachine.test.ts.
// nucleusLane.ts keeps its control flow, but every decision it used to take
// off a flag it now takes off this state, and every flag it used to set is
// an event here.
//
// Phases:
//   offered           the claim's offer is in hand; /received in flight
//   received          acknowledged; decoding / submitting
//   submitted         /submitted acknowledged; staging attachments, accepted
//                     into the coordinator, waiting for the delivery echo
//   handled           a joy-owned command (/title …): nothing to deliver —
//                     /start, then completed
//   running           delivery confirmed (the driver's echo). `startPosted`:
//                     /start acknowledged, or waived because the relay closed
//                     the turn elsewhere. `stage`: A = before the terminal
//                     wait, C = inside it — the two answer a /start refusal
//                     differently (kept exactly as the code did, see below).
//                     `refusals`: /start refusals seen in stage A.
//   cancelling        a cancel has been requested of the runtime (the relay
//                     said `cancelling`); the command's own terminal closes it
//   adoption_pending  the relay could not answer the turn's adoption
//                     (unavailable: 5xx, transport). The runtime keeps
//                     running; the slow retry asks again. NEVER a cancel.
//   terminal          the turn's terminal fact is (being) posted
//   dropped           nothing is posted: the delivery was not receivable,
//                     there is no local session, the session is gone, or
//                     the lease died — the relay's own sweep and the next
//                     claim/lease resolve it.
//
// Why `start_posted` is a flag and not a phase: whether /start was
// acknowledged is orthogonal to whether the turn is running, cancelling or
// parked — a resumed turn arrives with it already true.
//
// A /start refusal means ONE thing in every live phase (reconciled
// 2026-09-11; until then stage A — before the terminal wait — and stage C
// answered it differently, and stage A's rule was the older one):
//   - the cancel class (START_CANCEL_CLASS) stops the prompt: cancel
//     locally, unless a local cancel is already in progress (`cancelling`),
//     which is the same answer already being honoured — then the /start is
//     waived and the runtime's confirm closes the turn;
//   - any other 409 is a recovery question (not_queue_head,
//     another_turn_active, turn_orphaned_reconcile_first, no_current_
//     delivery): ask the relay to adopt the turn once; if it has nothing to
//     adopt, or refuses the start again, the /start is waived — the relay
//     has its answer and the outcome posts as the terminal fact (F28). A
//     working agent is never cancelled over an ordering or recovery answer;
//     only a cancel-class refusal or a cancel/refused adoption cancels it.
// `stage` is kept as information (where in the drive loop the turn is); it
// decides nothing.
//
// Adoption arbitration (F30/F31) is here too, as a pure mailbox: the orphan
// sweep and the turn's own loop can have reconciles in flight for the same
// turn; the first RESOLVED answer wins, except that a cancellation is
// monotone — applied by whichever side observes it, whenever, once.

export type TurnTerminal = "completed" | "failed" | "cancelled" | "interrupted";
export type Stage = "a" | "c";

/** The relay's answer to reconcile{running} — see nucleusLane.adoptRelayTurn. */
export type Adoption =
  | { kind: "running" } | { kind: "cancelling" } | { kind: "terminal"; terminalState: string }
  | { kind: "none"; detail?: string } | { kind: "refused"; code: string } | { kind: "unavailable"; detail: string };

export type TurnState =
  | { phase: "offered" }
  | { phase: "received" }
  | { phase: "submitted"; startPosted: boolean; resumed: boolean }
  | { phase: "handled" }
  | { phase: "running"; startPosted: boolean; stage: Stage; refusals: number; stalled: boolean }
  | { phase: "cancelling"; startPosted: boolean; stage: Stage; refusals: number; stalled: boolean }
  | { phase: "adoption_pending"; startPosted: boolean; cancelling: boolean; since: number; attempts: number; lastError: string; stalled: boolean }
  | { phase: "terminal"; state: TurnTerminal; reason: string | null }
  | { phase: "dropped"; code: string };
export type TurnPhase = TurnState["phase"];
export const TURN_PHASES: readonly TurnPhase[] = ["offered", "received", "submitted", "handled", "running", "cancelling", "adoption_pending", "terminal", "dropped"];

export type TurnEvent =
  | { type: "received_ok" }
  | { type: "received_refused"; status: number }
  | { type: "no_local_session" }
  | { type: "submitted_ok" }
  | { type: "submitted_refused"; code: string }
  | { type: "undecodable"; reason: string }
  | { type: "prepare_cancelled" }
  | { type: "prepare_failed"; reason: string }
  | { type: "handled_command" }
  | { type: "delivery_confirmed" }
  | { type: "delivery_timeout" }
  | { type: "command_lost" }
  | { type: "turn_ended"; status: TurnTerminal; reason: string | null }
  | { type: "start_ok" }
  | { type: "start_refused"; code: string }
  | { type: "adoption"; answer: Adoption; now: number }
  | { type: "terminal_wait" }
  | { type: "stalled" }
  | { type: "output_resumed" }
  | { type: "lane_error"; detail: string; commandLive: boolean }
  | { type: "lease_lost" }
  /** The coordinator holds a cancel request for the command (the control
   *  lane's, or the app's through the tunnel) — learned from the ledger. */
  | { type: "cancel_requested" };
export const TURN_EVENT_TYPES: ReadonlyArray<TurnEvent["type"]> = [
  "received_ok", "received_refused", "no_local_session", "submitted_ok", "submitted_refused", "undecodable", "prepare_cancelled",
  "prepare_failed", "handled_command", "delivery_confirmed", "delivery_timeout", "command_lost", "turn_ended", "start_ok",
  "start_refused", "adoption", "terminal_wait", "stalled", "output_resumed", "lane_error", "lease_lost", "cancel_requested",
];

/** What the wiring must DO alongside the state change. `cancel_locally`:
 *  cancel the command, abort the runtime, post `cancelled` (the terminal the
 *  transition names). `cancel_command`: the coordinator's durable cancel
 *  only — the runtime confirms and Phase C ends the turn. `adopt`: ask the
 *  relay to adopt the turn (reconcile{running}); its answer is the next
 *  `adoption` event. */
export type TurnEffect = "cancel_locally" | "cancel_command" | "adopt";
export interface TurnTransition { to: TurnState; effects?: TurnEffect[] }

/** /start refusals that MEAN "stop the prompt": a cancellation that beat the
 *  control offer here, a session closed under the turn (#614), a budget the
 *  relay failed the turn on (#613). Every other 409 is a recovery question
 *  the relay's reconcile answers — never a cancel. */
export const START_CANCEL_CLASS: ReadonlySet<string> = new Set(["turn_cancelled", "session_archived", "session_failed", "session_event_budget_exhausted"]);
/** /submitted refusals that mean the session is over: the relay resolved
 *  the queue itself; nothing is dispatched, nothing is posted. */
export const SESSION_GONE: ReadonlySet<string> = new Set(["session_archived", "session_failed"]);
/** The answers that MEAN "this turn must stop": the relay closed it
 *  cancelled, holds a cancel request for it, or authoritatively refused the
 *  adoption. Monotone — the relay only ever moves further into them. */
export const isCancelAnswer = (a: Adoption): boolean =>
  a.kind === "refused" || a.kind === "cancelling" || (a.kind === "terminal" && a.terminalState === "cancelled");

/** How a failed POST is handled. Lease fencing (401 unknown/expired lease,
 *  412 stale epoch) is TRANSIENT: it says nothing about whether the relay
 *  has the record, and the next lease can retry — deleting on it lost
 *  acknowledged-by-nobody data (Astra's review of 6ebea947). The relay's
 *  per-session event budget (429 session_event_budget_exhausted) never
 *  clears by retrying: that is a permanent refusal of THIS record. */
export type Fate = "transient" | "permanent" | "budget";
export const fateOf = (e: unknown): Fate => {
  const st = (e as { status?: number })?.status;
  const code = (e as { relayError?: string })?.relayError ?? "";
  if (st === 429) return code === "session_event_budget_exhausted" ? "budget" : "transient";
  if (typeof st !== "number") return "transient"; // network, timeout
  if (st === 401 || st === 408 || st === 412 || st >= 500) return "transient";
  return st >= 400 ? "permanent" : "transient";
};

export const initialTurnState = (): TurnState => ({ phase: "offered" });
/** A turn the ledger still carries from a previous incarnation: it re-enters
 *  at `submitted` (the coordinator must confirm the runtime running before
 *  anything is said to the relay) with /start already acknowledged or not. */
export const resumedTurnState = (startAcked: boolean): TurnState => ({ phase: "submitted", startPosted: startAcked, resumed: true });

export const isTurnClosed = (s: TurnState): boolean => s.phase === "terminal" || s.phase === "dropped";
/** The handle's projection (RelayTurnState.state). */
export const projectTurnState = (s: TurnState): "dispatching" | "running" | "adoption_pending" =>
  s.phase === "adoption_pending" ? "adoption_pending" : s.phase === "running" || s.phase === "cancelling" ? "running" : "dispatching";
/** Is a /start still owed to the relay? Never while the adoption is unanswered. */
export const startOwed = (s: TurnState): boolean => (s.phase === "running" || s.phase === "cancelling") && !s.startPosted;

const T = (state: TurnTerminal, reason: string | null): TurnState => ({ phase: "terminal", state, reason });
const D = (code: string): TurnState => ({ phase: "dropped", code });
const startRefusalReason = (code: string): string => (SESSION_GONE.has(code) ? code : "start_rejected");
const cancelledBy = (a: Adoption): string => (a.kind === "refused" ? a.code : "relay_cancelled");

/** The one answer for every (state, event) pair, or null = the event is not
 *  meaningful in that state and changes nothing. A refusal the machine
 *  answers null to is one the wiring THROWS (a lane error), not one it
 *  absorbs. Terminal and dropped answer null to everything (R14 for turns:
 *  a closed turn is never re-closed — the same cancellation learned twice is
 *  applied once, F31). */
export function nextTurnState(s: TurnState, ev: TurnEvent): TurnTransition | null {
  if (isTurnClosed(s)) return null;
  // The two events every open phase answers the same way.
  if (ev.type === "lane_error") return { to: T(ev.commandLive ? "cancelled" : "failed", "lane_error") };
  if (ev.type === "lease_lost") return { to: D("lease_lost") };
  switch (s.phase) {
    case "offered": switch (ev.type) {
      case "received_ok": return { to: { phase: "received" } };
      // Superseded (an edit, #57), unknown, or a dead epoch: the next claim
      // brings a fresh delivery. Anything else is thrown by the wiring.
      case "received_refused": return ev.status === 404 || ev.status === 409 || ev.status === 412 ? { to: D(`not_receivable:${ev.status}`) } : null;
      default: return null;
    }
    case "received": switch (ev.type) {
      case "no_local_session": return { to: D("no_local_session") };
      case "submitted_ok": return { to: { phase: "submitted", startPosted: false, resumed: false } };
      case "submitted_refused": return SESSION_GONE.has(ev.code) ? { to: D(ev.code) } : null;
      default: return null;
    }
    case "submitted": switch (ev.type) {
      case "undecodable": return { to: T("failed", ev.reason) };
      case "prepare_cancelled": return { to: T("cancelled", "cancelled_before_enqueue") };
      case "prepare_failed": return { to: T("failed", ev.reason) };
      case "handled_command": return { to: { phase: "handled" } };
      case "delivery_confirmed": return { to: { phase: "running", startPosted: s.startPosted, stage: "a", refusals: 0, stalled: false } };
      // Nothing will run it now: the row is cancelled so the queue moves on;
      // there is no agent turn to interrupt.
      case "delivery_timeout": return { to: T("failed", "dispatch_timeout"), effects: ["cancel_command"] };
      case "command_lost": return { to: T("failed", "command_lost") };
      case "turn_ended": return { to: T(ev.status, ev.reason) };
      default: return null;
    }
    case "handled": switch (ev.type) {
      case "start_ok": return { to: T("completed", "handled_as_command") };
      // The relay refuses the start (cancelled): whatever the command queued
      // is plucked or interrupted by the wiring; the turn says cancelled.
      case "start_refused": return { to: T("cancelled", startRefusalReason(ev.code)) };
      default: return null;
    }
    case "running":
    case "cancelling": return live(s, ev);
    case "adoption_pending": switch (ev.type) {
      case "command_lost": return { to: T("failed", "command_lost") };
      case "turn_ended": return { to: T(ev.status, ev.reason) };
      case "stalled": return { to: { ...s, stalled: true } };
      case "output_resumed": return { to: { ...s, stalled: false } };
      case "cancel_requested": return { to: { ...s, cancelling: true } };
      case "adoption": {
        const a = ev.answer;
        const back: Extract<TurnState, { phase: "running" | "cancelling" }> = { phase: s.cancelling ? "cancelling" : "running", startPosted: s.startPosted, stage: "c", refusals: 0, stalled: s.stalled };
        switch (a.kind) {
          case "unavailable": return { to: { ...s, attempts: s.attempts + 1, lastError: a.detail } };
          case "running": return { to: back };
          // Nothing left to adopt, or closed elsewhere: no /start for a turn
          // the relay has its answer on; the outcome posts as the terminal.
          case "none": return { to: { ...back, startPosted: true } };
          case "terminal": return a.terminalState === "cancelled" ? { to: T("cancelled", "relay_cancelled"), effects: ["cancel_locally"] } : { to: { ...back, startPosted: true } };
          case "refused": return { to: T("cancelled", a.code), effects: ["cancel_locally"] };
          case "cancelling": return { to: { ...back, phase: "cancelling" }, effects: ["cancel_command"] };
        }
      }
      // eslint-disable-next-line no-fallthrough
      default: return null;
    }
  }
  return null;
}

/** running / cancelling: one rule set (a cancel in progress only changes
 *  what a cancel-class refusal means — already honoured, waive the start). */
function live(s: Extract<TurnState, { phase: "running" | "cancelling" }>, ev: TurnEvent): TurnTransition | null {
  switch (ev.type) {
    case "command_lost": return { to: T("failed", "command_lost") };
    case "turn_ended": return { to: T(ev.status, ev.reason) };
    case "terminal_wait": return { to: { ...s, stage: "c" } };
    case "stalled": return { to: { ...s, stalled: true } };
    case "output_resumed": return { to: { ...s, stalled: false } };
    case "cancel_requested": return { to: { ...s, phase: "cancelling" } };
    case "start_ok": return { to: { ...s, startPosted: true } };
    case "start_refused": {
      if (START_CANCEL_CLASS.has(ev.code)) {
        // The relay's authoritative no while NOTHING has cancelled the command
        // here was the F28 wedge — cancel now. A cancel already in progress
        // locally is the same answer, already honoured: waive the /start.
        return s.phase === "running" ? { to: T("cancelled", ev.code), effects: ["cancel_locally"] } : { to: { ...s, startPosted: true } };
      }
      // A recovery question: ask the relay to adopt the turn once. Refused
      // again after that, the relay has its answer — the /start is waived
      // and the outcome posts as the terminal fact. Never a cancel.
      if (s.refusals === 0) return { to: { ...s, refusals: 1 }, effects: ["adopt"] };
      return { to: { ...s, startPosted: true } };
    }
    case "adoption": {
      const a = ev.answer;
      switch (a.kind) {
        case "running": return { to: s };
        // Nothing to adopt. After a refused /start that is the relay's answer
        // (the turn is ours and dispatching; a re-posted /start would be
        // refused the same way): the /start is waived. Otherwise (a resume,
        // a sweep's question) it changes nothing.
        case "none": return s.refusals > 0 ? { to: { ...s, startPosted: true } } : { to: s };
        case "terminal": return a.terminalState === "cancelled" ? { to: T("cancelled", "relay_cancelled"), effects: ["cancel_locally"] } : { to: { ...s, startPosted: true } };
        case "refused": return { to: T("cancelled", a.code), effects: ["cancel_locally"] };
        case "cancelling": return { to: { ...s, phase: "cancelling" }, effects: ["cancel_command"] };
        // Unresolved: the runtime keeps running, no /start until the relay
        // answers (a /start posted now would 409 and that refusal used to
        // cancel a surviving runtime — Astra, F14).
        case "unavailable": return { to: { phase: "adoption_pending", startPosted: s.startPosted, cancelling: s.phase === "cancelling", since: ev.now, attempts: 1, lastError: a.detail, stalled: s.stalled } };
      }
    }
    // eslint-disable-next-line no-fallthrough
    default: return null;
  }
}

// ── adoption arbitration: one answer per turn (F30), cancellation monotone (F31)

export interface AdoptionMailbox {
  /** The RESOLVED answer the sweep got for the turn, left for the loop. */
  answer: Adoption | null;
  /** Which RESOLVED answer has been applied. De-duplicates answers of the
   *  same class; never outranks a cancellation. */
  epoch: number;
}
export const emptyMailbox = (): AdoptionMailbox => ({ answer: null, epoch: 0 });

/** The LOOP's side. Given the answer its own reconcile returned and the
 *  epoch it started from: the answer to honour — the sweep's parked one when
 *  the sweep got there first (`via` names it), otherwise its own, claiming
 *  the epoch so a sweep still in flight defers to it. An `unavailable`
 *  answer resolves nothing and claims nothing. A parked CANCELLATION is
 *  honoured whatever this pass got, and a cancellation this pass got is
 *  honoured even when it lost the epoch. */
export function settleAdoption(box: AdoptionMailbox, mine: Adoption, epochBefore: number): { box: AdoptionMailbox; answer: Adoption; via: string | null } {
  const swept = box.answer;
  const VIA = "orphan sweep, which answered first";
  if (swept && isCancelAnswer(swept)) return { box: { answer: null, epoch: box.epoch + 1 }, answer: swept, via: VIA };
  if (box.epoch !== epochBefore) {
    if (isCancelAnswer(mine)) return { box: { ...box, epoch: box.epoch + 1 }, answer: mine, via: null };
    if (!swept) return { box, answer: mine, via: null };
    return { box: { ...box, answer: null }, answer: swept, via: VIA };
  }
  if (mine.kind !== "unavailable") return { box: { ...box, epoch: epochBefore + 1 }, answer: mine, via: null };
  return { box, answer: mine, via: null };
}

/** The SWEEP's side: park a RESOLVED answer for the loop. `dropped` when the
 *  loop answered its own adoption while this reconcile was in flight and
 *  this pass adds nothing; `carried-late` when it lost that race but holds a
 *  CANCELLATION not already parked, which is carried anyway. */
export function parkAdoptionAnswer(box: AdoptionMailbox, a: Adoption, epochBefore: number): { box: AdoptionMailbox; outcome: "parked" | "carried-late" | "dropped" } {
  const late = box.epoch !== epochBefore;
  if (late && !(isCancelAnswer(a) && !(box.answer && isCancelAnswer(box.answer)))) return { box, outcome: "dropped" };
  return { box: { answer: a, epoch: box.epoch + 1 }, outcome: late ? "carried-late" : "parked" };
}
