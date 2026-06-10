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

import { Session } from "./session";

function stubDeps(chat: any[]) {
  return {
    relayClient: null,
    broadcast: () => {},
    addChatMessage: (m: any) => { chat.push(m); },
  };
}

test("resume replay: entries before mirrorFromMs are not mirrored, newer ones are", () => {
  const chat: any[] = [];
  const cutoff = Date.parse("2026-06-10T12:00:00Z");
  const s = new Session({
    id: "abcd1234", tmuxWindow: "joy:dd-abcd1234", cwd: "/tmp/x",
    flags: [], status: "starting", startedAt: cutoff, mirrorFromMs: cutoff,
  }, stubDeps(chat) as any);

  // First (old, replayed) entry still activates the session...
  s.onTranscriptEntry({ type: "user", timestamp: "2026-06-10T09:00:00Z", sessionId: "sess-x",
    message: { role: "user", content: "old replayed prompt" } });
  expect(s.status).toBe("active");
  // ...but is NOT mirrored to the chat log (it predates mirrorFromMs).
  expect(chat.length).toBe(0);

  // Another old entry: still skipped.
  s.onTranscriptEntry({ type: "user", timestamp: "2026-06-10T10:30:00Z",
    message: { role: "user", content: "another old one" } });
  expect(chat.length).toBe(0);

  // A genuinely new entry (after the resume) is mirrored normally.
  s.onTranscriptEntry({ type: "user", timestamp: "2026-06-10T12:00:05Z",
    message: { role: "user", content: "fresh message" } });
  expect(chat.length).toBe(1);
  expect(chat[0].content).toBe("fresh message");
});

test("no cutoff (fresh session): all entries mirror", () => {
  const chat: any[] = [];
  const s = new Session({
    id: "ef567890", tmuxWindow: "joy:dd-ef567890", cwd: "/tmp/y",
    flags: [], status: "starting", startedAt: Date.parse("2026-06-10T12:00:00Z"),
  }, stubDeps(chat) as any);
  s.onTranscriptEntry({ type: "user", timestamp: "2026-06-10T09:00:00Z", sessionId: "sess-y",
    message: { role: "user", content: "should still mirror" } });
  expect(chat.length).toBe(1);
});
