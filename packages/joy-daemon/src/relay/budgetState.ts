// A session's relay event budget (#130), as one explicit record per
// session. The relay refuses every further event for a session once its
// per-session budget is spent (429 session_event_budget_exhausted), and
// retrying never clears it — the only recovery is a fresh session. What the
// daemon knows about that used to live in three places that had to agree:
// a set of exhausted sessions, a map of drop counts, and the ledger job row
// that persists the count (plus a map of sessions whose row could not be
// read, and a timer map coalescing the card publication). Here it is one
// value, stepped by `nextBudgetState` (the coordinator's pattern,
// domain/coordinator.ts; tabled exhaustively in budgetState.test.ts). The
// ledger job row is this state's PERSISTED projection: the count is read
// from and written to the ledger inside the outbox transaction that drops
// the refused row (`budgetRefused` in nucleusLane.ts), never incremented
// in memory, so a rolled-back settlement counts a record exactly once.
//
//   ok         nothing is known to be lost; the relay takes events
//   unknown    the ledger could not be read: NOT an absent budget — a card
//              sealed without the count would erase the only warning, so
//              card publications defer until the row reads again (Astra
//              on a6443ea8)
//   exhausted  the relay refuses events for this session; `dropped` is the
//              settled loss on record (0 right after the 429, before the
//              refused row settles); `cardDropped` the count the relay's
//              card is KNOWN to carry; `publishDueAt` a coalesced card
//              publication owed (a burst of drops is one PATCH)

export interface Loss { since: number; dropped: number }

export type BudgetState =
  | { kind: "ok" }
  | { kind: "unknown"; localId: string; since: number; error: string }
  | { kind: "exhausted"; localId: string; since: number; dropped: number; cardDropped: number; publishDueAt: number | null };
export type BudgetKind = BudgetState["kind"];
export const BUDGET_KINDS: readonly BudgetKind[] = ["ok", "unknown", "exhausted"];

/** The persisted job row's payload, as read. */
export interface PersistedBudget { localId: string; since: number; dropped: number; cardDropped: number }

export type BudgetEvent =
  /** The relay answered 429 session_event_budget_exhausted for a record. */
  | { type: "refused_429"; localId: string; now: number }
  /** The outbox dropped a refused row and wrote the count to the ledger. */
  | { type: "drop_settled"; row: PersistedBudget; now: number }
  /** The ledger row was read: a count, or nothing persisted. */
  | { type: "ledger_read"; localId: string; row: PersistedBudget | null }
  | { type: "ledger_unreadable"; localId: string; error: string; now: number }
  /** The coalescing timer fired: the card publication is being made. */
  | { type: "publish_due" }
  /** The relay accepted a card carrying `carried` dropped outputs. */
  | { type: "published"; carried: number }
  /** A record was accepted. Listed so the table is total: the budget never
   *  clears by retrying, so this changes nothing anywhere. */
  | { type: "fact_ok" };
export const BUDGET_EVENT_TYPES: ReadonlyArray<BudgetEvent["type"]> = ["refused_429", "drop_settled", "ledger_read", "ledger_unreadable", "publish_due", "published", "fact_ok"];

/** Card PATCHes are coalesced: a burst of dropped records is one PATCH. */
export const BUDGET_PUBLISH_MS = 1_000;

export const OK: BudgetState = { kind: "ok" };

export interface BudgetTransition {
  to: BudgetState;
  /** Arm the coalescing timer for `to.publishDueAt` (none was armed). */
  armPublish?: boolean;
}

/** The one answer for every (kind, event) pair, or null = the event is not
 *  meaningful in that state and changes nothing. */
export function nextBudgetState(s: BudgetState, ev: BudgetEvent): BudgetTransition | null {
  switch (s.kind) {
    case "ok": switch (ev.type) {
      case "refused_429": return { to: { kind: "exhausted", localId: ev.localId, since: ev.now, dropped: 0, cardDropped: 0, publishDueAt: null } };
      case "drop_settled": return settled(null, ev);
      case "ledger_read": return ev.row && ev.row.dropped > 0 ? { to: fromRow(ev.localId, ev.row) } : { to: s };
      case "ledger_unreadable": return { to: { kind: "unknown", localId: ev.localId, since: ev.now, error: ev.error } };
      default: return null;
    }
    case "unknown": switch (ev.type) {
      // A 429 is the relay's word: the session is full whatever the row said.
      case "refused_429": return { to: { kind: "exhausted", localId: ev.localId, since: ev.now, dropped: 0, cardDropped: 0, publishDueAt: null } };
      case "drop_settled": return settled(null, ev);
      case "ledger_read": return ev.row && ev.row.dropped > 0 ? { to: fromRow(ev.localId, ev.row) } : { to: OK };
      case "ledger_unreadable": return { to: s }; // noted once
      default: return null;
    }
    case "exhausted": switch (ev.type) {
      case "refused_429": return { to: s };
      case "drop_settled": return settled(s, ev);
      // Memory is ahead of the ledger by construction (every write goes
      // through memory); a read changes nothing here.
      case "ledger_read": return { to: s };
      case "ledger_unreadable": return { to: s };
      case "publish_due": return { to: { ...s, publishDueAt: null } };
      case "published": return ev.carried > s.cardDropped ? { to: { ...s, cardDropped: ev.carried } } : { to: s };
      case "fact_ok": return null;
    }
  }
  return null;
}

const fromRow = (localId: string, row: PersistedBudget): BudgetState =>
  ({ kind: "exhausted", localId, since: row.since, dropped: row.dropped, cardDropped: row.cardDropped, publishDueAt: null });

function settled(prev: Extract<BudgetState, { kind: "exhausted" }> | null, ev: Extract<BudgetEvent, { type: "drop_settled" }>): BudgetTransition {
  const owed = prev?.publishDueAt ?? null;
  return {
    to: { kind: "exhausted", localId: ev.row.localId, since: ev.row.since, dropped: ev.row.dropped, cardDropped: ev.row.cardDropped, publishDueAt: owed ?? ev.now + BUDGET_PUBLISH_MS },
    armPublish: owed === null,
  };
}

/** Is the relay refusing this session's events? */
export const isExhausted = (s: BudgetState | undefined): boolean => s?.kind === "exhausted";
/** The loss on record (a card banner's worth), or null when nothing settled. */
export const lossOf = (s: BudgetState | undefined): (Loss & { localId: string; cardDropped: number }) | null =>
  s?.kind === "exhausted" && s.dropped > 0 ? { localId: s.localId, since: s.since, dropped: s.dropped, cardDropped: s.cardDropped } : null;
