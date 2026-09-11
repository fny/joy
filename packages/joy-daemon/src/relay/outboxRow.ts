// The outbox, explicitly: what state a ROW is in, and what state a
// session's LINE (the one sender loop per session) is in. Both used to be
// implicit — the row's state was four columns read together (acked_at,
// attempts, next_retry_at, last_error; domain/ledger.ts `outbox`), the
// line's was two collections on the scheduler (#running, #wanted) plus a
// loop-local `waited`. No schema changes: `rowStateOf` is a pure read of
// the columns, and the line machine is the scheduler's bookkeeping in one
// value per session, stepped by `nextLineState` (the coordinator's pattern,
// domain/coordinator.ts; tabled exhaustively in outboxRow.test.ts).
//
// The rules the machine keeps (relay/outbox.ts, #462/#464/#74/#130):
//   - a wake registers the line SYNCHRONOUSLY: a post() that wakes this
//     session while a row is being sent must find the loop registered, not
//     start a second one — so `wake` moves idle → running before the loop
//     body has run at all (the body starts on a microtask);
//   - the loop consumes the wake at the top of each pass; a wake that lands
//     during an awaited post is still pending when the pass ends, and a
//     loop that exits with a pending wake and rows left restarts;
//   - a backoff the loop has slept through is not slept again for the same
//     row (`waited`): the persisted next_retry_at is for a restart;
//   - a permanent refusal drops the row INSIDE one transaction with the
//     caller's evidence (`settle`) — that is the wiring's, not the
//     machine's, but `settlementOf` names the verdict.
import type { OutboxRow } from "../domain/ledger";
import type { PostResult } from "./outbox";

// ── row state: a pure read of the persisted columns ─────────────────────────

export type RowState =
  | { kind: "pending" }
  | { kind: "backoff"; until: number; attempts: number; lastError: string | null }
  | { kind: "acked"; at: number }
  | { kind: "dropped"; at: number; reason: string };
export const ROW_STATE_KINDS: ReadonlyArray<RowState["kind"]> = ["pending", "backoff", "acked", "dropped"];

/** `dropOutbound` writes acked_at + `dropped: <reason>`; `ackOutbound`
 *  writes acked_at and clears last_error. That prefix is the only thing
 *  telling the two apart in the row. */
export const DROPPED_PREFIX = "dropped: ";

export function rowStateOf(row: Pick<OutboxRow, "ackedAt" | "attempts" | "nextRetryAt" | "lastError">, now: number): RowState {
  if (row.ackedAt != null) {
    return row.lastError?.startsWith(DROPPED_PREFIX)
      ? { kind: "dropped", at: row.ackedAt, reason: row.lastError.slice(DROPPED_PREFIX.length) }
      : { kind: "acked", at: row.ackedAt };
  }
  if (row.nextRetryAt > now) return { kind: "backoff", until: row.nextRetryAt, attempts: row.attempts, lastError: row.lastError };
  return { kind: "pending" };
}
export const isRowSettled = (row: Pick<OutboxRow, "ackedAt">): boolean => row.ackedAt != null;

// ── the line: one sender per session ───────────────────────────────────────

export type LinePhase = "idle" | "running" | "stopped";
export const LINE_PHASES: readonly LinePhase[] = ["idle", "running", "stopped"];

export interface LineState {
  phase: LinePhase;
  /** Which loop incarnation owns the line; a stale incarnation's exit
   *  changes nothing. */
  gen: number;
  /** A wake not yet consumed by a pass. */
  wanted: boolean;
  /** The row whose backoff this incarnation already slept through. */
  waited: number | null;
}

export type LineEvent =
  | { type: "wake" }
  /** The loop reached the top of a pass: the wake is consumed. */
  | { type: "pass"; gen: number }
  /** The loop slept a row's backoff (and will retry it without waiting again). */
  | { type: "slept"; gen: number; seq: number }
  /** The loop is leaving: nothing to send, the line is parked (unbound),
   *  or it crashed. `hasRows`: the ledger still holds unacked rows. */
  | { type: "exit"; gen: number; reason: "drained" | "parked" | "crashed"; hasRows: boolean }
  | { type: "stop" };
export const LINE_EVENT_TYPES: ReadonlyArray<LineEvent["type"]> = ["wake", "pass", "slept", "exit", "stop"];

export interface LineTransition {
  to: LineState;
  /** Start a loop incarnation for `to.gen`. */
  startLoop?: boolean;
}

export const initialLineState = (): LineState => ({ phase: "idle", gen: 0, wanted: false, waited: null });

/** The one answer for every (phase, event) pair, or null = the event is
 *  not meaningful in that phase (a pass from a loop that no longer owns the
 *  line, a wake on a stopped sender) and changes nothing. */
export function nextLineState(s: LineState, ev: LineEvent): LineTransition | null {
  if (s.phase === "stopped") return null;
  if (ev.type === "stop") return { to: { ...s, phase: "stopped", wanted: false } };
  switch (s.phase) {
    case "idle": switch (ev.type) {
      case "wake": return { to: { phase: "running", gen: s.gen + 1, wanted: true, waited: null }, startLoop: true };
      default: return null;
    }
    case "running": {
      if (ev.type === "wake") return { to: { ...s, wanted: true } };
      if (ev.gen !== s.gen) return null;
      switch (ev.type) {
        case "pass": return { to: { ...s, wanted: false } };
        case "slept": return { to: { ...s, waited: ev.seq } };
        case "exit":
          // A wake that landed during an awaited post, with rows still to
          // send, restarts the line; otherwise it goes idle.
          return s.wanted && ev.hasRows
            ? { to: { phase: "running", gen: s.gen + 1, wanted: true, waited: null }, startLoop: true }
            : { to: { phase: "idle", gen: s.gen, wanted: false, waited: null } };
      }
      return null;
    }
  }
  return null;
}

// ── the loop's two decisions ───────────────────────────────────────────────

/** How long to wait before sending `row`, on the line's clock: 0 = now.
 *  A backoff this incarnation already slept is not slept again; a wait
 *  past `maxBackoffMs` is taken in `maxBackoffMs` slices (re-read between,
 *  so a settled or replaced row is noticed). */
export function waitBeforeSend(row: Pick<OutboxRow, "seq" | "nextRetryAt">, s: Pick<LineState, "waited">, now: number, maxBackoffMs: number): { wait: number; recheck: boolean } {
  if (s.waited === row.seq) return { wait: 0, recheck: false };
  const wait = row.nextRetryAt - now;
  if (wait > maxBackoffMs) return { wait: maxBackoffMs, recheck: true };
  return { wait: Math.max(0, wait), recheck: false };
}

export type Settlement =
  | { verdict: "already_settled" }
  | { verdict: "ack" }
  | { verdict: "drop"; reason: string; settle?: () => void }
  | { verdict: "park" }
  | { verdict: "retry"; error: string; delayMs: number };

export function backoffMs(attempts: number, baseBackoffMs: number, maxBackoffMs: number): number {
  return Math.min(maxBackoffMs, baseBackoffMs * Math.pow(2, Math.max(0, attempts)));
}

/** What the post's result means for the row as it is NOW (re-read: someone
 *  else may have settled it while the post was in flight). */
export function settlementOf(result: PostResult, current: Pick<OutboxRow, "ackedAt" | "attempts"> | null, opts: { baseBackoffMs: number; maxBackoffMs: number }): Settlement {
  if (!current || current.ackedAt != null) return { verdict: "already_settled" };
  if (result.ok) return { verdict: "ack" };
  switch (result.fate) {
    case "permanent": return { verdict: "drop", reason: result.error, settle: result.settle };
    case "unbound": return { verdict: "park" };
    case "transient": return { verdict: "retry", error: result.error, delayMs: result.retryAfterMs ?? backoffMs(current.attempts, opts.baseBackoffMs, opts.maxBackoffMs) };
  }
}
