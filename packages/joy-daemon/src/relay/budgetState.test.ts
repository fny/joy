// The budget record, exhaustively: every (kind, event) pair has one answer;
// a pair missing from EXPECTED fails.
import { test, expect } from "vitest";
import { nextBudgetState, BUDGET_KINDS, BUDGET_EVENT_TYPES, BUDGET_PUBLISH_MS, isExhausted, lossOf, OK, type BudgetEvent, type BudgetState, type BudgetKind } from "./budgetState";

const NOW = 5_000;
const ROW = { localId: "w1", since: 1_000, dropped: 3, cardDropped: 1 };
const EVENTS: Record<string, BudgetEvent> = {
  refused_429: { type: "refused_429", localId: "w1", now: NOW },
  drop_settled: { type: "drop_settled", row: ROW, now: NOW },
  "ledger_read(row)": { type: "ledger_read", localId: "w1", row: ROW },
  "ledger_read(empty)": { type: "ledger_read", localId: "w1", row: null },
  ledger_unreadable: { type: "ledger_unreadable", localId: "w1", error: "EIO", now: NOW },
  publish_due: { type: "publish_due" },
  "published(ahead)": { type: "published", carried: 3 },
  "published(behind)": { type: "published", carried: 0 },
  fact_ok: { type: "fact_ok" },
};
type Answer = null | { kind: BudgetKind; dropped?: number; cardDropped?: number; publishDueAt?: number | null; arm?: boolean };
const NEVER: Record<string, Answer> = Object.fromEntries(Object.keys(EVENTS).map((k) => [k, null]));

const exhausted = (o: Partial<Extract<BudgetState, { kind: "exhausted" }>> = {}): BudgetState =>
  ({ kind: "exhausted", localId: "w1", since: 1_000, dropped: 2, cardDropped: 1, publishDueAt: null, ...o });
const STATES: Record<string, BudgetState> = {
  ok: OK,
  unknown: { kind: "unknown", localId: "w1", since: 900, error: "EIO" },
  "exhausted(no publish owed)": exhausted(),
  "exhausted(publish owed)": exhausted({ publishDueAt: 4_500 }),
};
const EXPECTED: Record<string, Record<string, Answer>> = {
  ok: {
    ...NEVER,
    refused_429: { kind: "exhausted", dropped: 0, publishDueAt: null },
    drop_settled: { kind: "exhausted", dropped: 3, cardDropped: 1, publishDueAt: NOW + BUDGET_PUBLISH_MS, arm: true },
    "ledger_read(row)": { kind: "exhausted", dropped: 3, cardDropped: 1 },
    "ledger_read(empty)": { kind: "ok" },
    ledger_unreadable: { kind: "unknown" },
  },
  unknown: {
    ...NEVER,
    refused_429: { kind: "exhausted", dropped: 0 },
    drop_settled: { kind: "exhausted", dropped: 3, arm: true },
    "ledger_read(row)": { kind: "exhausted", dropped: 3 },
    "ledger_read(empty)": { kind: "ok" },
    ledger_unreadable: { kind: "unknown" },
  },
  "exhausted(no publish owed)": {
    ...NEVER,
    refused_429: { kind: "exhausted", dropped: 2 },
    drop_settled: { kind: "exhausted", dropped: 3, publishDueAt: NOW + BUDGET_PUBLISH_MS, arm: true },
    "ledger_read(row)": { kind: "exhausted", dropped: 2 },   // memory is ahead of the ledger
    "ledger_read(empty)": { kind: "exhausted", dropped: 2 },
    ledger_unreadable: { kind: "exhausted", dropped: 2 },
    publish_due: { kind: "exhausted", publishDueAt: null },
    "published(ahead)": { kind: "exhausted", cardDropped: 3 },
    "published(behind)": { kind: "exhausted", cardDropped: 1 },
  },
  "exhausted(publish owed)": {
    ...NEVER,
    refused_429: { kind: "exhausted" },
    drop_settled: { kind: "exhausted", dropped: 3, publishDueAt: 4_500, arm: false }, // one PATCH for the burst
    "ledger_read(row)": { kind: "exhausted", dropped: 2 },
    "ledger_read(empty)": { kind: "exhausted" },
    ledger_unreadable: { kind: "exhausted" },
    publish_due: { kind: "exhausted", publishDueAt: null },
    "published(ahead)": { kind: "exhausted", cardDropped: 3 },
    "published(behind)": { kind: "exhausted", cardDropped: 1 },
  },
};

test("every (kind, event) pair is decided", () => {
  expect(new Set(Object.values(STATES).map((s) => s.kind))).toEqual(new Set(BUDGET_KINDS));
  expect(new Set(Object.values(EVENTS).map((e) => e.type))).toEqual(new Set(BUDGET_EVENT_TYPES));
  for (const [name, s] of Object.entries(STATES)) {
    for (const evName of Object.keys(EVENTS)) {
      expect(EXPECTED[name], `${name} × ${evName} is undecided`).toHaveProperty(evName);
      const want = EXPECTED[name][evName];
      const t = nextBudgetState(s, EVENTS[evName]);
      if (want === null) { expect(t, `${name} × ${evName}`).toBeNull(); continue; }
      expect(t, `${name} × ${evName}`).not.toBeNull();
      expect(t!.to.kind, `${name} × ${evName}`).toBe(want.kind);
      if (want.dropped !== undefined) expect((t!.to as { dropped?: number }).dropped, `${name} × ${evName} dropped`).toBe(want.dropped);
      if (want.cardDropped !== undefined) expect((t!.to as { cardDropped?: number }).cardDropped, `${name} × ${evName} cardDropped`).toBe(want.cardDropped);
      if (want.publishDueAt !== undefined) expect((t!.to as { publishDueAt?: number | null }).publishDueAt, `${name} × ${evName} publishDueAt`).toBe(want.publishDueAt);
      if (want.arm !== undefined) expect(!!t!.armPublish, `${name} × ${evName} arm`).toBe(want.arm);
    }
  }
});

test("derived reads: exhausted right after a 429 has no loss to show yet; a settled count does", () => {
  expect(isExhausted(undefined)).toBe(false);
  expect(isExhausted(OK)).toBe(false);
  const fresh = nextBudgetState(OK, EVENTS.refused_429)!.to;
  expect(isExhausted(fresh)).toBe(true);
  expect(lossOf(fresh)).toBeNull();
  const counted = nextBudgetState(fresh, EVENTS.drop_settled)!.to;
  expect(lossOf(counted)).toEqual({ localId: "w1", since: 1_000, dropped: 3, cardDropped: 1 });
});
