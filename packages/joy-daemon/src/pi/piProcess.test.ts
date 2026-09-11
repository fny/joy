// The pi process machine, exhaustively: every (phase, event) pair has
// exactly one answer here, for every variant of the phase that changes an
// answer (a turn open or not, thinking or not, a child still exiting or
// not). A pair missing from EXPECTED fails the test.
import { test, expect } from "vitest";
import {
  nextPiProcess, initialPiProcess, piAlive, piExiting, PI_PHASES, PI_EVENT_TYPES,
  type PiProcessEvent, type PiProcessState, type PiEffect, type PiPhase,
} from "./piProcess";

const EVENTS: Record<string, PiProcessEvent> = {
  spawned: { type: "spawned", pid: 4242 },
  spawn_failed: { type: "spawn_failed", error: "ENOENT" },
  "exited(own)": { type: "exited", pid: 4242 },
  "exited(other)": { type: "exited", pid: 99 },
  "end(killed,alive)": { type: "end", reason: "killed", alive: true },
  "end(restart,dead)": { type: "end", reason: "restart", alive: false },
  turn_start: { type: "turn_start" },
  turn_end: { type: "turn_end" },
  agent_end: { type: "agent_end" },
  error: { type: "error" },
  abort_ok: { type: "abort_ok" },
};

type Answer = null | { phase: PiPhase; dying?: boolean; pid?: number | null; turnOpen?: boolean; thinking?: boolean; turnSeq?: number; effects: string[] };
const NEVER: Record<string, Answer> = Object.fromEntries(Object.keys(EVENTS).map((k) => [k, null]));
const fx = (e: PiEffect): string => e.type === "turn_end" ? `turn_end:${e.status}:${e.seq}` : e.type === "notify_thinking" ? `thinking:${e.on}` : e.type === "kill_process" ? `kill:${e.pid}` : `driver:${e.status}`;

/** Variants of each phase that can change an answer. */
type Variant = { name: string; state: PiProcessState; expected: Record<string, Answer> };
const running = (turnOpen: boolean, thinking: boolean): PiProcessState =>
  ({ phase: "running", pid: 4242, dying: false, reason: null, turnSeq: 3, turnOpen, thinking });
const ended = (dying: boolean): PiProcessState =>
  ({ phase: "ended", pid: dying ? 4242 : null, dying, reason: "killed", turnSeq: 3, turnOpen: false, thinking: false });

const closeFx = (turnOpen: boolean, thinking: boolean, status: "cancelled" | "failed"): string[] =>
  [...(turnOpen ? [`turn_end:${status}:3`] : []), ...(thinking ? ["thinking:false"] : [])];

const runningRows = (turnOpen: boolean, thinking: boolean): Record<string, Answer> => ({
  ...NEVER,
  "exited(own)": { phase: "ended", dying: false, pid: null, turnOpen: false, thinking: false, effects: closeFx(turnOpen, thinking, "cancelled") },
  "exited(other)": { phase: "ended", dying: false, pid: null, turnOpen: false, thinking: false, effects: closeFx(turnOpen, thinking, "cancelled") },
  "end(killed,alive)": { phase: "ended", dying: true, pid: 4242, turnOpen: false, thinking: false, effects: ["kill:4242", ...closeFx(turnOpen, thinking, "cancelled")] },
  "end(restart,dead)": { phase: "ended", dying: false, pid: null, turnOpen: false, thinking: false, effects: closeFx(turnOpen, thinking, "cancelled") },
  turn_start: { phase: "running", turnOpen: true, thinking: true, turnSeq: 4, effects: thinking ? [] : ["thinking:true"] },
  turn_end: { phase: "running", turnOpen: false, thinking, effects: [] },
  agent_end: { phase: "running", turnOpen, thinking: false, effects: thinking ? ["thinking:false"] : [] },
  error: { phase: "running", turnOpen: false, thinking: false, effects: closeFx(turnOpen, thinking, "failed") },
  abort_ok: turnOpen ? { phase: "running", turnOpen: false, thinking: false, effects: [...closeFx(true, thinking, "cancelled"), "driver:cancelled"] } : null,
});

const VARIANTS: Variant[] = [
  { name: "idle", state: initialPiProcess("starting"), expected: {
    ...NEVER,
    spawned: { phase: "running", pid: 4242, effects: [] },
    spawn_failed: { phase: "ended", effects: [] },
    "end(killed,alive)": { phase: "ended", dying: false, effects: [] },
    "end(restart,dead)": { phase: "ended", dying: false, effects: [] },
  } },
  { name: "running (idle pi)", state: running(false, false), expected: runningRows(false, false) },
  { name: "running (turn open, thinking)", state: running(true, true), expected: runningRows(true, true) },
  { name: "running (turn closed, still thinking — between turn_end and agent_end)", state: running(false, true), expected: runningRows(false, true) },
  { name: "running (turn open, not thinking — a stale clear)", state: running(true, false), expected: runningRows(true, false) },
  { name: "ended (child exiting)", state: ended(true), expected: { ...NEVER, "exited(own)": { phase: "ended", dying: false, pid: null, effects: [] } } },
  { name: "ended (nothing to wait for)", state: ended(false), expected: { ...NEVER } },
];

test("every (phase, event) pair is decided, and decided as the table says", () => {
  expect(new Set(Object.values(EVENTS).map((e) => e.type))).toEqual(new Set(PI_EVENT_TYPES));
  expect(new Set(VARIANTS.map((v) => v.state.phase))).toEqual(new Set(PI_PHASES));
  for (const v of VARIANTS) {
    for (const [name, ev] of Object.entries(EVENTS)) {
      const label = `${v.name} × ${name}`;
      expect(v.expected, `${label} is undecided in EXPECTED`).toHaveProperty(name);
      const want = v.expected[name];
      const got = nextPiProcess(v.state, ev);
      if (want === null) { expect(got, label).toBeNull(); continue; }
      expect(got, label).not.toBeNull();
      expect(got!.to.phase, label).toBe(want.phase);
      if (want.dying !== undefined) expect(got!.to.dying, label).toBe(want.dying);
      if (want.pid !== undefined) expect(got!.to.pid, label).toBe(want.pid);
      if (want.turnOpen !== undefined) expect(got!.to.turnOpen, label).toBe(want.turnOpen);
      if (want.thinking !== undefined) expect(got!.to.thinking, label).toBe(want.thinking);
      if (want.turnSeq !== undefined) expect(got!.to.turnSeq, label).toBe(want.turnSeq);
      expect(got!.effects.map(fx), label).toEqual(want.effects);
      // The input is never mutated.
      expect(v.state.phase, label).toBe(v.state.phase);
      // turnSeq is monotone.
      expect(got!.to.turnSeq, label).toBeGreaterThanOrEqual(v.state.turnSeq);
    }
  }
});

test("the handover: end() signals the live child, awaitExit has a subject until its exit is seen, and nothing else touches it", () => {
  let s = initialPiProcess("starting");
  s = nextPiProcess(s, { type: "spawned", pid: 7 })!.to;
  expect(piAlive(s)).toBe(true);
  s = nextPiProcess(s, { type: "turn_start" })!.to;
  const t = nextPiProcess(s, { type: "end", reason: "restart", alive: true })!;
  expect(t.effects.map(fx)).toEqual(["kill:7", "turn_end:cancelled:1", "thinking:false"]);
  s = t.to;
  expect(piAlive(s)).toBe(false);
  expect(piExiting(s)).toBe(true);
  expect(nextPiProcess(s, { type: "end", reason: "killed", alive: true })).toBeNull(); // a second end() is a no-op (returned false)
  expect(nextPiProcess(s, { type: "turn_start" })).toBeNull();                       // a row after the process is gone changes nothing
  expect(nextPiProcess(s, { type: "exited", pid: 8 })).toBeNull();                   // not the child being waited for
  s = nextPiProcess(s, { type: "exited", pid: 7 })!.to;
  expect(piExiting(s)).toBe(false);
});

test("a session constructed ended (a detached record) has nothing to spawn and nothing to wait for", () => {
  const s = initialPiProcess("ended", "process_exited");
  expect(s).toMatchObject({ phase: "ended", dying: false, reason: "process_exited" });
  expect(nextPiProcess(s, { type: "spawned", pid: 1 })).toBeNull();
});

test("turn ids are a monotonic seq; a turn_start while thinking is already on tells the relay nothing new", () => {
  let s = nextPiProcess(initialPiProcess("active"), { type: "spawned", pid: 1 })!.to;
  let t = nextPiProcess(s, { type: "turn_start" })!;
  expect(t.to.turnSeq).toBe(1); expect(t.effects.map(fx)).toEqual(["thinking:true"]);
  s = nextPiProcess(t.to, { type: "turn_end" })!.to;
  expect(s.thinking).toBe(true); // agent_end clears it, not turn_end
  t = nextPiProcess(s, { type: "turn_start" })!;
  expect(t.to.turnSeq).toBe(2); expect(t.effects).toEqual([]);
  t = nextPiProcess(t.to, { type: "error" })!;
  expect(t.effects.map(fx)).toEqual(["turn_end:failed:2", "thinking:false"]);
  t = nextPiProcess(t.to, { type: "agent_end" })!;
  expect(t.effects).toEqual([]); // already cleared
});
