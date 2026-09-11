// The agy run machine, exhaustively: every (phase, event) pair has one
// answer; a pair missing from EXPECTED fails. The orders #466 names — exit
// before stdout EOF and after, result before either, abort mid-stream,
// end() mid-run — are the scenarios.
import { test, expect } from "vitest";
import { nextRunState, initialRunState, RUN_PHASES, RUN_EVENT_TYPES, finalizeOutcome, type RunEvent, type RunState, type RunEffect } from "./agyRun";

const EVENTS: Record<string, RunEvent> = {
  "result(ok)": { type: "result", success: true },
  "result(failed)": { type: "result", success: false },
  "exit(0)": { type: "exit", code: 0 },
  "exit(1)": { type: "exit", code: 1 },
  "exit(signal)": { type: "exit", code: null },
  stdout_done: { type: "stdout_done" },
  cancel: { type: "cancel" },
  retire: { type: "retire" },
  spawn_failed: { type: "spawn_failed", error: "ENOENT" },
  process_error: { type: "process_error", error: "EPIPE" },
};
const PERR_OPEN: RunEffect[] = [{ type: "warn", why: "EPIPE" }, { type: "end_turn", status: "failed" }, { type: "finalize", outcome: "failed", why: "EPIPE" }];
const PERR_ENDED = (outcome: "completed" | "failed" | "cancelled"): RunEffect[] => [{ type: "finalize", outcome, why: "EPIPE" }];
type Answer = null | { phase: RunState["phase"]; effects: RunEffect[] };
const NEVER: Record<string, Answer> = Object.fromEntries(Object.keys(EVENTS).map((k) => [k, null]));
const st = (o: Partial<RunState>): RunState => ({ ...initialRunState(), ...o });
const END = (status: RunEffect extends infer _ ? "completed" | "failed" | "cancelled" : never): RunEffect => ({ type: "end_turn", status });

const STATES: Record<string, RunState> = {
  running: st({}),
  "running(exit seen)": st({ exit: { code: 1 } }),
  "running(stdout done)": st({ stdoutDone: true }),
  result_seen: st({ phase: "result_seen", turnEnded: true, streamStatus: "failed" }),
  "result_seen(exit seen)": st({ phase: "result_seen", turnEnded: true, streamStatus: "completed", exit: { code: 0 } }),
  cancelled: st({ phase: "cancelled", turnEnded: true }),
  "cancelled(stdout done)": st({ phase: "cancelled", turnEnded: true, stdoutDone: true }),
  finalized: st({ phase: "finalized", turnEnded: true, outcome: "completed" }),
};
const EXPECTED: Record<string, Record<string, Answer>> = {
  running: {
    ...NEVER,
    "result(ok)": { phase: "result_seen", effects: [END("completed")] },
    "result(failed)": { phase: "result_seen", effects: [END("failed")] },
    "exit(0)": { phase: "running", effects: [] }, "exit(1)": { phase: "running", effects: [] }, "exit(signal)": { phase: "running", effects: [] },
    stdout_done: { phase: "running", effects: [] },
    cancel: { phase: "cancelled", effects: [END("cancelled")] },
    retire: { phase: "finalized", effects: [END("cancelled")] },
    spawn_failed: { phase: "finalized", effects: [END("failed")] },
    process_error: { phase: "finalized", effects: PERR_OPEN },
  },
  "running(exit seen)": {
    ...NEVER,
    "result(ok)": { phase: "result_seen", effects: [END("completed")] },
    "result(failed)": { phase: "result_seen", effects: [END("failed")] },
    "exit(0)": { phase: "running", effects: [] }, "exit(1)": { phase: "running", effects: [] }, "exit(signal)": { phase: "running", effects: [] },
    // Nothing announced the end: exit 1 is a failure the stream did not report.
    stdout_done: { phase: "finalized", effects: [{ type: "warn", why: "exit 1" }, END("failed"), { type: "finalize", outcome: "failed", why: "exit 1" }] },
    cancel: { phase: "cancelled", effects: [END("cancelled")] },
    retire: { phase: "finalized", effects: [END("cancelled")] },
    spawn_failed: { phase: "finalized", effects: [END("failed")] },
    process_error: { phase: "finalized", effects: PERR_OPEN },
  },
  "running(stdout done)": {
    ...NEVER,
    "result(ok)": { phase: "result_seen", effects: [END("completed")] },
    "result(failed)": { phase: "result_seen", effects: [END("failed")] },
    "exit(0)": { phase: "finalized", effects: [END("completed"), { type: "finalize", outcome: "completed", why: "exit 0" }] },
    "exit(1)": { phase: "finalized", effects: [{ type: "warn", why: "exit 1" }, END("failed"), { type: "finalize", outcome: "failed", why: "exit 1" }] },
    "exit(signal)": { phase: "finalized", effects: [{ type: "warn", why: "terminated" }, END("failed"), { type: "finalize", outcome: "failed", why: "terminated" }] },
    stdout_done: { phase: "running", effects: [] },
    cancel: { phase: "cancelled", effects: [END("cancelled")] },
    retire: { phase: "finalized", effects: [END("cancelled")] },
    spawn_failed: { phase: "finalized", effects: [END("failed")] },
    process_error: { phase: "finalized", effects: PERR_OPEN },
  },
  result_seen: {
    ...NEVER,
    "exit(0)": { phase: "result_seen", effects: [] }, "exit(1)": { phase: "result_seen", effects: [] }, "exit(signal)": { phase: "result_seen", effects: [] },
    stdout_done: { phase: "result_seen", effects: [] },
    retire: { phase: "finalized", effects: [] },
    process_error: { phase: "finalized", effects: PERR_ENDED("failed") },
  },
  "result_seen(exit seen)": {
    ...NEVER,
    "exit(0)": { phase: "result_seen", effects: [] }, "exit(1)": { phase: "result_seen", effects: [] }, "exit(signal)": { phase: "result_seen", effects: [] },
    // The stream ended the turn; the coordinator hears `completed` whatever the code (transcribed).
    stdout_done: { phase: "finalized", effects: [{ type: "finalize", outcome: "completed", why: "" }] },
    retire: { phase: "finalized", effects: [] },
    process_error: { phase: "finalized", effects: PERR_ENDED("failed") },
  },
  cancelled: {
    ...NEVER,
    "exit(0)": { phase: "cancelled", effects: [] }, "exit(1)": { phase: "cancelled", effects: [] }, "exit(signal)": { phase: "cancelled", effects: [] },
    stdout_done: { phase: "cancelled", effects: [] },
    retire: { phase: "finalized", effects: [] },
    process_error: { phase: "finalized", effects: PERR_ENDED("cancelled") },
  },
  "cancelled(stdout done)": {
    ...NEVER,
    "exit(0)": { phase: "finalized", effects: [{ type: "finalize", outcome: "cancelled", why: "" }] },
    "exit(1)": { phase: "finalized", effects: [{ type: "finalize", outcome: "cancelled", why: "" }] },
    "exit(signal)": { phase: "finalized", effects: [{ type: "finalize", outcome: "cancelled", why: "" }] },
    stdout_done: { phase: "cancelled", effects: [] },
    retire: { phase: "finalized", effects: [] },
    process_error: { phase: "finalized", effects: PERR_ENDED("cancelled") },
  },
  finalized: { ...NEVER },
};

test("every (phase, event) pair is decided", () => {
  expect(new Set(Object.values(STATES).map((s) => s.phase))).toEqual(new Set(RUN_PHASES));
  expect(new Set(Object.values(EVENTS).map((e) => e.type))).toEqual(new Set(RUN_EVENT_TYPES));
  for (const [name, s] of Object.entries(STATES)) {
    for (const evName of Object.keys(EVENTS)) {
      expect(EXPECTED[name], `${name} × ${evName} is undecided`).toHaveProperty(evName);
      const want = EXPECTED[name][evName];
      const t = nextRunState(s, EVENTS[evName]);
      if (want === null) { expect(t, `${name} × ${evName}`).toBeNull(); continue; }
      expect(t, `${name} × ${evName}`).not.toBeNull();
      expect(t!.to.phase, `${name} × ${evName}`).toBe(want.phase);
      expect(t!.effects, `${name} × ${evName} effects`).toEqual(want.effects);
    }
  }
});

test("#466: exit and stdout EOF settle the run once, in either order; a second settlement is a no-op", () => {
  let s = initialRunState();
  s = nextRunState(s, { type: "result", success: true })!.to;
  s = nextRunState(s, { type: "stdout_done" })!.to;
  const t = nextRunState(s, { type: "exit", code: 0 })!;
  expect(t.to.phase).toBe("finalized");
  expect(t.effects).toEqual([{ type: "finalize", outcome: "completed", why: "" }]);
  expect(nextRunState(t.to, { type: "exit", code: 0 })).toBeNull();
  expect(nextRunState(t.to, { type: "result", success: false })).toBeNull();
  expect(finalizeOutcome(st({ exit: { code: 137 } }))).toEqual({ status: "failed", why: "exit 137" });
});
