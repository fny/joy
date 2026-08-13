// /steer delivery-path tests (user report 2026-07-31: steered text sometimes
// shows as QUEUED or pops the paused warning). The steer contract: type into
// the pane and submit NOW, bypassing the dispatch queue — it must never appear
// as a queue chip. The ONE legitimate degradation: a pane whose input box has
// text that C-u cannot clear (stalled/damaged pane) parks the steer on the
// queue head and pauses with 'input_dirty' — that IS the warning users see.
import { test, expect, vi } from "vitest";

// Mutable pane the mocked driver serves; tests swap it mid-flight.
const state = { pane: "", keys: [] as string[], typed: [] as string[] };

vi.mock("../tmux/driver", () => ({
  tmux: {
    captureFresh: vi.fn(async () => ({ ok: true, out: state.pane })),
    captureCached: vi.fn(async () => ({ ok: true, out: state.pane })),
    key: vi.fn(async (_t: string, k: string) => { state.keys.push(k); return { ok: true, out: "" }; }),
    literal: vi.fn(async (_t: string, s: string) => { state.typed.push(s); return { ok: true, out: "" }; }),
    command: vi.fn(async () => ({ ok: true, out: "" })),
    commandOnce: vi.fn(async () => ({ ok: true, out: "" })),
    runSync: vi.fn(() => ({ ok: true, out: "" })),
    track: vi.fn(), untrack: vi.fn(),
  },
}));

import { Session } from "./session";

const READY_PANE = "──────\n❯\n──────\n";                    // empty input box
const DIRTY_PANE = "──────\n❯ stray residue text\n──────\n"; // box with text

function steerSession() {
  // UNIQUE id per instance: the durable dispatch queue (B1) persists by session
  // id in the real state dir — a reused id loads PRIOR RUNS' parked items and
  // fabricates phantom pending counts (that was the 'phantom' first seen here).
  const id = `st-${Math.random().toString(36).slice(2, 10)}`;
  return new Session(
    { id, tmuxWindow: `joy:j-${id}`, cwd: "/tmp/st", flags: [], status: "active", startedAt: 0 } as any,
    { relayClient: null, broadcast: () => {}, addChatMessage: () => {} } as any,
  );
}
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("steer: bypasses the queue — never a queue chip, submits after the delay", async () => {
  state.pane = READY_PANE; state.keys = []; state.typed = [];
  const s = steerSession();
  s.enqueue("/steer focus on the tests first");
  await settle(600); // > ENTER_SUBMIT_DELAY_MS (350)
  expect(s.queueState().queue).toEqual([]);        // no visible chip
  expect(s.queueState().pendingCount).toBe(0);      // not queued at all
  expect(s.queueState().paused).toBe(false);        // no warning banner
  expect(state.typed.join("")).toContain("focus on the tests first"); // typed to pane
  expect(state.keys).toContain("Enter");            // and submitted
});

test("steer: unclearable dirty box degrades to queue + input_dirty warning (the reported symptom)", async () => {
  state.pane = DIRTY_PANE; state.keys = []; state.typed = [];
  const s = steerSession();
  s.enqueue("/steer do the thing");
  // C-u clear attempts re-capture and keep seeing the dirty pane → gives up.
  await vi.waitFor(() => { expect(s.queueState().paused).toBe(true); }, { timeout: 20000, interval: 200 });
  expect(s.queueState().pauseReason).toBe("input_dirty");
  expect(s.queueState().pendingCount).toBe(1);      // steer parked on the queue head
  expect(state.typed.join("")).not.toContain("do the thing"); // never typed over residue
}, 25000);

test("steer: dirty box that C-u CAN clear steers normally (no warning)", async () => {
  state.pane = DIRTY_PANE; state.keys = []; state.typed = [];
  const s = steerSession();
  // First C-u observation clears the box: flip the pane when C-u arrives.
  const origPush = state.keys.push.bind(state.keys);
  state.keys.push = (k: string) => { if (k === "C-u") state.pane = READY_PANE; return origPush(k); };
  s.enqueue("/steer refactor carefully");
  await vi.waitFor(() => { expect(state.keys).toContain("Enter"); }, { timeout: 10000, interval: 100 });
  expect(s.queueState().paused).toBe(false);
  expect(s.queueState().pendingCount).toBe(0);
  expect(state.typed.join("")).toContain("refactor carefully");
}, 15000);
