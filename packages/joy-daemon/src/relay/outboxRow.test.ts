// The outbox line machine, exhaustively: every (phase, event) pair has one
// answer here; a pair missing from EXPECTED fails. Plus the pure row-state
// read and the loop's two decisions.
import { test, expect } from "vitest";
import {
  nextLineState, initialLineState, LINE_PHASES, LINE_EVENT_TYPES, rowStateOf, waitBeforeSend, settlementOf, backoffMs, DROPPED_PREFIX,
  type LineEvent, type LinePhase, type LineState,
} from "./outboxRow";

const EVENTS: Record<string, LineEvent> = {
  wake: { type: "wake" },
  "pass(own)": { type: "pass", gen: 1 },
  "pass(stale)": { type: "pass", gen: 0 },
  "slept(own)": { type: "slept", gen: 1, seq: 7 },
  "slept(stale)": { type: "slept", gen: 0, seq: 7 },
  "exit(drained,rows)": { type: "exit", gen: 1, reason: "drained", hasRows: true },
  "exit(drained,empty)": { type: "exit", gen: 1, reason: "drained", hasRows: false },
  "exit(parked,rows)": { type: "exit", gen: 1, reason: "parked", hasRows: true },
  "exit(stale)": { type: "exit", gen: 0, reason: "crashed", hasRows: true },
  stop: { type: "stop" },
};

type Answer = null | { phase: LinePhase; gen?: number; wanted?: boolean; waited?: number | null; startLoop?: boolean };
const NEVER: Record<string, Answer> = Object.fromEntries(Object.keys(EVENTS).map((k) => [k, null]));

const states: Record<string, LineState> = {
  idle: { phase: "idle", gen: 0, wanted: false, waited: null },
  "running(unwanted)": { phase: "running", gen: 1, wanted: false, waited: null },
  "running(wanted)": { phase: "running", gen: 1, wanted: true, waited: null },
  stopped: { phase: "stopped", gen: 1, wanted: false, waited: null },
};
const EXPECTED: Record<string, Record<string, Answer>> = {
  idle: { ...NEVER, wake: { phase: "running", gen: 1, wanted: true, startLoop: true }, stop: { phase: "stopped" } },
  "running(unwanted)": {
    ...NEVER,
    wake: { phase: "running", gen: 1, wanted: true },
    "pass(own)": { phase: "running", wanted: false },
    "slept(own)": { phase: "running", waited: 7 },
    "exit(drained,rows)": { phase: "idle", wanted: false, waited: null },   // no wake pending: rows left are someone else's wake to send
    "exit(drained,empty)": { phase: "idle" },
    "exit(parked,rows)": { phase: "idle" },
    stop: { phase: "stopped" },
  },
  "running(wanted)": {
    ...NEVER,
    wake: { phase: "running", gen: 1, wanted: true },
    "pass(own)": { phase: "running", wanted: false },
    "slept(own)": { phase: "running", waited: 7 },
    "exit(drained,rows)": { phase: "running", gen: 2, wanted: true, waited: null, startLoop: true }, // the wake that landed mid-post restarts the line
    "exit(drained,empty)": { phase: "idle" },
    "exit(parked,rows)": { phase: "running", gen: 2, startLoop: true },
    stop: { phase: "stopped" },
  },
  stopped: { ...NEVER },
};

test("every (phase, event) pair is decided", () => {
  expect(new Set(Object.keys(states).map((k) => states[k].phase))).toEqual(new Set(LINE_PHASES));
  for (const [name, s] of Object.entries(states)) {
    const expected = EXPECTED[name];
    for (const evName of Object.keys(EVENTS)) {
      expect(expected, `${name} × ${evName} is undecided`).toHaveProperty(evName);
      const t = nextLineState(s, EVENTS[evName]);
      const want = expected[evName];
      if (want === null) { expect(t, `${name} × ${evName}`).toBeNull(); continue; }
      expect(t, `${name} × ${evName}`).not.toBeNull();
      expect(t!.to.phase, `${name} × ${evName}`).toBe(want.phase);
      if (want.gen !== undefined) expect(t!.to.gen).toBe(want.gen);
      if (want.wanted !== undefined) expect(t!.to.wanted).toBe(want.wanted);
      if (want.waited !== undefined) expect(t!.to.waited).toBe(want.waited);
      expect(!!t!.startLoop, `${name} × ${evName} startLoop`).toBe(!!want.startLoop);
    }
  }
  expect(new Set(Object.values(EVENTS).map((e) => e.type))).toEqual(new Set(LINE_EVENT_TYPES));
  expect(initialLineState().phase).toBe("idle");
});

test("rowStateOf reads the four columns as one state", () => {
  const base = { ackedAt: null, attempts: 0, nextRetryAt: 0, lastError: null };
  expect(rowStateOf(base, 100)).toEqual({ kind: "pending" });
  expect(rowStateOf({ ...base, attempts: 2, nextRetryAt: 500, lastError: "503" }, 100)).toEqual({ kind: "backoff", until: 500, attempts: 2, lastError: "503" });
  expect(rowStateOf({ ...base, nextRetryAt: 100 }, 100)).toEqual({ kind: "pending" }); // due
  expect(rowStateOf({ ...base, ackedAt: 900 }, 100)).toEqual({ kind: "acked", at: 900 });
  expect(rowStateOf({ ...base, ackedAt: 900, lastError: `${DROPPED_PREFIX}budget` }, 100)).toEqual({ kind: "dropped", at: 900, reason: "budget" });
});

test("waitBeforeSend: no double sleep for a row already waited, a far retry is taken in capped slices", () => {
  expect(waitBeforeSend({ seq: 7, nextRetryAt: 5_000 }, { waited: 7 }, 1_000, 800)).toEqual({ wait: 0, recheck: false });
  expect(waitBeforeSend({ seq: 7, nextRetryAt: 1_300 }, { waited: null }, 1_000, 800)).toEqual({ wait: 300, recheck: false });
  expect(waitBeforeSend({ seq: 7, nextRetryAt: 900 }, { waited: null }, 1_000, 800)).toEqual({ wait: 0, recheck: false });
  expect(waitBeforeSend({ seq: 7, nextRetryAt: 5_000 }, { waited: null }, 1_000, 800)).toEqual({ wait: 800, recheck: true });
});

test("settlementOf: the verdict on a post result against the row as it is now", () => {
  const o = { baseBackoffMs: 100, maxBackoffMs: 800 };
  const cur = { ackedAt: null, attempts: 2 };
  expect(settlementOf({ ok: true }, null, o)).toEqual({ verdict: "already_settled" });
  expect(settlementOf({ ok: true }, { ackedAt: 5, attempts: 0 }, o)).toEqual({ verdict: "already_settled" });
  expect(settlementOf({ ok: true }, cur, o)).toEqual({ verdict: "ack" });
  const settle = () => {};
  expect(settlementOf({ ok: false, fate: "permanent", error: "429", settle }, cur, o)).toEqual({ verdict: "drop", reason: "429", settle });
  expect(settlementOf({ ok: false, fate: "unbound", error: "no v2" }, cur, o)).toEqual({ verdict: "park" });
  expect(settlementOf({ ok: false, fate: "transient", error: "503" }, cur, o)).toEqual({ verdict: "retry", error: "503", delayMs: 400 });
  expect(settlementOf({ ok: false, fate: "transient", error: "503", retryAfterMs: 50 }, cur, o)).toEqual({ verdict: "retry", error: "503", delayMs: 50 });
  expect(backoffMs(10, 100, 800)).toBe(800);
});
