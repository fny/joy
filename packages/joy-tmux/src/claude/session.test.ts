import { test, expect } from "vitest";
import { paneShowsReadyPrompt, paneShowsClaudeRunning, parsePermissionModeFromPane } from "./session";

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

test("claude running: ready input prompt", () => {
  expect(paneShowsClaudeRunning("────\n❯\n────\n  ⏵⏵ bypass permissions on")).toBe(true);
});

test("claude running: footer only (booting, prompt not painted yet)", () => {
  expect(paneShowsClaudeRunning("  ⏵⏵ bypass permissions on (shift+tab to cycle)")).toBe(true);
});

test("claude running: working line", () => {
  expect(paneShowsClaudeRunning("✻ Thinking… (esc to interrupt)")).toBe(true);
});

test("claude running: trust dialog is still 'up' (not a failed launch)", () => {
  expect(paneShowsClaudeRunning(" ❯ 1. Yes, I trust this folder")).toBe(true);
});

test("not running: shell prompt after a failed launch", () => {
  const pane = [
    "ubuntu@fny:~/Workspace/unconv$ claude --continue --dangerously-skip-permissions",
    "No conversation found to continue",
    "ubuntu@fny:~/Workspace/unconv$ ",
  ].join("\n");
  expect(paneShowsClaudeRunning(pane)).toBe(false);
});

test("footer → mode: strings captured from claude 2.1.170", () => {
  expect(parsePermissionModeFromPane("  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents")).toBe("bypassPermissions");
  expect(parsePermissionModeFromPane("  ⏵⏵ auto mode on (shift+tab to cycle)")).toBe("auto");
  expect(parsePermissionModeFromPane("  ⏵⏵ accept edits on (shift+tab to cycle)")).toBe("acceptEdits");
  expect(parsePermissionModeFromPane("  ⏸ plan mode on (shift+tab to cycle)")).toBe("plan");
  expect(parsePermissionModeFromPane("❯ \n? for shortcuts")).toBe("default");
});

import { encodeUserMessage, encodeTextEvent } from "../relay/relay";

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

import { summarizeCommandEcho } from "./session";

test("summarizeCommandEcho: slash, bash, noise", () => {
  expect(summarizeCommandEcho("<command-name>model</command-name><command-args>opus</command-args>")).toBe("/model opus");
  expect(summarizeCommandEcho("<command-message>/clear</command-message>")).toBe("/clear");
  expect(summarizeCommandEcho("<bash-input>ls -la</bash-input><bash-stdout>x</bash-stdout>")).toBe("$ ls -la");
  expect(summarizeCommandEcho("<local-command-stdout>line1\nline2</local-command-stdout>")).toBe("$ line1");
  expect(summarizeCommandEcho("<command-name></command-name>")).toBeNull();
});

// Stuck-thinking fix: a turn that ends in an API error has no end_turn
// stop_reason, so only `turn_duration` clears `thinking`; and the api_error
// itself is surfaced once per turn as an agent note instead of hanging silently.
test("api_error surfaced once per turn; turn_duration clears thinking", () => {
  const thinkingCalls: boolean[] = [];
  const notes: string[] = [];
  const s = new Session(
    { id: "e1", tmuxWindow: "joy:j-e1", cwd: "/tmp/e", flags: [], status: "active", startedAt: 0, claudeSessionId: "sid-1" } as any,
    { relayClient: null, broadcast: () => {}, addChatMessage: (m: any) => { if (m.role === "assistant") notes.push(String(m.content)); } } as any,
  );
  const rs: any = {
    relaySessionId: "rs-e1",
    start() {}, stop() {}, send() {},
    setThinking(v: boolean) { thinkingCalls.push(v); },
  };
  s.attachRelay(rs, true);

  const apiErr = (attempt: number) => s.onTranscriptEntry({
    type: "system", subtype: "api_error",
    error: { formatted: "401 Invalid authentication credentials", status: 401 },
    retryAttempt: attempt, maxRetries: 10,
  } as any);

  apiErr(1); apiErr(2); // Claude retries — should note only once
  expect(notes.filter(n => n.includes("API error")).length).toBe(1);
  expect(thinkingCalls.includes(false)).toBe(false); // not cleared mid-retry

  s.onTranscriptEntry({ type: "system", subtype: "turn_duration", durationMs: 2000 } as any);
  expect(thinkingCalls.includes(false)).toBe(true); // turn end clears thinking
});
