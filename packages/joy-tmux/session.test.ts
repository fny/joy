import { test, expect } from "bun:test";
import { paneShowsReadyPrompt, parsePermissionModeFromPane } from "./session";

test("ready: bare input prompt", () => {
  expect(paneShowsReadyPrompt("────\n❯\n────\n  ⏵⏵ bypass permissions on")).toBe(true);
});

test("ready: ghost-text suggestion", () => {
  expect(paneShowsReadyPrompt('────\n❯ Try "refactor <filepath>"\n────')).toBe(true);
});

test("not ready: folder trust selector dialog", () => {
  const pane = [
    "Quick safety check: Is this a project you created or one you trust?",
    " ❯ 1. Yes, I trust this folder",
    "   2. No, exit",
    "Enter to confirm · Esc to cancel",
  ].join("\n");
  expect(paneShowsReadyPrompt(pane)).toBe(false);
});

test("not ready: bash prompt before claude starts", () => {
  expect(paneShowsReadyPrompt("claude@host:/tmp/proj$ claude --dangerously-skip-permissions\n")).toBe(false);
});

test("ready: user message echoed at prompt", () => {
  expect(paneShowsReadyPrompt("● Hi! What can I help with?\n\n❯ hello there\n")).toBe(true);
});

test("footer → mode: strings captured from claude 2.1.170", () => {
  expect(parsePermissionModeFromPane("  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents")).toBe("bypassPermissions");
  expect(parsePermissionModeFromPane("  ⏵⏵ auto mode on (shift+tab to cycle)")).toBe("auto");
  expect(parsePermissionModeFromPane("  ⏵⏵ accept edits on (shift+tab to cycle)")).toBe("acceptEdits");
  expect(parsePermissionModeFromPane("  ⏸ plan mode on (shift+tab to cycle)")).toBe("plan");
  expect(parsePermissionModeFromPane("❯ \n? for shortcuts")).toBe("default");
});

import { encodeUserMessage, encodeTextEvent } from "./relay";

// Single-clock ordering fix: both sides stamped with Claude's transcript time
// so a --resume replay sorts chronologically instead of splitting by the
// daemon/relay clock skew.
test("user message carries Claude's transcript time as joyTime", () => {
  const t = Date.parse("2026-06-10T09:00:00Z");
  const rec = encodeUserMessage("hello", t) as any;
  expect(rec.role).toBe("user");
  expect(rec.meta.joyTime).toBe(t);
  expect(rec.meta.sentFrom).toBe("joy");
});

test("agent event embeds the supplied transcript time (not now)", () => {
  const t = Date.parse("2026-06-10T09:00:05Z");
  const rec = encodeTextEvent("hi there", { turn: "turn-1", time: t }) as any;
  expect((rec.content.data as any).time).toBe(t);
});

test("agent event falls back to a fresh timestamp when time omitted", () => {
  const before = Date.now();
  const rec = encodeTextEvent("hi", { turn: "turn-1" }) as any;
  expect((rec.content.data as any).time).toBeGreaterThanOrEqual(before);
});

import { Session } from "./session";

function qSession() {
  // status 'starting' so enqueue's drain check short-circuits before any tmux call.
  return new Session(
    { id: "q1", tmuxWindow: "joy:dd-q1", cwd: "/tmp/q", flags: [], status: "starting", startedAt: 0 },
    { relayClient: null, broadcast: () => {}, addChatMessage: () => {} } as any,
  );
}

test("queue: enqueue / list / edit / cancel", () => {
  const s = qSession();
  const a = s.enqueue("first");
  const b = s.enqueue("second");
  expect(s.queueState().queue.map(q => q.text)).toEqual(["first", "second"]);
  expect(s.queueState().inFlight).toBeNull();
  expect(s.queueState().paused).toBe(false);

  expect(s.editQueued(a.id, "FIRST")).toBe(true);
  expect(s.editQueued("nope", "x")).toBe(false);
  expect(s.queueState().queue.map(q => q.text)).toEqual(["FIRST", "second"]);

  expect(s.cancelQueued(a.id)).toBe(true);
  expect(s.queueState().queue.map(q => q.text)).toEqual(["second"]);
  expect(s.cancelQueued(a.id)).toBe(false); // already gone
  void b;
});

test("queue: reorder clamps and moves", () => {
  const s = qSession();
  const a = s.enqueue("a");
  s.enqueue("b");
  s.enqueue("c");
  expect(s.reorderQueued(a.id, 2)).toBe(true);
  expect(s.queueState().queue.map(q => q.text)).toEqual(["b", "c", "a"]);
  // clamp beyond end
  expect(s.reorderQueued(a.id, 99)).toBe(true);
  expect(s.queueState().queue.map(q => q.text)).toEqual(["b", "c", "a"]);
});

test("queue: resume clears paused, clearQueue empties", () => {
  const s = qSession();
  s.enqueue("x");
  s.resumeQueue();
  expect(s.queueState().paused).toBe(false);
  s.clearQueue();
  expect(s.queueState().queue).toEqual([]);
});
