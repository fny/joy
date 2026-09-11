// The Codex start machine, exhaustively: every (phase, event) pair has
// exactly one answer here. A pair missing from EXPECTED fails the test, so
// a new event or phase cannot be added without deciding it for every row.
// The ordering rows are the ones that matter: a notification before or
// after the thread/read response frame, a kill during any step, a step
// finishing after the kill.
import { test, expect } from "vitest";
import {
  nextStartState, initialStartState, isBuffering, isRejoined, bindBufferedItems,
  nextDeliveredState, initialDeliveredState, isDelivered, markRef,
  START_PHASES, START_EVENT_TYPES, DELIVERED_EVENT_TYPES,
  type StartEvent, type StartPhase, type StartState, type StartEffect, type HistoryItem, type Buffered, type DeliveredEvent,
} from "./codexStartMachine";
import type { CodexNotification } from "./normalize";

const N = (method: string, params: Record<string, unknown> = {}): CodexNotification => ({ method, params });
const NOTE = N("item/completed", { threadId: "TH", turnId: "T1", item: { type: "agentMessage", id: "live", text: "hi" } });

const EVENTS: Record<string, StartEvent> = {
  "start(rejoin)": { type: "start", canRejoin: true },
  "start(fresh)": { type: "start", canRejoin: false },
  rejoin_failed: { type: "rejoin_failed", error: "resumed wrong thread" },
  thread_resumed: { type: "thread_resumed", threadId: "TH" },
  thread_started: { type: "thread_started", threadId: "TH" },
  read_response: { type: "read_response", barrier: 7 },
  history_replayed: { type: "history_replayed", turnId: "T1", items: [{ id: "item-0", type: "agentMessage", ordinal: 0, sig: "s", matched: false }] },
  reconcile_done: { type: "reconcile_done" },
  notification: { type: "notification", n: NOTE, seq: 9 },
  killed: { type: "killed", reason: "killed" },
  start_failed: { type: "start_failed", error: "boom" },
};

type Answer = null | { phase: StartPhase; origin?: "rejoin" | "fresh" | null; barrier?: number; buffered?: number; history?: number; effects?: StartEffect["type"][] };
const NEVER: Record<string, Answer> = Object.fromEntries(Object.keys(EVENTS).map((k) => [k, null]));
const ENDED_BY_KILL: Record<string, Answer> = { killed: { phase: "ended", buffered: 0, history: 0 }, start_failed: { phase: "ended", buffered: 0, history: 0, effects: ["end"] } };

/** Each buffering phase is tested with one notification already parked, so
 *  the table shows the buffer growing (2) or draining (0). */
const EXPECTED: Record<StartPhase, (origin: "rejoin" | "fresh" | null) => Record<string, Answer>> = {
  idle: () => ({
    ...NEVER,
    "start(rejoin)": { phase: "rejoining", effects: [] },
    "start(fresh)": { phase: "spawning", effects: ["spawn"] },
    killed: { phase: "ended" },
  }),
  rejoining: () => ({
    ...NEVER, ...ENDED_BY_KILL,
    thread_resumed: { phase: "reading_snapshot", origin: "rejoin", buffered: 1 },
    rejoin_failed: { phase: "spawning", origin: null, buffered: 1, effects: ["spawn"] },
    notification: { phase: "rejoining", buffered: 2 },
  }),
  spawning: () => ({
    ...NEVER, ...ENDED_BY_KILL,
    thread_resumed: { phase: "reading_snapshot", origin: "fresh", buffered: 1 },
    thread_started: { phase: "snapshot_read", origin: "fresh", barrier: 0, buffered: 1, history: 0 },
    notification: { phase: "spawning", buffered: 2 },
  }),
  reading_snapshot: (o) => ({
    ...NEVER, ...ENDED_BY_KILL,
    // The barrier is the response frame's fact; a notification parked before
    // it is still in the buffer, and will bind if its seq is within it.
    read_response: { phase: "snapshot_read", origin: o, barrier: 7, buffered: 1, history: 0 },
    notification: { phase: "reading_snapshot", origin: o, buffered: 2 },
  }),
  snapshot_read: (o) => ({
    ...NEVER, ...ENDED_BY_KILL,
    history_replayed: { phase: "snapshot_read", origin: o, buffered: 1, history: 1 },
    reconcile_done: { phase: "live", origin: o, buffered: 0, history: 0, effects: ["flush", "ready"] },
    notification: { phase: "snapshot_read", origin: o, buffered: 2 },
  }),
  live: (o) => ({
    ...NEVER, ...ENDED_BY_KILL,
    notification: { phase: "live", origin: o, buffered: 0, effects: ["dispatch"] },
  }),
  ended: () => ({
    ...NEVER,
    // A step finishing after the end: what it produced is abandoned.
    rejoin_failed: { phase: "ended", effects: ["abandon"] },
    thread_resumed: { phase: "ended", effects: ["abandon"] },
    thread_started: { phase: "ended", effects: ["abandon"] },
    read_response: { phase: "ended", effects: ["abandon"] },
    reconcile_done: { phase: "ended", effects: ["abandon"] },
  }),
};

const stateFor = (phase: StartPhase, origin: "rejoin" | "fresh" | null): StartState => {
  const s = initialStartState();
  s.phase = phase;
  s.origin = origin;
  if (phase === "reading_snapshot" || phase === "snapshot_read" || phase === "live") s.threadId = "TH";
  if (phase === "snapshot_read" || phase === "live") s.barrier = 7;
  if (isBuffering(s)) s.buffered = [{ n: N("turn/started"), seq: 1 }];
  return s;
};
const originsFor = (phase: StartPhase): Array<"rejoin" | "fresh" | null> =>
  phase === "reading_snapshot" || phase === "snapshot_read" || phase === "live" ? ["rejoin", "fresh"] : [null];

test("every (phase, event) pair is decided, and decided as the table says", () => {
  expect(new Set(Object.values(EVENTS).map((e) => e.type))).toEqual(new Set(START_EVENT_TYPES));
  for (const phase of START_PHASES) {
    for (const origin of originsFor(phase)) {
      const table = EXPECTED[phase](origin);
      for (const [name, ev] of Object.entries(EVENTS)) {
        expect(name in table, `${phase}/${origin} × ${name} is undecided`).toBe(true);
        const want = table[name];
        const s = stateFor(phase, origin);
        const before = JSON.stringify({ ...s, history: [...s.history] });
        const t = nextStartState(s, ev);
        expect(JSON.stringify({ ...s, history: [...s.history] }), `${phase} × ${name} mutated its input`).toBe(before);
        if (want === null) { expect(t, `${phase}/${origin} × ${name}`).toBeNull(); continue; }
        expect(t, `${phase}/${origin} × ${name}`).not.toBeNull();
        expect(t!.to.phase, `${phase}/${origin} × ${name} phase`).toBe(want.phase);
        if ("origin" in want) expect(t!.to.origin, `${phase}/${origin} × ${name} origin`).toBe(want.origin);
        if (want.barrier !== undefined) expect(t!.to.barrier, `${phase}/${origin} × ${name} barrier`).toBe(want.barrier);
        if (want.buffered !== undefined) expect(t!.to.buffered.length, `${phase}/${origin} × ${name} buffered`).toBe(want.buffered);
        if (want.history !== undefined) expect(t!.to.history.size, `${phase}/${origin} × ${name} history`).toBe(want.history);
        expect((t!.effects ?? []).map((e) => e.type), `${phase}/${origin} × ${name} effects`).toEqual(want.effects ?? []);
      }
    }
  }
});

test("the rejoin path: origin is a variant of the bound phases, and the flush carries the response frame's barrier, the buffer, and the replay", () => {
  let s = initialStartState();
  const step = (ev: StartEvent) => { const t = nextStartState(s, ev); expect(t, ev.type).not.toBeNull(); s = t!.to; return t!.effects ?? []; };
  expect(step({ type: "start", canRejoin: true })).toEqual([]);
  expect(isRejoined(s)).toBe(false); // not until the thread is bound
  step({ type: "notification", n: N("turn/started"), seq: 1 });                       // before the read
  step({ type: "thread_resumed", threadId: "TH" });
  expect(isRejoined(s)).toBe(true);
  step({ type: "notification", n: N("item/completed", { turnId: "T1", item: { id: "a", type: "agentMessage" } }), seq: 2 }); // read in flight
  step({ type: "read_response", barrier: 2 });                                         // the frame: seq 2 is inside
  step({ type: "notification", n: N("item/completed", { turnId: "T1", item: { id: "b", type: "agentMessage" } }), seq: 3 }); // past the frame: new
  const items: HistoryItem[] = [{ id: "item-0", type: "agentMessage", ordinal: 0, sig: "x", matched: false }];
  step({ type: "history_replayed", turnId: "T1", items });
  const effects = step({ type: "reconcile_done" });
  expect(s.phase).toBe("live");
  expect(effects.map((e) => e.type)).toEqual(["flush", "ready"]);
  const flush = effects[0] as Extract<StartEffect, { type: "flush" }>;
  expect(flush.barrier).toBe(2);
  expect(flush.buffered.map((b) => b.seq)).toEqual([1, 2, 3]);
  expect(flush.history.get("T1")).toBe(items);
  // Live now: the next notification dispatches straight through.
  expect(step({ type: "notification", n: N("turn/completed"), seq: 4 })).toEqual([{ type: "dispatch", n: N("turn/completed") }]);
});

test("a rejoin that fails spawns fresh with the partial binding reset; a kill while the rejoin is pending spawns nothing (Astra on d4fc9336)", () => {
  let s = initialStartState();
  s = nextStartState(s, { type: "start", canRejoin: true })!.to;
  const failed = nextStartState(s, { type: "rejoin_failed", error: "x" })!;
  expect(failed.to).toMatchObject({ phase: "spawning", origin: null, threadId: null });
  expect(failed.effects).toEqual([{ type: "spawn" }]);
  // Killed while the rejoin was pending: the failure that then lands must not spawn.
  const killed = nextStartState(s, { type: "killed", reason: "killed" })!.to;
  expect(killed.phase).toBe("ended");
  expect(nextStartState(killed, { type: "rejoin_failed", error: "x" })!.effects).toEqual([{ type: "abandon" }]);
  // And a start step that completes after the kill owns nothing (d6b84547).
  expect(nextStartState(killed, { type: "thread_started", threadId: "TH" })!.effects).toEqual([{ type: "abandon" }]);
  expect(nextStartState(killed, { type: "notification", n: NOTE, seq: 1 })).toBeNull();
});

test("a fresh thread has no snapshot: thread_started goes straight to a barrier of 0 and the flush binds nothing", () => {
  let s = initialStartState();
  s = nextStartState(s, { type: "start", canRejoin: false })!.to;
  s = nextStartState(s, { type: "notification", n: N("thread/started"), seq: 1 })!.to;
  s = nextStartState(s, { type: "thread_started", threadId: "TH" })!.to;
  expect(s).toMatchObject({ phase: "snapshot_read", origin: "fresh", barrier: 0 });
  const flush = nextStartState(s, { type: "reconcile_done" })!.effects![0] as Extract<StartEffect, { type: "flush" }>;
  expect(flush.history.size).toBe(0);
  expect(flush.buffered.map((b) => b.n.method)).toEqual(["thread/started"]);
});

// ── bindBufferedItems: the #519 binding rules, as pure function ─────────────

const item = (turnId: string, type: string, id: string, extra: Record<string, unknown> = {}): Buffered["n"] =>
  N("item/completed", { turnId, item: { id, type, ...extra } });
const hist = (id: string, type: string, ordinal: number, sig: string): HistoryItem => ({ id, type, ordinal, sig, matched: false });
const bindsOf = (buffered: Buffered[], barrier: number, history: Map<string, HistoryItem[]>) => {
  const bound: string[] = [];
  bindBufferedItems(buffered, barrier, history, (t, ty, id, ord) => { bound.push(`${t}/${ty}/${id}→${ord}`); return true; });
  return bound;
};

test("only a completion within the barrier may bind; past it, the same content is a new occurrence", () => {
  const sameText = { text: "same" };
  const sig = (id: string) => hist(id, "agentMessage", 0, sigOf({ type: "agentMessage", id, ...sameText }));
  const history = new Map([["T1", [sig("item-0")]]]);
  expect(bindsOf([{ n: item("T1", "agentMessage", "new", sameText), seq: 3 }], 2, history)).toEqual([]);
  expect(bindsOf([{ n: item("T1", "agentMessage", "new", sameText), seq: 2 }], 2, new Map([["T1", [sig("item-0")]]]))).toEqual(["T1/agentMessage/new→0"]);
});

test("exact ids bind first; a repeated completion is one occurrence; a runtime-id history item is never content-matched", () => {
  const h = new Map([["T1", [
    hist("item-0", "agentMessage", 0, sigOf({ type: "agentMessage", id: "item-0", text: "A" })),
    hist("msg_real", "agentMessage", 1, sigOf({ type: "agentMessage", id: "msg_real", text: "A" })),
  ]]]);
  const bound = bindsOf([
    { n: item("T1", "agentMessage", "x", { text: "A" }), seq: 1 },   // content twin of item-0
    { n: item("T1", "agentMessage", "x", { text: "A" }), seq: 2 },   // a repeat: same occurrence
    { n: item("T1", "agentMessage", "msg_real", { text: "A" }), seq: 3 }, // named by id: reserved first
  ], 5, h);
  expect(bound).toEqual(["T1/agentMessage/msg_real→1", "T1/agentMessage/x→0"]);
});

function sigOf(it: Record<string, unknown>): string {
  // The history side stores itemSignature(item); reuse the real one so the
  // twin test is honest about what "whole content" means.
  return itemSignatureForTest(it);
}
import { itemSignature as itemSignatureForTest } from "./normalize";

// ── the delivered-turn mark ────────────────────────────────────────────────

test("the delivered mark: loaded shapes, rewind, deferred floor, and an ack that only ever advances", () => {
  const D = (ev: DeliveredEvent, s = initialDeliveredState()) => nextDeliveredState(s, ev);
  expect(new Set(["loaded", "cleared", "rewound", "deferred", "acked"])).toEqual(new Set(DELIVERED_EVENT_TYPES));
  expect(D({ type: "loaded", ref: null })!.to.mark).toEqual({ kind: "none" });
  expect(D({ type: "loaded", ref: "" })!.to.mark).toEqual({ kind: "pending" });
  expect(D({ type: "loaded", ref: "T5" })!.to.mark).toEqual({ kind: "committed", turnId: "T5" });
  expect(markRef({ kind: "pending" })).toBeNull();
  expect(isDelivered({ kind: "pending" }, "T1")).toBe(false);
  expect(isDelivered({ kind: "committed", turnId: "T5" }, "T4")).toBe(true);
  expect(isDelivered({ kind: "committed", turnId: "T5" }, "T6")).toBe(false);
  const committed = D({ type: "loaded", ref: "T5" })!.to;
  expect(D({ type: "rewound" }, committed)).toMatchObject({ to: { mark: { kind: "none" } }, clear: true });
  expect(D({ type: "rewound" })).toBeNull();
  expect(D({ type: "acked", turnId: "T4" }, committed)).toBeNull();              // never backwards
  expect(D({ type: "acked", turnId: "T6" }, committed)).toMatchObject({ commit: "T6" });
  const floored = D({ type: "deferred", turnId: "T7" }, committed)!.to;
  expect(D({ type: "deferred", turnId: "T8" }, floored)).toBeNull();               // the floor is the OLDEST deferred turn
  expect(D({ type: "deferred", turnId: "T6" }, floored)!.to.deferredFloor).toBe("T6");
  expect(D({ type: "acked", turnId: "T7" }, floored)).toBeNull();                 // never past the floor (#518)
  expect(D({ type: "acked", turnId: "T9" }, floored)).toBeNull();
  expect(D({ type: "acked", turnId: "T6" }, floored)).toMatchObject({ commit: "T6" });
  expect(D({ type: "acked", turnId: "" }, floored)).toBeNull();
  expect(D({ type: "cleared" }, committed)).toMatchObject({ to: { mark: { kind: "none" } }, clear: true });
});
