// The relay turn machine, exhaustively: every (state, event) pair has
// exactly one answer here. The states are the representative shapes of each
// phase (stage A with and without a refusal behind it, stage C, /start
// acknowledged or owed, a pending adoption with and without a local cancel);
// a pair missing from EXPECTED fails the test, so a new event or phase
// cannot be added without deciding it for every row. The arbitration
// mailbox (F30/F31) has its own scenarios below.
import { test, expect } from "vitest";
import {
  nextTurnState, TURN_EVENT_TYPES, TURN_PHASES, initialTurnState, resumedTurnState, projectTurnState, startOwed,
  settleAdoption, parkAdoptionAnswer, emptyMailbox, isCancelAnswer, fateOf,
  type TurnEvent, type TurnState, type TurnEffect, type TurnTerminal, type Adoption,
} from "./relayTurnMachine";

const NOW = 1_000;
const ADOPT = (answer: Adoption): TurnEvent => ({ type: "adoption", answer, now: NOW });
const EVENTS: Record<string, TurnEvent> = {
  received_ok: { type: "received_ok" },
  "received_refused(409)": { type: "received_refused", status: 409 },
  "received_refused(500)": { type: "received_refused", status: 500 },
  no_local_session: { type: "no_local_session" },
  submitted_ok: { type: "submitted_ok" },
  "submitted_refused(gone)": { type: "submitted_refused", code: "session_archived" },
  "submitted_refused(other)": { type: "submitted_refused", code: "turn_terminal" },
  undecodable: { type: "undecodable", reason: "undecodable_prompt" },
  prepare_cancelled: { type: "prepare_cancelled" },
  prepare_failed: { type: "prepare_failed", reason: "attachment_fetch_failed" },
  handled_command: { type: "handled_command" },
  delivery_confirmed: { type: "delivery_confirmed" },
  delivery_timeout: { type: "delivery_timeout" },
  command_lost: { type: "command_lost" },
  "turn_ended(completed)": { type: "turn_ended", status: "completed", reason: null },
  "turn_ended(failed)": { type: "turn_ended", status: "failed", reason: "agent_reported_failed" },
  "turn_ended(cancelled)": { type: "turn_ended", status: "cancelled", reason: "cancelled" },
  "turn_ended(interrupted)": { type: "turn_ended", status: "interrupted", reason: "killed" },
  start_ok: { type: "start_ok" },
  "start_refused(cancel)": { type: "start_refused", code: "turn_cancelled" },
  "start_refused(gone)": { type: "start_refused", code: "session_archived" },
  "start_refused(other)": { type: "start_refused", code: "no_current_delivery" },
  "adoption(running)": ADOPT({ kind: "running" }),
  "adoption(cancelling)": ADOPT({ kind: "cancelling" }),
  "adoption(terminal:completed)": ADOPT({ kind: "terminal", terminalState: "completed" }),
  "adoption(terminal:cancelled)": ADOPT({ kind: "terminal", terminalState: "cancelled" }),
  "adoption(none)": ADOPT({ kind: "none", detail: "turn_not_orphaned" }),
  "adoption(refused)": ADOPT({ kind: "refused", code: "session_event_budget_exhausted" }),
  "adoption(unavailable)": ADOPT({ kind: "unavailable", detail: "503" }),
  terminal_wait: { type: "terminal_wait" },
  stalled: { type: "stalled" },
  output_resumed: { type: "output_resumed" },
  "lane_error(dead)": { type: "lane_error", detail: "boom", commandLive: false },
  "lane_error(live)": { type: "lane_error", detail: "boom", commandLive: true },
  lease_lost: { type: "lease_lost" },
  cancel_requested: { type: "cancel_requested" },
};

/** Expected: null, or the phase plus whichever fields the row decides. */
type Answer = null | (Partial<Record<string, unknown>> & { phase: TurnState["phase"]; effects?: TurnEffect[] });
const NEVER: Record<string, Answer> = Object.fromEntries(Object.keys(EVENTS).map((k) => [k, null]));
const term = (state: TurnTerminal, reason: string | null, effects?: TurnEffect[]): Answer => ({ phase: "terminal", state, reason, ...(effects ? { effects } : {}) });
const ENDED: Record<string, Answer> = {
  "turn_ended(completed)": term("completed", null),
  "turn_ended(failed)": term("failed", "agent_reported_failed"),
  "turn_ended(cancelled)": term("cancelled", "cancelled"),
  "turn_ended(interrupted)": term("interrupted", "killed"),
  command_lost: term("failed", "command_lost"),
};
/** Every open phase answers these two the same way. */
const OPEN: Record<string, Answer> = {
  "lane_error(dead)": term("failed", "lane_error"),
  "lane_error(live)": term("cancelled", "lane_error"),
  lease_lost: { phase: "dropped", code: "lease_lost" },
};

const running = (o: Partial<Extract<TurnState, { phase: "running" }>> = {}): TurnState => ({ phase: "running", startPosted: false, stage: "a", refusals: 0, stalled: false, ...o });
const cancelling = (o: Partial<Extract<TurnState, { phase: "cancelling" }>> = {}): TurnState => ({ phase: "cancelling", startPosted: false, stage: "a", refusals: 0, stalled: false, ...o });
const pending = (o: Partial<Extract<TurnState, { phase: "adoption_pending" }>> = {}): TurnState => ({ phase: "adoption_pending", startPosted: false, cancelling: false, since: 5, attempts: 2, lastError: "503", stalled: false, ...o });

/** The adoption answers as a live (running/cancelling) turn takes them. */
const liveAdoption = (self: TurnState["phase"], none: Answer): Record<string, Answer> => ({
  "adoption(running)": { phase: self },
  "adoption(cancelling)": { phase: "cancelling", effects: ["cancel_command"] },
  "adoption(terminal:completed)": { phase: self, startPosted: true },
  "adoption(terminal:cancelled)": term("cancelled", "relay_cancelled", ["cancel_locally"]),
  "adoption(none)": none,
  "adoption(refused)": term("cancelled", "session_event_budget_exhausted", ["cancel_locally"]),
  "adoption(unavailable)": { phase: "adoption_pending", attempts: 1, lastError: "503", since: NOW, cancelling: self === "cancelling" },
});
/** The live phases answer every event the same way whatever the stage;
 *  only whether a /start was refused before (`refusals`) and whether a
 *  local cancel is in progress (`self`) change an answer. */
const live = (self: "running" | "cancelling", refusals = 0): Record<string, Answer> => ({
  ...NEVER, ...OPEN, ...ENDED,
  terminal_wait: { phase: self, stage: "c" },
  stalled: { phase: self, stalled: true },
  output_resumed: { phase: self, stalled: false },
  cancel_requested: { phase: "cancelling" },
  start_ok: { phase: self, startPosted: true },
  // The cancel class stops the prompt — unless a cancel is already in
  // progress here, which is the same answer already honoured.
  "start_refused(cancel)": self === "running" ? term("cancelled", "turn_cancelled", ["cancel_locally"]) : { phase: self, startPosted: true },
  "start_refused(gone)": self === "running" ? term("cancelled", "session_archived", ["cancel_locally"]) : { phase: self, startPosted: true },
  // A recovery question: adopt once; refused again, the start is waived.
  "start_refused(other)": refusals === 0 ? { phase: self, refusals: 1, effects: ["adopt"] } : { phase: self, startPosted: true },
  ...liveAdoption(self, { phase: self }),
  // Nothing to adopt after a refused /start: the relay's answer; waived.
  "adoption(none)": refusals === 0 ? { phase: self } : { phase: self, startPosted: true },
});

const CASES: Array<{ name: string; state: TurnState; expected: Record<string, Answer> }> = [
  { name: "offered", state: initialTurnState(), expected: {
    ...NEVER, ...OPEN, received_ok: { phase: "received" }, "received_refused(409)": { phase: "dropped", code: "not_receivable:409" },
  } },
  { name: "received", state: { phase: "received" }, expected: {
    ...NEVER, ...OPEN, no_local_session: { phase: "dropped", code: "no_local_session" },
    submitted_ok: { phase: "submitted", startPosted: false, resumed: false },
    "submitted_refused(gone)": { phase: "dropped", code: "session_archived" },
  } },
  { name: "submitted (fresh)", state: { phase: "submitted", startPosted: false, resumed: false }, expected: {
    ...NEVER, ...OPEN, ...ENDED,
    undecodable: term("failed", "undecodable_prompt"),
    prepare_cancelled: term("cancelled", "cancelled_before_enqueue"),
    prepare_failed: term("failed", "attachment_fetch_failed"),
    handled_command: { phase: "handled" },
    delivery_confirmed: { phase: "running", startPosted: false, stage: "a", refusals: 0 },
    delivery_timeout: term("failed", "dispatch_timeout", ["cancel_command"]),
  } },
  { name: "submitted (resumed, /start acknowledged)", state: resumedTurnState(true), expected: {
    ...NEVER, ...OPEN, ...ENDED,
    undecodable: term("failed", "undecodable_prompt"),
    prepare_cancelled: term("cancelled", "cancelled_before_enqueue"),
    prepare_failed: term("failed", "attachment_fetch_failed"),
    handled_command: { phase: "handled" },
    delivery_confirmed: { phase: "running", startPosted: true, stage: "a", refusals: 0 },
    delivery_timeout: term("failed", "dispatch_timeout", ["cancel_command"]),
  } },
  { name: "handled", state: { phase: "handled" }, expected: {
    ...NEVER, ...OPEN, start_ok: term("completed", "handled_as_command"),
    "start_refused(cancel)": term("cancelled", "start_rejected"),
    "start_refused(gone)": term("cancelled", "session_archived"),
    "start_refused(other)": term("cancelled", "start_rejected"),
  } },
  { name: "running (stage A)", state: running(), expected: live("running") },
  { name: "running (stage A, one refusal behind it)", state: running({ refusals: 1 }), expected: live("running", 1) },
  { name: "running (stage C, /start owed)", state: running({ stage: "c" }), expected: live("running") },
  { name: "running (stage C, one refusal behind it)", state: running({ stage: "c", refusals: 1 }), expected: live("running", 1) },
  { name: "running (stage C, /start acknowledged)", state: running({ stage: "c", startPosted: true }), expected: {
    ...live("running"), start_ok: { phase: "running", startPosted: true },
    "adoption(unavailable)": { phase: "adoption_pending", attempts: 1, startPosted: true, cancelling: false },
  } },
  { name: "cancelling (stage A)", state: cancelling(), expected: live("cancelling") },
  { name: "cancelling (stage A, one refusal behind it)", state: cancelling({ refusals: 1 }), expected: live("cancelling", 1) },
  { name: "cancelling (stage C)", state: cancelling({ stage: "c" }), expected: live("cancelling") },
  { name: "adoption_pending", state: pending(), expected: {
    ...NEVER, ...OPEN, ...ENDED,
    stalled: { phase: "adoption_pending", stalled: true },
    output_resumed: { phase: "adoption_pending", stalled: false },
    cancel_requested: { phase: "adoption_pending", cancelling: true },
    "adoption(unavailable)": { phase: "adoption_pending", attempts: 3, lastError: "503", since: 5 },
    "adoption(running)": { phase: "running", stage: "c", startPosted: false },
    "adoption(none)": { phase: "running", stage: "c", startPosted: true },
    "adoption(terminal:completed)": { phase: "running", stage: "c", startPosted: true },
    "adoption(terminal:cancelled)": term("cancelled", "relay_cancelled", ["cancel_locally"]),
    "adoption(refused)": term("cancelled", "session_event_budget_exhausted", ["cancel_locally"]),
    "adoption(cancelling)": { phase: "cancelling", stage: "c", effects: ["cancel_command"] },
  } },
  { name: "adoption_pending (a local cancel in progress)", state: pending({ cancelling: true, startPosted: true }), expected: {
    ...NEVER, ...OPEN, ...ENDED,
    stalled: { phase: "adoption_pending", stalled: true },
    output_resumed: { phase: "adoption_pending", stalled: false },
    cancel_requested: { phase: "adoption_pending", cancelling: true },
    "adoption(unavailable)": { phase: "adoption_pending", attempts: 3 },
    "adoption(running)": { phase: "cancelling", stage: "c", startPosted: true },
    "adoption(none)": { phase: "cancelling", stage: "c", startPosted: true },
    "adoption(terminal:completed)": { phase: "cancelling", stage: "c", startPosted: true },
    "adoption(terminal:cancelled)": term("cancelled", "relay_cancelled", ["cancel_locally"]),
    "adoption(refused)": term("cancelled", "session_event_budget_exhausted", ["cancel_locally"]),
    "adoption(cancelling)": { phase: "cancelling", stage: "c", effects: ["cancel_command"] },
  } },
  { name: "terminal", state: { phase: "terminal", state: "completed", reason: null }, expected: { ...NEVER } },
  { name: "dropped", state: { phase: "dropped", code: "no_local_session" }, expected: { ...NEVER } },
];

test("every (state, event) pair is decided, and decided as the table says", () => {
  expect(new Set(Object.values(EVENTS).map((e) => e.type))).toEqual(new Set(TURN_EVENT_TYPES));
  expect(new Set(CASES.map((c) => c.state.phase))).toEqual(new Set(TURN_PHASES));
  for (const c of CASES) {
    for (const [name, ev] of Object.entries(EVENTS)) {
      expect(c.expected, `${c.name} × ${name} is undecided in EXPECTED`).toHaveProperty(name);
      const want = c.expected[name];
      const got = nextTurnState(c.state, ev);
      const label = `${c.name} × ${name}`;
      if (want === null) { expect(got, label).toBeNull(); continue; }
      expect(got, label).not.toBeNull();
      const { effects, ...fields } = want;
      expect(got!.to, label).toMatchObject(fields);
      expect(got!.effects ?? [], label).toEqual(effects ?? []);
    }
  }
});

test("the handle's projection and the owed /start come from the state", () => {
  expect(projectTurnState(initialTurnState())).toBe("dispatching");
  expect(projectTurnState({ phase: "handled" })).toBe("dispatching");
  expect(projectTurnState(running())).toBe("running");
  expect(projectTurnState(cancelling())).toBe("running");
  expect(projectTurnState(pending())).toBe("adoption_pending");
  expect(startOwed(running())).toBe(true);
  expect(startOwed(running({ startPosted: true }))).toBe(false);
  expect(startOwed(cancelling())).toBe(true);
  expect(startOwed(pending())).toBe(false);
  expect(startOwed(initialTurnState())).toBe(false);
});

test("a fresh turn walks offer → received → submitted → running → /start → completed", () => {
  let s = initialTurnState();
  const step = (ev: TurnEvent) => { const t = nextTurnState(s, ev); expect(t, ev.type).not.toBeNull(); s = t!.to; };
  step({ type: "received_ok" }); step({ type: "submitted_ok" }); step({ type: "delivery_confirmed" });
  expect(startOwed(s)).toBe(true);
  step({ type: "start_ok" }); step({ type: "terminal_wait" });
  expect(s).toMatchObject({ phase: "running", stage: "c", startPosted: true });
  step({ type: "turn_ended", status: "completed", reason: null });
  expect(s).toEqual({ phase: "terminal", state: "completed", reason: null });
  expect(nextTurnState(s, { type: "turn_ended", status: "cancelled", reason: "x" })).toBeNull();
});

test("F14: an unavailable adoption never cancels — the turn parks, keeps counting, and a later `running` resumes it with the /start still owed", () => {
  let s = running();
  s = nextTurnState(s, ADOPT({ kind: "unavailable", detail: "503" }))!.to;
  expect(s).toMatchObject({ phase: "adoption_pending", attempts: 1, since: NOW, startPosted: false });
  s = nextTurnState(s, ADOPT({ kind: "unavailable", detail: "504" }))!.to;
  expect(s).toMatchObject({ phase: "adoption_pending", attempts: 2, lastError: "504", since: NOW });
  expect(nextTurnState(s, { type: "start_ok" })).toBeNull(); // no /start while pending
  s = nextTurnState(s, ADOPT({ kind: "running" }))!.to;
  expect(s).toMatchObject({ phase: "running", stage: "c" });
  expect(startOwed(s)).toBe(true);
});

// ── the arbitration mailbox ────────────────────────────────────────────────

const RUN: Adoption = { kind: "running" };
const CANCELLED: Adoption = { kind: "terminal", terminalState: "cancelled" };
const DONE: Adoption = { kind: "terminal", terminalState: "completed" };
const UNAVAILABLE: Adoption = { kind: "unavailable", detail: "503" };

test("F30: first resolved answer wins — the loop's own answer claims the epoch; a sweep that finishes after it is dropped", () => {
  let box = emptyMailbox();
  const loop = settleAdoption(box, RUN, 0);
  expect(loop).toMatchObject({ answer: RUN, via: null, box: { epoch: 1, answer: null } });
  box = loop.box;
  expect(parkAdoptionAnswer(box, RUN, 0)).toMatchObject({ outcome: "dropped", box: { epoch: 1 } });
  expect(parkAdoptionAnswer(box, DONE, 0)).toMatchObject({ outcome: "dropped" });
});

test("F30: the sweep answered first — the loop honours the parked answer and drops its own", () => {
  let box = emptyMailbox();
  const swept = parkAdoptionAnswer(box, DONE, 0);
  expect(swept.outcome).toBe("parked");
  box = swept.box;
  const loop = settleAdoption(box, RUN, 0);
  expect(loop.answer).toEqual(DONE);
  expect(loop.via).toMatch(/orphan sweep/);
  expect(loop.box.answer).toBeNull();
});

test("an unavailable answer claims nothing: the sweep's later resolution still parks as first", () => {
  const box = emptyMailbox();
  const loop = settleAdoption(box, UNAVAILABLE, 0);
  expect(loop.box.epoch).toBe(0);
  expect(parkAdoptionAnswer(loop.box, RUN, 0).outcome).toBe("parked");
});

test("F31: cancellation is monotone — a late cancelled close is carried past the epoch, and honoured by the loop whatever it got", () => {
  let box = settleAdoption(emptyMailbox(), RUN, 0).box; // the loop adopted first (epoch 1)
  const late = parkAdoptionAnswer(box, CANCELLED, 0);
  expect(late.outcome).toBe("carried-late");
  box = late.box;
  expect(box.answer).toEqual(CANCELLED);
  // …and not twice: a second late cancellation over an unconsumed one is dropped.
  expect(parkAdoptionAnswer(box, { kind: "refused", code: "session_archived" }, 0).outcome).toBe("dropped");
  const loop = settleAdoption(box, RUN, 1);
  expect(loop.answer).toEqual(CANCELLED);
  expect(loop.box.answer).toBeNull();
  // A cancellation the loop itself learned after losing the epoch is still honoured.
  const own = settleAdoption({ answer: null, epoch: 5 }, CANCELLED, 2);
  expect(own).toMatchObject({ answer: CANCELLED, via: null, box: { epoch: 6 } });
});

test("cancel answers, and the fate of a failed POST", () => {
  expect(isCancelAnswer(CANCELLED)).toBe(true);
  expect(isCancelAnswer({ kind: "refused", code: "x" })).toBe(true);
  expect(isCancelAnswer({ kind: "cancelling" })).toBe(true);
  expect(isCancelAnswer(DONE)).toBe(false);
  expect(isCancelAnswer(RUN)).toBe(false);
  expect(fateOf({ status: 429, relayError: "session_event_budget_exhausted" })).toBe("budget");
  expect(fateOf({ status: 429, relayError: "relay_busy" })).toBe("transient");
  expect(fateOf(new Error("socket hang up"))).toBe("transient");
  for (const st of [401, 408, 412, 500, 503]) expect(fateOf({ status: st }), String(st)).toBe("transient");
  for (const st of [400, 404, 409]) expect(fateOf({ status: st }), String(st)).toBe("permanent");
  expect(fateOf({ status: 200 })).toBe("transient");
});
