// The command state machine, exhaustively: every (state, event) pair has
// exactly one answer here, and the answer is the rule the design table
// names. A pair missing from EXPECTED fails the test, so a new event or
// state cannot be added without deciding it for every row.
import { test, expect } from "vitest";
import { nextState, COMMAND_STATES, MACHINE_EVENT_TYPES, type MachineEvent, type Transition } from "./coordinator";
import type { CommandState } from "./ledger";

type Answer = CommandState | null | { to: CommandState; reason?: string; unresolved?: boolean };
const EVENTS: Record<string, MachineEvent> = {
  attempt: { type: "attempt" },
  submit_accepted: { type: "submit_accepted" },
  submit_unknown: { type: "submit_unknown" },
  "submit_rejected(permanent)": { type: "submit_rejected", permanent: true },
  "submit_rejected(transient)": { type: "submit_rejected", permanent: false },
  evidence: { type: "evidence" },
  "turn_ended(completed)": { type: "turn_ended", status: "completed" },
  "turn_ended(failed)": { type: "turn_ended", status: "failed" },
  "turn_ended(cancelled)": { type: "turn_ended", status: "cancelled" },
  "turn_ended(interrupted)": { type: "turn_ended", status: "interrupted" },
  "reconcile(accepted)": { type: "reconcile", outcome: "accepted" },
  "reconcile(running)": { type: "reconcile", outcome: "running" },
  "reconcile(absent)": { type: "reconcile", outcome: "absent" },
  "reconcile(unknown)": { type: "reconcile", outcome: "unknown" },
  cancel: { type: "cancel" },
  interrupt_confirmed: { type: "interrupt_confirmed" },
  "interrupt_failed(retry)": { type: "interrupt_failed", exhausted: false },
  "interrupt_failed(exhausted)": { type: "interrupt_failed", exhausted: true },
  "generation_closed(keep)": { type: "generation_closed", reason: "restart", keepQueued: true },
  "generation_closed(kill)": { type: "generation_closed", reason: "killed", keepQueued: false },
  idle: { type: "idle" },
  edit: { type: "edit" },
};

const T = (to: CommandState, reason?: string): Answer => ({ to, reason });
const ENDED: Record<string, Answer> = {
  "turn_ended(completed)": T("completed", "completed"),
  "turn_ended(failed)": T("failed", "agent_reported_failed"),
  "turn_ended(cancelled)": T("cancelled", "agent_reported_cancelled"),
  "turn_ended(interrupted)": T("interrupted", "agent_reported_interrupted"),
};
const NEVER: Record<string, Answer> = Object.fromEntries(Object.keys(EVENTS).map((k) => [k, null]));

const EXPECTED: Record<CommandState, Record<string, Answer>> = {
  queued: {
    ...NEVER,
    attempt: "submitting",
    cancel: T("cancelled", "cancelled"),
    edit: "queued",
    evidence: "running",
    "generation_closed(keep)": "queued",
    "generation_closed(kill)": T("interrupted", "killed"),
  },
  submitting: {
    ...NEVER,
    submit_accepted: "accepted",
    submit_unknown: "unknown",
    "submit_rejected(permanent)": T("failed", "rejected"),
    "submit_rejected(transient)": "queued",
    evidence: "running",
    ...ENDED,
    cancel: "cancelling",
    "generation_closed(keep)": "unknown",
    "generation_closed(kill)": T("interrupted", "killed"),
  },
  accepted: {
    ...NEVER,
    evidence: "running",
    ...ENDED,
    cancel: "cancelling",
    idle: T("interrupted", "idle_without_terminal"),
    "generation_closed(keep)": "unknown",
    "generation_closed(kill)": T("interrupted", "killed"),
  },
  unknown: {
    ...NEVER,
    "reconcile(accepted)": "accepted",
    "reconcile(running)": "running",
    "reconcile(absent)": "queued",
    "reconcile(unknown)": "unknown",
    evidence: "running",
    ...ENDED,
    cancel: "cancelling",
    "generation_closed(keep)": "unknown",
    "generation_closed(kill)": T("interrupted", "killed"),
  },
  running: {
    ...NEVER,
    evidence: "running",
    ...ENDED,
    cancel: "cancelling",
    idle: T("interrupted", "idle_without_terminal"),
    "generation_closed(keep)": "unknown",
    "generation_closed(kill)": T("interrupted", "killed"),
  },
  cancelling: {
    ...NEVER,
    interrupt_confirmed: T("cancelled", "cancelled"),
    "interrupt_failed(retry)": { to: "cancelling", unresolved: false },
    "interrupt_failed(exhausted)": { to: "cancelling", unresolved: true },
    "turn_ended(completed)": T("completed", "completed"),
    "turn_ended(failed)": T("failed", "agent_reported_failed"),
    "turn_ended(cancelled)": T("cancelled", "cancelled"),
    "turn_ended(interrupted)": T("cancelled", "cancelled"),
    idle: T("cancelled", "cancelled"),
    submit_accepted: "cancelling",
    submit_unknown: "cancelling",
    evidence: "cancelling",
    "submit_rejected(permanent)": T("cancelled", "cancelled"),
    "submit_rejected(transient)": T("cancelled", "cancelled"),
    cancel: "cancelling",
    "generation_closed(keep)": T("cancelled", "cancelled:restart"),
    "generation_closed(kill)": T("cancelled", "cancelled:killed"),
  },
  completed: NEVER,
  failed: NEVER,
  cancelled: NEVER,
  interrupted: NEVER,
};

test("every (state, event) pair is decided, and decided as the table says", () => {
  const eventTypes = new Set(Object.values(EVENTS).map((e) => e.type));
  for (const t of MACHINE_EVENT_TYPES) expect(eventTypes.has(t), `event ${t} has no row`).toBe(true);
  for (const state of COMMAND_STATES) {
    const row = EXPECTED[state];
    expect(row, `state ${state} has no row`).toBeDefined();
    for (const [name, ev] of Object.entries(EVENTS)) {
      expect(name in row, `${state} × ${name} is undecided`).toBe(true);
      const got: Transition | null = nextState(state, ev);
      const want = row[name];
      const label = `${state} × ${name}`;
      if (want === null) { expect(got, label).toBeNull(); continue; }
      expect(got, label).not.toBeNull();
      if (typeof want === "string") { expect(got!.to, label).toBe(want); expect(got!.terminalReason, label).toBeUndefined(); continue; }
      expect(got!.to, label).toBe(want.to);
      if (want.reason !== undefined) expect(got!.terminalReason, label).toBe(want.reason);
      if (want.unresolved !== undefined) expect(!!got!.unresolved, label).toBe(want.unresolved);
    }
  }
});

test("terminal states answer nothing: a row that ended is never re-submitted or re-completed (R14)", () => {
  for (const state of ["completed", "failed", "cancelled", "interrupted"] as const) {
    for (const ev of Object.values(EVENTS)) expect(nextState(state, ev)).toBeNull();
  }
});

test("a terminal outcome comes only from the runtime's verdict, a permanent rejection, a confirmed interrupt or a closed generation (R7/R17)", () => {
  const terminalProducers = new Set<string>();
  for (const state of COMMAND_STATES) for (const [name, ev] of Object.entries(EVENTS)) {
    const t = nextState(state, ev);
    if (t && ["completed", "failed", "cancelled", "interrupted"].includes(t.to)) terminalProducers.add(name.replace(/\(.*\)$/, ""));
  }
  expect([...terminalProducers].sort()).toEqual(["cancel", "generation_closed", "idle", "interrupt_confirmed", "submit_rejected", "turn_ended"]);
  // `attempt`, `submit_accepted`, `submit_unknown`, `evidence`, `reconcile` never end a command:
  for (const name of ["attempt", "submit_accepted", "submit_unknown", "evidence", "reconcile(accepted)", "reconcile(running)", "reconcile(absent)", "reconcile(unknown)"]) {
    for (const state of COMMAND_STATES) {
      const t = nextState(state, EVENTS[name]);
      if (t) expect(["completed", "failed", "cancelled", "interrupted"]).not.toContain(t.to);
    }
  }
});
