import { test, expect } from "vitest";
import { paneShowsReadyPrompt, paneShowsClaudeRunning, paneShowsWorking, paneShowsGenerating, paneInputText, paneShowsEmptyReadyPrompt, parsePermissionModeFromPane, formatRetryDelay, parseJoyCommand, flattenForMatch, bgTaskEvent, goalStatusFromEntry, authUrlFromPane, loginFromPane, joyBgLongRunningIds, classifyBgTasks } from "./session";

test("flattenForMatch: collapses every newline form to a space (dedup key)", () => {
  expect(flattenForMatch("a\nb")).toBe("a b");
  expect(flattenForMatch("a\r\nb")).toBe("a b");
  expect(flattenForMatch("a\rb")).toBe("a b");
  expect(flattenForMatch("line1\nline2\nline3")).toBe("line1 line2 line3");
  expect(flattenForMatch("no newlines")).toBe("no newlines");
  // collapse repeated whitespace + trim, so trailing/normalized echo whitespace matches
  expect(flattenForMatch("foo\n\n")).toBe("foo");
  expect(flattenForMatch("  a   b\t\nc  ")).toBe("a b c");
});

test("parseJoyCommand: /steer splits name + args", () => {
  expect(parseJoyCommand("/steer while you're at it do X")).toEqual({ name: "steer", args: "while you're at it do X" });
});
test("parseJoyCommand: /title splits name + args", () => {
  expect(parseJoyCommand("/title My Session Name")).toEqual({ name: "title", args: "My Session Name" });
});
test("parseJoyCommand: name is lowercased, args keep their case", () => {
  expect(parseJoyCommand("/Steer DO This")).toEqual({ name: "steer", args: "DO This" });
});
test("parseJoyCommand: bare /steer has empty args", () => {
  expect(parseJoyCommand("/steer")).toEqual({ name: "steer", args: "" });
});
test("parseJoyCommand: a NON-joy slash command passes through (null)", () => {
  expect(parseJoyCommand("/compact")).toBeNull();       // Claude's own command
  expect(parseJoyCommand("/clear extra")).toBeNull();   // Claude's own command
  expect(parseJoyCommand("/usr/local/bin")).toBeNull(); // not a joy command name
  expect(parseJoyCommand("//steer x")).toBeNull();      // double slash is not the syntax
});
test("parseJoyCommand: plain text / mid-text slashes are not commands", () => {
  expect(parseJoyCommand("hello /title is cool")).toBeNull();
  expect(parseJoyCommand("see http://x")).toBeNull();
  expect(parseJoyCommand("")).toBeNull();
});

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

test("ready: live box ignored among scrollback echoes of past messages", () => {
  // Real-world shape: Claude echoes past user inputs as "❯ …" in history; only the
  // live box has a rule directly above it. Must match the box, not the echoes.
  const pane = [
    "❯ say hi in one short sentence",   // scrollback echo — must be ignored
    "● done",
    "─────────────────",
    "❯ ",                                // the LIVE input box
    "─────────────────",
    "  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents",
  ].join("\n");
  expect(paneShowsReadyPrompt(pane)).toBe(true);
});

test("not ready: only scrollback echoes, no live box (no border above ❯)", () => {
  const pane = [
    "● Hi! What can I help with?",
    "",
    "❯ hello there",                     // echoed past message, no border → not live
  ].join("\n");
  expect(paneShowsReadyPrompt(pane)).toBe(false);
});

// ── paneInputText / paneShowsEmptyReadyPrompt (dispatch empty-input gate) ──────

test("input text: empty box (real claude shape: ❯ + nbsp cursor) → ''", () => {
  // Live-pane empty box: "❯" followed only by whitespace (a space + the cursor's
  // non-breaking space). Whitespace collapses to nothing → reads as empty.
  const pane = "────────\n❯  \n────────\n  ⏵⏵ bypass permissions on";
  expect(paneInputText(pane)).toBe("");
  expect(paneShowsEmptyReadyPrompt(pane)).toBe(true);
});

test("input text: bare ❯ box → ''", () => {
  expect(paneInputText("────\n❯\n────")).toBe("");
  expect(paneShowsEmptyReadyPrompt("────\n❯\n────")).toBe(true);
});

test("input text: stuck text in the box is returned (concat-bug trigger)", () => {
  // The S5 repro: a long message typed-but-not-submitted sits in the box. The
  // gate must see it as NON-empty so it never types a second message on top.
  const pane = [
    "✻ Brewed for 43s",
    "────────",
    "❯ ABORTTEST: Write a detailed 8-paragraph essay",
    "────────",
    "  ⏵⏵ bypass permissions on · ← for agents",
  ].join("\n");
  expect(paneInputText(pane)).toBe("ABORTTEST: Write a detailed 8-paragraph essay");
  expect(paneShowsEmptyReadyPrompt(pane)).toBe(false);
});

test("input text: ghost-text placeholder counts as empty", () => {
  const pane = '────\n❯ Try "refactor <filepath>"\n────';
  expect(paneInputText(pane)).toBe("");
  expect(paneShowsEmptyReadyPrompt(pane)).toBe(true);
});

test("input text: MULTI-line box reads the whole box, not just the ❯ line", () => {
  const pane = ["────────", "❯ line one", "  line two", "  line three", "────────", "  ⏵⏵ bypass permissions on"].join("\n");
  expect(paneInputText(pane)).toBe("line one line two line three");
  expect(paneShowsEmptyReadyPrompt(pane)).toBe(false);
});

test("input text: multi-line box with a BLANK first line is still NON-empty (blind-spot fix)", () => {
  // A message starting with a newline: ❯ line is blank, content is below. Must NOT read
  // as empty (else the gate would dispatch + concatenate on top).
  const pane = ["────────", "❯ ", "  second line", "────────", "  ⏵⏵ bypass permissions on"].join("\n");
  expect(paneInputText(pane)).toBe("second line");
  expect(paneShowsEmptyReadyPrompt(pane)).toBe(false);
});

test("input text: empty box stays empty — footer below the rule is NOT collected", () => {
  // Regression guard: the whole-box read must stop at the bottom rule and never treat
  // the permission footer as box content (a false non-empty → a spurious C-c on empty).
  const pane = ["────────", "❯ ", "────────", "  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents"].join("\n");
  expect(paneInputText(pane)).toBe("");
  expect(paneShowsEmptyReadyPrompt(pane)).toBe(true);
});

test("generating: esc-to-interrupt true; idle prompt + bg shells false (dispatch gate)", () => {
  // The dispatch gate must hold while a turn streams, even before #turn is set...
  expect(paneShowsGenerating("✻ Ruminating… (esc to interrupt)")).toBe(true);
  expect(paneShowsGenerating("────\n❯ \n────\n  ⏵⏵ bypass · esc to interrupt")).toBe(true);
  // ...but an idle prompt is dispatchable, and a lingering BACKGROUND shell must
  // NOT block dispatch (Claude is idle at the prompt, can take the next message).
  expect(paneShowsGenerating("────\n❯ \n────\n  ⏵⏵ bypass permissions on · ← for agents")).toBe(false);
  expect(paneShowsGenerating("────\n❯ \n────\n  ⏵⏵ bypass · 1 shell · ↓ to manage")).toBe(false);
});

test("input text: no live box → null (and not 'empty')", () => {
  const pane = ["● Hi! What can I help with?", "", "❯ hello there"].join("\n");
  expect(paneInputText(pane)).toBe(null);
  expect(paneShowsEmptyReadyPrompt(pane)).toBe(false); // null !== "" → not safe to type
});

test("input text: selector option row is not the input box", () => {
  const pane = ["Is this a project you trust?", "────", "❯ 1. Yes", "   2. No"].join("\n");
  // The "❯ 1." line is a selector option, skipped; no real input box → null.
  expect(paneInputText(pane)).toBe(null);
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

test("working: actively generating shows the interrupt hint", () => {
  expect(paneShowsWorking("✽ Cultivating… (5s · esc to interrupt)")).toBe(true);
  expect(paneShowsWorking("────\n❯\n────\n  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt")).toBe(true);
});

test("not working: idle ready prompt is not 'thinking'", () => {
  expect(paneShowsWorking("────\n❯\n────\n  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents")).toBe(false);
});

test("not working: an interactive picker is waiting, not generating", () => {
  const pane = [
    "How should I roll out the PRs?",
    " ❯ 1. One at a time",
    "   2. All at once",
    "Enter to confirm",
  ].join("\n");
  expect(paneShowsWorking(pane)).toBe(false);
});

test("working: idle prompt but background shells still running", () => {
  // Turn ended (ready prompt), but a bg task runs → footer shows "· N shell · ↓ to manage".
  expect(paneShowsWorking("────\n❯\n────\n  ⏵⏵ bypass permissions on · 1 shell · ← for agents · ↓ to manage")).toBe(true);
  expect(paneShowsWorking("  ⏵⏵ bypass · 3 shells · ↓ to manage")).toBe(true);
});

test("not working: prose mentioning shells doesn't false-positive", () => {
  // The footer anchors (middle dot / ↓ to manage) keep ordinary output from matching.
  expect(paneShowsWorking("● I ran 3 shell commands to set things up.\n\n❯ \n  ⏵⏵ bypass · ← for agents")).toBe(false);
});

test("not working: stale '· N shell still running' in scrollback (regression)", () => {
  // A finished bg task leaves its progress line ("✻ Baked for 4s · 1 shell still
  // running") in scrollback. Only the live ⏵⏵ footer is idle → must NOT read as
  // working, or the session is stuck "thinking" forever.
  const pane = [
    "  Ran 1 shell command",
    "✻ Baked for 4s · 1 shell still running",
    "● Done.",
    "❯ ",
    "────",
    "  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents",
  ].join("\n");
  expect(paneShowsWorking(pane)).toBe(false);
});

test("not working: completed-agent '↓ to manage' footer lingering in SCROLLBACK (regression)", () => {
  // After a subagent/Task run finishes, the live footer goes idle (← for agents)
  // but the old "↓ to manage" agent footer scrolls into history ABOVE the input
  // box. Matching it anywhere left the session stuck "thinking"; scoping to the
  // live footer (below the box) fixes it. (Observed live in S8.)
  const pane = [
    "✻ Waiting for 1 background agent to finish · ↓ to manage", // scrollback (old footer)
    "● Agent \"Count files in cwd\" came to rest · 14s",
    "● SUBAGENTS file_count=1 SUBDONE",
    "────────",
    "❯ ",                                                         // live idle box (rule above)
    "────────",
    "  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents",
  ].join("\n");
  expect(paneShowsWorking(pane)).toBe(false);
});

test("working: live background footer BELOW the idle box still counts", () => {
  // Genuine background work after a turn ends: the LIVE footer (below the box)
  // shows the shells/manage markers → still working.
  const pane = [
    "● finished the foreground reply",
    "────────",
    "❯ ",
    "────────",
    "  ⏵⏵ bypass permissions on · 1 shell · ↓ to manage",
  ].join("\n");
  expect(paneShowsWorking(pane)).toBe(true);
});

test("working: background tasks detected mode-agnostically (plan / default)", () => {
  // Plan mode uses ⏸ instead of ⏵⏵ — the footer must still be recognised.
  expect(paneShowsWorking("❯\n────\n  ⏸ plan mode on (shift+tab to cycle) · 1 shell · ↓ to manage")).toBe(true);
  // Default mode shows no permission glyph at all; the "for agents" / "to manage"
  // hints still mark it as the live footer.
  expect(paneShowsWorking("❯\n────\n  · 2 shells · ← for agents · ↓ to manage")).toBe(true);
});

test("not working: narrow-pane truncated footer under-reports (accepted)", () => {
  // At ~20 cols the footer truncates and drops the shell/manage tokens. We accept
  // the false-negative (status briefly idle) over a stuck-working false-positive.
  const pane = ["❯", "────", "  ⏵⏵ bypass ·"].join("\n");
  expect(paneShowsWorking(pane)).toBe(false);
});

test("not running: shell prompt after a failed launch", () => {
  const pane = [
    "ubuntu@fny:~/Workspace/unconv$ claude --continue --dangerously-skip-permissions",
    "No conversation found to continue",
    "ubuntu@fny:~/Workspace/unconv$ ",
  ].join("\n");
  expect(paneShowsClaudeRunning(pane)).toBe(false);
});

test("formatRetryDelay: seconds under a minute, minutes above", () => {
  expect(formatRetryDelay(15)).toBe("15s");
  expect(formatRetryDelay(30)).toBe("30s");
  expect(formatRetryDelay(60)).toBe("1m");
  expect(formatRetryDelay(120)).toBe("2m");
  expect(formatRetryDelay(960)).toBe("16m");
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
  // status 'ended' so #maybeDrainQueue short-circuits before any tmux call —
  // these tests exercise only the queue array ops (enqueue/list/edit/cancel/
  // reorder/resume/clear), not dispatch. ('starting' now drains too, gated on the
  // empty ready box, so it would attempt a tmux capture here.)
  return new Session(
    { id: "q1", tmuxWindow: "joy:dd-q1", cwd: "/tmp/q", flags: [], status: "ended", startedAt: 0 },
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

test("queue: hidden (relay/send/retry) items don't surface as editable chips", () => {
  const s = qSession();
  s.enqueue("visible one");                                                  // default visible:true
  s.enqueue("hidden relay msg", { visible: false, source: "relay", mirrorToRelay: false, seq: 7 });
  s.enqueue("visible two");
  // Only visible items appear in the wire queue state — a relay app-send already
  // has its own chat bubble, so showing it as an editable chip would be a dup.
  expect(s.queueState().queue.map(q => q.text)).toEqual(["visible one", "visible two"]);
  // enqueue still returns the slim wire shape for every item.
  const r = s.enqueue("another", { visible: false });
  expect(Object.keys(r).sort()).toEqual(["createdAt", "id", "text"]);
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
    updateRetry() {},
    updateQueue() {},
    async updateBgTasks() {},
    async updateContext() {},
    updateCompacting() {},
    updateGoal() {},
    notify() {},
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

test("compacting: PreCompact mark sets the banner, compact_boundary clears it", () => {
  const compactingCalls: (object | null)[] = [];
  const s = new Session(
    { id: "c1", tmuxWindow: "joy:j-c1", cwd: "/tmp/c", flags: [], status: "active", startedAt: 0, claudeSessionId: "sid-c1" } as any,
    { relayClient: null, broadcast: () => {}, addChatMessage: () => {} } as any,
  );
  const rs: any = {
    relaySessionId: "rs-c1",
    start() {}, stop() {}, send() {},
    setThinking() {}, updateRetry() {}, updateQueue() {}, async updateBgTasks() {}, async updateContext() {}, updateGoal() {},
    updateCompacting(info: any) { compactingCalls.push(info); },
    notify() {},
  };
  s.attachRelay(rs, true);
  // attach reconciles a stale banner — none is live, so it clears (null).
  expect(compactingCalls).toEqual([null]);

  // PreCompact hook fired → /compacting route → markCompacting.
  s.markCompacting("auto");
  expect(compactingCalls.at(-1)).toMatchObject({ trigger: "auto" });

  // Claude writes the compact_boundary marker on completion → clears the banner.
  s.onTranscriptEntry({ type: "system", subtype: "compact_boundary", compactMetadata: { trigger: "auto" } } as any);
  expect(compactingCalls.at(-1)).toBe(null);
});

// ── bgTaskEvent: launch/complete detection (single source of truth) ──────────
const userEntry = (extra: Record<string, unknown>) => ({ message: { role: "user", ...extra } });

test("bgTaskEvent: run_in_background launch (backgroundTaskId)", () => {
  const e = { message: { role: "user", content: [{ type: "tool_result" }] }, toolUseResult: { backgroundTaskId: "bg-1" } };
  expect(bgTaskEvent(e)).toEqual({ kind: "launch", id: "bg-1" });
});

test("bgTaskEvent: async agent launch (isAsync + agentId)", () => {
  const e = { message: { role: "user", content: [{ type: "tool_result" }] }, toolUseResult: { isAsync: true, agentId: "ag-9" } };
  expect(bgTaskEvent(e)).toEqual({ kind: "launch", id: "ag-9" });
});

test("bgTaskEvent: completion via <task-notification>", () => {
  const e = userEntry({ content: "<task-notification><task-id>bg-1</task-id> done</task-notification>" });
  expect(bgTaskEvent(e)).toEqual({ kind: "complete", id: "bg-1" });
});

test("bgTaskEvent: completion via TaskStop tool_result (explicitly stopped task)", () => {
  // A stopped task never gets a <task-notification> — the TaskStop result is
  // its completion. Without this, a stopped <joy-bg long-running> server
  // leaves joy__longRunning stuck forever (found live by the e2e suite).
  const e = {
    message: { role: "user", content: [{ type: "tool_result" }] },
    toolUseResult: { message: "Successfully stopped task: b30k2oxtm (python3 -m http.server 8931)", task_id: "b30k2oxtm", task_type: "local_bash", command: "python3 -m http.server 8931" },
  };
  expect(bgTaskEvent(e)).toEqual({ kind: "complete", id: "b30k2oxtm" });
});

test("bgTaskEvent: completion via attachment-form notification (newer Claude)", () => {
  // Newer Claude delivers the notification as an attachment entry, not a user
  // message — attachment.prompt holds the payload. This is the common case that
  // left counts stuck before the fix.
  const e = {
    type: "attachment",
    attachment: {
      type: "queued_command",
      commandMode: "task-notification",
      prompt: "<task-notification>\n<task-id>bg-7</task-id>\n<status>failed</status>\n</task-notification>",
    },
  };
  expect(bgTaskEvent(e)).toEqual({ kind: "complete", id: "bg-7" });
});

test("joyBgLongRunningIds: extracts ids from assistant <joy-bg long-running> tags", () => {
  const entry = { message: { role: "assistant", content: [
    { type: "text", text: "Started it.\n<joy-bg id=\"bnfgnx0r\" long-running label=\"Nuxt dev\" />" },
  ] } };
  expect(joyBgLongRunningIds(entry)).toEqual(["bnfgnx0r"]);
  // attribute order independence + multiple tags + string content
  expect(joyBgLongRunningIds({ message: { role: "assistant", content:
    "<joy-bg long-running id=\"a\" /> and <joy-bg id=\"b\" long-running />" } })).toEqual(["a", "b"]);
});

test("joyBgLongRunningIds: ignores non-long-running tags, non-assistant, and no tag", () => {
  // A joy-bg without long-running (would be a finishing task) → not returned
  expect(joyBgLongRunningIds({ message: { role: "assistant", content: "<joy-bg id=\"x\" />" } })).toEqual([]);
  expect(joyBgLongRunningIds({ message: { role: "user", content: "<joy-bg id=\"x\" long-running />" } })).toEqual([]);
  expect(joyBgLongRunningIds({ message: { role: "assistant", content: "no tags here" } })).toEqual([]);
  expect(joyBgLongRunningIds({})).toEqual([]);
});

test("classifyBgTasks: splits finishing (N/M) from long-running, excludes servers from the count", () => {
  const L = (id: string) => ({ kind: "launch" as const, id });
  const C = (id: string) => ({ kind: "complete" as const, id });
  // b1,b2 finishing; srv is long-running (tagged). srv never counts in total/done.
  const r = classifyBgTasks([L("b1"), L("srv"), L("b2"), C("b1")], new Set(["srv"]));
  expect({ total: r.total, done: r.done, outstanding: [...r.outstanding], longRunning: [...r.longRunning] })
    .toEqual({ total: 2, done: 1, outstanding: ["b2"], longRunning: ["srv"] });
});

test("classifyBgTasks: long-running classified even when its launch precedes the tag (full lrIds up front)", () => {
  // The tag lands later in the transcript, but lrIds is gathered first, so the
  // earlier launch is still classified as long-running (never in the N/M).
  const r = classifyBgTasks([{ kind: "launch", id: "srv" }], new Set(["srv"]));
  expect(r.total).toBe(0);
  expect([...r.longRunning]).toEqual(["srv"]);
});

test("classifyBgTasks: an aborted task (launch dropped, per #deriveBgTasks cancel-filter) clears the count", () => {
  const L = (id: string) => ({ kind: "launch" as const, id });
  const C = (id: string) => ({ kind: "complete" as const, id });
  // b1 launched but interrupted before completing (its complete never lands). On
  // abort, #deriveBgTasks drops b1's events (it's in #cancelledBgTasks); b2, sent
  // after the abort, still counts. This mirrors that filter+classify composition.
  const cancelled = new Set(["b1"]);
  const events = [L("b1"), L("b2"), C("b2")];
  const live = events.filter((e) => !cancelled.has(e.id));
  const r = classifyBgTasks(live, new Set());
  expect({ total: r.total, done: r.done, outstanding: [...r.outstanding] })
    .toEqual({ total: 1, done: 1, outstanding: [] });
});

test("classifyBgTasks: stopping a server clears it; finishing batch resets on empty (servers don't block it)", () => {
  const L = (id: string) => ({ kind: "launch" as const, id });
  const C = (id: string) => ({ kind: "complete" as const, id });
  // batch1: b1 launches+completes → outstanding empties. srv (long-running) stays.
  // batch2: b2 launches → total resets to 1 (not 2), even though srv is still live.
  const r = classifyBgTasks([L("b1"), L("srv"), C("b1"), L("b2")], new Set(["srv"]));
  expect({ total: r.total, done: r.done, outstanding: [...r.outstanding], longRunning: [...r.longRunning] })
    .toEqual({ total: 1, done: 0, outstanding: ["b2"], longRunning: ["srv"] });
  // now stop the server:
  const r2 = classifyBgTasks([L("srv"), C("srv")], new Set(["srv"]));
  expect([...r2.longRunning]).toEqual([]);
});

test("bgTaskEvent: ignores non-task entries, meta, and non-user roles", () => {
  expect(bgTaskEvent(userEntry({ content: "hello" }))).toBeNull();                       // plain user text
  expect(bgTaskEvent({ message: { role: "assistant", content: "hi" } })).toBeNull();      // assistant
  expect(bgTaskEvent({ message: { role: "user", content: "x" }, isMeta: true })).toBeNull(); // meta
  expect(bgTaskEvent({ message: { role: "user", content: [{ type: "tool_result" }] } })).toBeNull(); // result, no bg
  expect(bgTaskEvent({})).toBeNull();
});

// ── authUrlFromPane: detect + reassemble an interactive login URL ─────────────

test("authUrlFromPane: reassembles a hard-wrapped Claude /login OAuth URL", () => {
  // Verbatim shape of Claude Code's /login box (URL wrapped across lines).
  const pane = [
    "   Login",
    "",
    "   Browser didn't open? Use the url below to (c to",
    "   sign in                                   copy)",
    "",
    "https://claude.com/cai/oauth/authorize?code=true&client_id",
    "=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&r",
    "edirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fco",
    "de%2Fcallback&scope=org%3Acreate_api_key+user%3Aprofile+us",
    "er%3Ainference&code_challenge=tNFRLVJwfcDCdSYxyP",
    "58l9xqemOf-ihKKsgqGQBHvAM&code_challenge_method=S256&state",
    "=E9TOZySSNrscarosv72pBT0o9pjqrGzhMjglIMrAEo8",
    "",
    "   Paste code here if prompted >",
    "",
    "   Esc to cancel",
  ].join("\n");
  expect(authUrlFromPane(pane)).toBe(
    "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=org%3Acreate_api_key+user%3Aprofile+user%3Ainference&code_challenge=tNFRLVJwfcDCdSYxyP58l9xqemOf-ihKKsgqGQBHvAM&code_challenge_method=S256&state=E9TOZySSNrscarosv72pBT0o9pjqrGzhMjglIMrAEo8",
  );
});

test("authUrlFromPane: ignores a non-auth URL in normal output, and empty panes", () => {
  expect(authUrlFromPane("see https://example.com/docs for details")).toBeNull();
  expect(authUrlFromPane("⏺ done\n❯ ")).toBeNull();
  expect(authUrlFromPane("")).toBeNull();
});

test("authUrlFromPane: detects a single-line device-login URL", () => {
  expect(authUrlFromPane("Open https://github.com/login/device and enter CODE"))
    .toBe("https://github.com/login/device");
});

test("loginFromPane: surfaces a rejection below the URL, but NOT the 401 trigger above it", () => {
  const pane = [
    "⏺ Please run /login · API Error: 401 Invalid authentication credentials",
    "",
    "https://claude.com/cai/oauth/authorize?code_challenge=abc&state=xyz",
    "",
    "   Invalid code, please try again",
    "   Paste code here if prompted >",
  ].join("\n");
  const r = loginFromPane(pane);
  expect(r?.url).toBe("https://claude.com/cai/oauth/authorize?code_challenge=abc&state=xyz");
  expect(r?.error).toBe("Invalid code, please try again"); // the box line, not the 401 above
});

test("loginFromPane: no error when the box is clean", () => {
  const pane = "https://claude.com/cai/oauth/authorize?code_challenge=abc\n\n   Paste code here if prompted >";
  expect(loginFromPane(pane)).toEqual({ url: "https://claude.com/cai/oauth/authorize?code_challenge=abc", error: undefined });
});

// Pure replay of the same reset-on-empty-batch semantics #deriveBgTasks uses,
// so the count derived from a transcript matches the live tally.
function replay(events: Array<{ kind: "launch" | "complete"; id: string }>) {
  const outstanding = new Set<string>();
  let total = 0, done = 0;
  for (const ev of events) {
    if (ev.kind === "launch") {
      if (outstanding.has(ev.id)) continue;
      if (outstanding.size === 0) { total = 0; done = 0; }
      outstanding.add(ev.id); total++;
    } else if (outstanding.delete(ev.id)) { done++; }
  }
  return { outstanding: [...outstanding], total, done };
}

test("derive semantics: stuck batch when a completion never arrives", () => {
  // two launched, one completed → 1/2 outstanding (the orphan shape)
  expect(replay([
    { kind: "launch", id: "a" }, { kind: "launch", id: "b" }, { kind: "complete", id: "a" },
  ])).toEqual({ outstanding: ["b"], total: 2, done: 1 });
});

test("derive semantics: a fully-drained batch clears (next launch resets the count)", () => {
  expect(replay([
    { kind: "launch", id: "a" }, { kind: "complete", id: "a" },
    { kind: "launch", id: "b" },
  ])).toEqual({ outstanding: ["b"], total: 1, done: 0 });
});

// ── goalStatusFromEntry: /goal transcript attachment detection ───────────────
test("goalStatusFromEntry: active goal (met=false)", () => {
  const e = { type: "attachment", attachment: { type: "goal_status", met: false, sentinel: true, condition: "keep going until I clear it" } };
  expect(goalStatusFromEntry(e)).toEqual({ condition: "keep going until I clear it", met: false });
});
test("goalStatusFromEntry: satisfied/cleared goal (met=true)", () => {
  const e = { type: "attachment", attachment: { type: "goal_status", met: true, condition: "analyze the project", reason: "done" } };
  expect(goalStatusFromEntry(e)).toEqual({ condition: "analyze the project", met: true });
});
test("goalStatusFromEntry: ignores non-goal / non-attachment entries", () => {
  expect(goalStatusFromEntry({ type: "attachment", attachment: { type: "image" } })).toBeNull();
  expect(goalStatusFromEntry({ type: "user", message: { role: "user", content: "x" } })).toBeNull();
  expect(goalStatusFromEntry({ type: "attachment" })).toBeNull();
  expect(goalStatusFromEntry({})).toBeNull();
});
