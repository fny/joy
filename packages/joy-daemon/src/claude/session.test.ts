import { test, expect } from "vitest";
import { joyTitleValue, joyNotifyEvents, paneShowsReadyPrompt, paneShowsClaudeRunning, paneShowsWorking, paneShowsGenerating, paneInputText, paneInputLineSpan, paneShowsEmptyReadyPrompt, parsePermissionModeFromPane, formatRetryDelay, parseJoyCommand, takesThinkingLease, toolResultText, TOOL_RESULT_MAX_CHARS, flattenForMatch, loginContinueFromPane, bgTaskEvent, goalStatusFromEntry, authUrlFromPane, loginFromPane, dialogFromPane, joyBgLongRunningIds, classifyBgTasks, BG_LAUNCH_TTL_MS, trustPromptKeys } from "./session";

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

test("input line span: sizes the C-u press budget (1 per rendered line)", () => {
  // C-u kills ONE line per press (~2 presses/line with the break) — verified live
  // 2026-07-02, a 3-line box took exactly 6 presses. The budget must scale with the
  // box height or a tall box exhausts the loop and leaves residue (concat risk).
  const three = ["────────", "❯ line one", "  line two", "  line three", "────────", "  ⏵⏵ bypass permissions on"].join("\n");
  expect(paneInputLineSpan(three)).toBe(3);
  const one = ["✻ Brewed for 43s", "────────", "❯ ABORTTEST: essay", "────────", "  ⏵⏵ bypass permissions on"].join("\n");
  expect(paneInputLineSpan(one)).toBe(1);
  expect(paneInputLineSpan("no box here at all")).toBe(0);
  // Footer without a bottom rule must bound the span, mirroring paneInputText.
  const noRule = ["────────", "❯ text", "  more", "  ⏵⏵ bypass permissions on"].join("\n");
  expect(paneInputLineSpan(noRule)).toBe(2);
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

// ── Agent-name labeled box border + narrow-pane truncation ──────────────────
// Captured live 2026-07-04 (window at 58 cols, session agent-named "Joy"):
// the box's TOP border embeds the name (`──… Joy ──`) and the footer truncates
// before "esc to interrupt". The pure-rule border regex made every parser
// return null/false → dispatch silently retried forever → app messages never
// reached Claude for the session's entire life.
const LABELED_RULE = "─".repeat(51) + " Joy ──";
const PLAIN_RULE = "─".repeat(58);

test("ready + empty box: agent-name label in the top border (58-col live capture)", () => {
  const pane = [LABELED_RULE, "❯ ", PLAIN_RULE, "  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to…"].join("\n");
  expect(paneShowsReadyPrompt(pane)).toBe(true);
  expect(paneInputText(pane)).toBe("");
  expect(paneShowsEmptyReadyPrompt(pane)).toBe(true);
});

// Same bug, second visit: on a WIDE pane the label lands with a single trailing
// rule char (`────… Joy ─`). The 2026-07-04 fix demanded two, so the gate went
// blind again — live 2026-09-03, dispatch held >1h on an idle session.
const LABELED_RULE_ONE_TRAIL = "─".repeat(120) + " Joy ─";

test("ready + empty box: label with a SINGLE trailing rule char (wide-pane capture)", () => {
  const pane = [LABELED_RULE_ONE_TRAIL, "❯ ", PLAIN_RULE].join("\n");
  expect(paneShowsReadyPrompt(pane)).toBe(true);
  expect(paneInputText(pane)).toBe("");
});

test("input text: typed content under a labeled border", () => {
  const pane = [LABELED_RULE, "❯ hello from the app", PLAIN_RULE].join("\n");
  expect(paneInputText(pane)).toBe("hello from the app");
});

test("input text: labeled border is NOT mistaken for content or scrollback", () => {
  // Scrollback echo (no rule above ❯) still yields null — label change must not
  // loosen the live-box requirement.
  const pane = ["● earlier reply", "", "❯ old echoed prompt"].join("\n");
  expect(paneInputText(pane)).toBe(null);
});

test("generating: spinner shape survives narrow-pane truncation of 'esc to interrupt'", () => {
  const pane = [
    "● Reading 2 files, running 1 shell command…",
    "",
    "✽ Zesting… (4m 17s · ↓ 13.9k tokens · thought for 19s)",
    "",
    LABELED_RULE, "❯ ", PLAIN_RULE,
    "  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to…",
  ].join("\n");
  expect(paneShowsGenerating(pane)).toBe(true);
});

test("generating: old spinner text in scrollback does NOT read as generating", () => {
  const pane = [
    "✻ Booping… (4s · ↓ 142 tokens)", // scrollback echo, far above the box
    ...Array(14).fill(""),
    PLAIN_RULE, "❯ ", PLAIN_RULE,
    "  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents",
  ].join("\n");
  expect(paneShowsGenerating(pane)).toBe(false);
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
import { saveQueue } from "../domain/queueStore";

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

test("busy(): idle with an empty queue is not busy; a queued message is", () => {
  // The scripting-facing signal the CLI's exclusive send gates on. An 'ended'
  // qSession never drains (no tmux), so the queued item stays — perfect to
  // assert the queue-length arm of busy() in isolation from dispatch state.
  const s = qSession();
  expect(s.busy()).toBe(false);
  s.enqueue("queued work");
  expect(s.busy()).toBe(true);
  expect(s.toJSON().busy).toBe(true);
});

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

// The v2 lane needs to know whether ITS prompt landed. busy() cannot say — for
// claude it is true from enqueue onward, which let a turn report started AND
// completed while its own message was never typed (silent loss, 2026-09-03).
test("queue: per-item delivery state tracks pending → cancelled, and unknown ids", () => {
  const s = qSession();
  const a = s.enqueue("first");
  expect(s.queueItemState(a.id)).toBe("pending");
  expect(s.queueItemState("never-existed")).toBe("unknown");
  expect(s.cancelQueued(a.id)).toBe(true);
  expect(s.queueItemState(a.id)).toBe("cancelled");
});

test("queue: a joy command is handled, not queued, and says so to its caller", () => {
  const s = qSession();
  const r = s.enqueue("/title hello");
  expect(r.handled).toBe("command");
  expect(s.queueState().pendingCount).toBe(0);
  // A real message is not marked handled.
  expect(s.enqueue("just a message").handled).toBeUndefined();
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
    async clearThinkingMeta() {},
    async updateLogin() {}, async updateDialog() {},
    setReceiptSink() {},
    stampReceiptOnLastQueued() {},
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
  const notes: string[] = [];
  const s = new Session(
    { id: "c1", tmuxWindow: "joy:j-c1", cwd: "/tmp/c", flags: [], status: "active", startedAt: 0, claudeSessionId: "sid-c1" } as any,
    { relayClient: null, broadcast: () => {}, addChatMessage: (m: any) => { notes.push(String(m.content)); } } as any,
  );
  const rs: any = {
    relaySessionId: "rs-c1",
    start() {}, stop() {}, send() {},
    setThinking() {}, updateRetry() {}, async clearThinkingMeta() {}, async updateLogin() {}, async updateDialog() {}, setReceiptSink() {}, stampReceiptOnLastQueued() {}, updateQueue() {}, async updateBgTasks() {}, async updateContext() {}, updateGoal() {},
    updateCompacting(info: any) { compactingCalls.push(info); },
    notify() {},
  };
  s.attachRelay(rs, true);
  // attach reconciles a stale banner — none is live, so it clears (null).
  expect(compactingCalls).toEqual([null]);

  // PreCompact hook fired → /compacting route → markCompacting.
  s.markCompacting("auto");
  expect(compactingCalls.at(-1)).toMatchObject({ trigger: "auto" });

  // Claude writes the compact_boundary marker on completion → clears the banner
  // AND emits the <joy-compacted> divider carrying what the compaction cost.
  s.onTranscriptEntry({
    type: "system", subtype: "compact_boundary", timestamp: new Date().toISOString(),
    compactMetadata: { trigger: "auto", durationMs: 182522, preTokens: 384900, postTokens: 16703 },
  } as any);
  expect(compactingCalls.at(-1)).toBe(null);
  const marker = notes.find((n) => n.startsWith("<joy-compacted>"));
  expect(marker).toBeTruthy();
  expect(JSON.parse(marker!.replace(/^<joy-compacted>|<\/joy-compacted>$/g, ""))).toEqual({
    trigger: "auto", durationMs: 182522, preTokens: 384900, postTokens: 16703,
  });
});

test("compact_boundary: absent metrics are omitted, not emitted as undefined", () => {
  const notes: string[] = [];
  const s = new Session(
    { id: "c2", tmuxWindow: "joy:j-c2", cwd: "/tmp/c2", flags: [], status: "active", startedAt: 0, claudeSessionId: "sid-c2" } as any,
    { relayClient: null, broadcast: () => {}, addChatMessage: (m: any) => { notes.push(String(m.content)); } } as any,
  );
  s.onTranscriptEntry({
    type: "system", subtype: "compact_boundary", timestamp: new Date().toISOString(),
    compactMetadata: { trigger: "manual" },
  } as any);
  const marker = notes.find((n) => n.startsWith("<joy-compacted>"));
  expect(JSON.parse(marker!.replace(/^<joy-compacted>|<\/joy-compacted>$/g, ""))).toEqual({ trigger: "manual" });
});

// ── bgTaskEvent: launch/complete detection (single source of truth) ──────────
const userEntry = (extra: Record<string, unknown>) => ({ message: { role: "user", ...extra } });

test("bgTaskEvent: run_in_background launch (backgroundTaskId)", () => {
  const e = { message: { role: "user", content: [{ type: "tool_result" }] }, toolUseResult: { backgroundTaskId: "bg-1" } };
  expect(bgTaskEvent(e)).toEqual({ kind: "launch", id: "bg-1", source: "shell" });
});

test("bgTaskEvent: async agent launch (isAsync + agentId)", () => {
  const e = { message: { role: "user", content: [{ type: "tool_result" }] }, toolUseResult: { isAsync: true, agentId: "ag-9" } };
  expect(bgTaskEvent(e)).toEqual({ kind: "launch", id: "ag-9", source: "agent" });
});

test("bgTaskEvent: Monitor lifecycle — launch, interim events don't complete, terminal does", () => {
  // Launch: Monitor tool_result is {taskId, timeoutMs, persistent} (real shape
  // from fny agent2, 2026-07-08). Counted as a shell task → teal N/M status.
  const launch = { message: { role: "user", content: [{ type: "tool_result" }] }, toolUseResult: { taskId: "b6im95b83", timeoutMs: 3600000, persistent: false } };
  expect(bgTaskEvent(launch)).toEqual({ kind: "launch", id: "b6im95b83", source: "shell" });
  // Interim monitor event: same <task-id>, NO <status> — must NOT complete the
  // task (the first event used to flip the monitor to done instantly).
  const interim = { type: "queue-operation", operation: "enqueue", content: '<task-notification>\n<task-id>b6im95b83</task-id>\n<summary>Monitor event: "image build 33328c5dc"</summary>\n<event>BUILD OK</event>\n</task-notification>' };
  expect(bgTaskEvent(interim)).toBeNull();
  // Terminal: stream ended, <status>completed</status> present.
  const done = { type: "queue-operation", operation: "enqueue", content: '<task-notification>\n<task-id>b6im95b83</task-id>\n<status>completed</status>\n<summary>Monitor "image build 33328c5dc" stream ended</summary>\n</task-notification>' };
  expect(bgTaskEvent(done)).toEqual({ kind: "complete", id: "b6im95b83" });
  // A bare TaskCreate-ish result (taskId but no timeoutMs) must NOT launch.
  const taskCreate = { message: { role: "user", content: [{ type: "tool_result" }] }, toolUseResult: { taskId: "todo-1" } };
  expect(bgTaskEvent(taskCreate)).toBeNull();
  // TIMEOUT: terminal despite riding the interim-event shape (no <status>,
  // "Monitor event:" summary). Real payload from fny agent2 (2026-07-09) —
  // this stuck the count at "1/2 completed" until treated as a completion.
  const timedOut = { type: "queue-operation", operation: "enqueue", content: '<task-notification>\n<task-id>bdjmqwhi5</task-id>\n<summary>Monitor event: "doritos stack update (neo4j GDS image)"</summary>\n<event>[Monitor timed out — re-arm if needed.]</event>\n</task-notification>' };
  expect(bgTaskEvent(timedOut)).toEqual({ kind: "complete", id: "bdjmqwhi5" });
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

test("bgTaskEvent: completion via queue-operation entry (busy-Claude enqueue)", () => {
  // When Claude is busy at notification time, the payload is enqueued into
  // Claude's own message queue; the transcript records a queue-operation entry
  // with the notification in `content` — sometimes the ONLY record of the
  // completion (15/494 measured on a real session). Missing it wedged the N/M
  // counter forever (the "61/76 completed" ghost).
  const e = {
    type: "queue-operation",
    operation: "enqueue",
    timestamp: "2026-07-01T10:00:00.000Z",
    sessionId: "df4f5b50",
    content: "<task-notification>\n<task-id>a876f9f4c8d976e55</task-id>\n<output-summary>done</output-summary>\n</task-notification>",
  };
  expect(bgTaskEvent(e)).toEqual({ kind: "complete", id: "a876f9f4c8d976e55" });
});

test("bgTaskEvent: queue-operation without a task-notification is not an event", () => {
  const e = { type: "queue-operation", operation: "enqueue", content: "just a queued user message" };
  expect(bgTaskEvent(e)).toBeNull();
});

test("classifyBgTasks: queue-operation completion unwedges the batch reset", () => {
  // The wedge: one completion arriving ONLY in queue-operation form used to be
  // invisible → its task stayed outstanding → outstanding never hit 0 → the
  // fresh-batch reset never fired and every later batch fused into one
  // ever-growing count. With the completion seen, the next batch resets clean.
  const events: Array<{ kind: "launch"; id: string; source: "agent" | "shell" } | { kind: "complete"; id: string }> = [
    { kind: "launch", id: "t1", source: "shell" },
    { kind: "launch", id: "t2", source: "shell" },
    { kind: "complete", id: "t1" },
    { kind: "complete", id: "t2" }, // the queue-operation-only completion
    { kind: "launch", id: "t3", source: "shell" },   // next batch — must start fresh at 1, not 3
  ];
  const r = classifyBgTasks(events, new Set());
  expect(r.total).toBe(1);
  expect(r.done).toBe(0);
  expect(r.outstanding).toEqual(new Set(["t3"]));
});

test("classifyBgTasks: agents and shells tracked in separate groups", () => {
  const events: Array<{ kind: "launch"; id: string; source: "agent" | "shell" } | { kind: "complete"; id: string }> = [
    { kind: "launch", id: "a1", source: "agent" },
    { kind: "launch", id: "s1", source: "shell" },
    { kind: "launch", id: "a2", source: "agent" },
    { kind: "complete", id: "s1" },
  ];
  const r = classifyBgTasks(events, new Set());
  expect({ t: r.agent.total, d: r.agent.done }).toEqual({ t: 2, d: 0 });
  expect({ t: r.shell.total, d: r.shell.done }).toEqual({ t: 1, d: 1 });
  expect(r.agent.outstanding).toEqual(new Set(["a1", "a2"]));
  expect(r.shell.outstanding.size).toBe(0);
  // combined view still works for busy()/self-heal
  expect(r.outstanding).toEqual(new Set(["a1", "a2"]));
});

test("classifyBgTasks: duplicate completion (queue-op echo + user message) counts once", () => {
  const events: Array<{ kind: "launch"; id: string; source: "agent" | "shell" } | { kind: "complete"; id: string }> = [
    { kind: "launch", id: "t1", source: "shell" },
    { kind: "complete", id: "t1" },
    { kind: "complete", id: "t1" }, // same notification seen in a second form
  ];
  const r = classifyBgTasks(events, new Set());
  expect(r.done).toBe(1);
  expect(r.outstanding.size).toBe(0);
});

test("joyNotifyEvents: parses message + detail from assistant text", () => {
  const e = { message: { role: "assistant", content: [
    { type: "text", text: 'Done!\n<joy-notify message="Deploy finished" detail="staging green after 42m" />' },
  ] } };
  expect(joyNotifyEvents(e)).toEqual([{ headline: "Deploy finished", detail: "staging green after 42m" }]);
});

test("joyNotifyEvents: detail optional; legacy title/message maps; user entries ignored", () => {
  const noDetail = { message: { role: "assistant", content: '<joy-notify message="need a decision" />' } };
  expect(joyNotifyEvents(noDetail)).toEqual([{ headline: "need a decision", detail: null }]);
  const legacy = { message: { role: "assistant", content: '<joy-notify title="Deploy finished" message="staging green" />' } };
  expect(joyNotifyEvents(legacy)).toEqual([{ headline: "Deploy finished", detail: "staging green" }]);
  const empty = { message: { role: "assistant", content: '<joy-notify detail="orphan detail" />' } };
  expect(joyNotifyEvents(empty)).toEqual([]);
  const user = { message: { role: "user", content: '<joy-notify message="spoofed" />' } };
  expect(joyNotifyEvents(user)).toEqual([]);
});

test("joyNotifyEvents: detail capped at 180, headline at 60 chars", () => {
  const long = "x".repeat(400);
  const e = { message: { role: "assistant", content: `<joy-notify message="${long}" detail="${long}" />` } };
  expect(joyNotifyEvents(e)[0].detail!.length).toBe(180);
  expect(joyNotifyEvents(e)[0].headline.length).toBe(60);
});

test("joyTitleValue: parses value from assistant text; caps at 60; ignores non-assistant", () => {
  const e = { message: { role: "assistant", content: 'Pivoting.\n<joy-title value="push notification overhaul" />' } };
  expect(joyTitleValue(e)).toBe("push notification overhaul");
  const long = { message: { role: "assistant", content: `<joy-title value="${"x".repeat(200)}" />` } };
  expect(joyTitleValue(long)!.length).toBe(60);
  expect(joyTitleValue({ message: { role: "user", content: '<joy-title value="spoof" />' } })).toBeNull();
  expect(joyTitleValue({ message: { role: "assistant", content: "no tag here" } })).toBeNull();
  expect(joyTitleValue({ message: { role: "assistant", content: '<joy-title value="" />' } })).toBeNull();
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
  const L = (id: string) => ({ kind: "launch" as const, id, source: "shell" as const });
  const C = (id: string) => ({ kind: "complete" as const, id });
  // b1,b2 finishing; srv is long-running (tagged). srv never counts in total/done.
  const r = classifyBgTasks([L("b1"), L("srv"), L("b2"), C("b1")], new Set(["srv"]));
  expect({ total: r.total, done: r.done, outstanding: [...r.outstanding], longRunning: [...r.longRunning] })
    .toEqual({ total: 2, done: 1, outstanding: ["b2"], longRunning: ["srv"] });
});

test("classifyBgTasks: long-running classified even when its launch precedes the tag (full lrIds up front)", () => {
  // The tag lands later in the transcript, but lrIds is gathered first, so the
  // earlier launch is still classified as long-running (never in the N/M).
  const r = classifyBgTasks([{ kind: "launch", id: "srv", source: "shell" }], new Set(["srv"]));
  expect(r.total).toBe(0);
  expect([...r.longRunning]).toEqual(["srv"]);
});

test("classifyBgTasks: an interrupt does NOT drop running tasks — they complete later", () => {
  const L = (id: string) => ({ kind: "launch" as const, id, source: "shell" as const });
  const C = (id: string) => ({ kind: "complete" as const, id });
  // b1 was in flight when the user pressed Stop. Escape interrupts Claude's
  // turn, not the background process — b1 keeps running and its completion
  // notification still lands, so the count must keep tracking it. (An earlier
  // abort-time cancel-filter wiped live status the moment Stop was pressed.)
  const during = classifyBgTasks([L("b1"), L("b2"), C("b2")], new Set());
  expect({ total: during.total, done: during.done, outstanding: [...during.outstanding] })
    .toEqual({ total: 2, done: 1, outstanding: ["b1"] });
  // …and when b1's notification arrives post-interrupt, it drains normally.
  const after = classifyBgTasks([L("b1"), L("b2"), C("b2"), C("b1")], new Set());
  expect({ total: after.total, done: after.done, outstanding: [...after.outstanding] })
    .toEqual({ total: 2, done: 2, outstanding: [] });
});

test("classifyBgTasks: stopping a server clears it; finishing batch resets on empty (servers don't block it)", () => {
  const L = (id: string) => ({ kind: "launch" as const, id, source: "shell" as const });
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

test("authUrlFromPane: ignores NON-Claude auth URLs — agents print third-party login links in replies", () => {
  // Real false positive (fny eventhorizon, 2026-07-08): an AWS SSO device URL
  // in conversation output put the login bar up for a healthy session.
  expect(authUrlFromPane("Open this link: https://d-9267d2a99a.awsapps.com/start/#/device?user_code=KRFG-CZRN"))
    .toBeNull();
  expect(authUrlFromPane("Open https://github.com/login/device and enter CODE"))
    .toBeNull();
  // Claude hosts still match, including subdomains.
  expect(authUrlFromPane("https://console.anthropic.com/oauth/authorize?x=1"))
    .toBe("https://console.anthropic.com/oauth/authorize?x=1");
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
function replay(events: Array<{ kind: "launch"; id: string; source: "agent" | "shell" } | { kind: "complete"; id: string }>) {
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
    { kind: "launch", id: "a", source: "shell" }, { kind: "launch", id: "b", source: "shell" }, { kind: "complete", id: "a" },
  ])).toEqual({ outstanding: ["b"], total: 2, done: 1 });
});

test("derive semantics: a fully-drained batch clears (next launch resets the count)", () => {
  expect(replay([
    { kind: "launch", id: "a", source: "shell" }, { kind: "complete", id: "a" },
    { kind: "launch", id: "b", source: "shell" },
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

// ── Codex review finding 2: confirmed-cursor crash windows ──────────────────

function mkSession(id: string) {
  const s = new Session(
    { id, tmuxWindow: `joy:j-${id}`, cwd: "/tmp/" + id, flags: [], status: "active", startedAt: 0, claudeSessionId: `sid-${id}` } as any,
    { relayClient: null, broadcast: () => {}, addChatMessage: () => {} } as any,
  );
  const rs: any = {
    relaySessionId: `rs-${id}`,
    start() {}, stop() {}, send() {},
    setThinking() {}, updateRetry() {}, async clearThinkingMeta() {}, async updateLogin() {}, async updateDialog() {},
    setReceiptSink() {}, stampReceiptOnLastQueued() {},
    updateQueue() {}, async updateBgTasks() {}, async updateContext() {}, updateCompacting() {}, updateGoal() {}, notify() {},
  };
  s.attachRelay(rs, true);
  return s;
}

test("enqueue dedupes a re-pulled seq — spool-written/cursor-unwritten replay is a no-op", () => {
  const s = mkSession("dd1");
  const first = s.enqueue("hello", { seq: 42, source: "relay", mirrorToRelay: false, visible: false });
  const replay = s.enqueue("hello", { seq: 42, source: "relay", mirrorToRelay: false, visible: false });
  expect(replay.id).toBe(first.id); // same staged item, not a duplicate
  expect(s.queueState().pendingCount).toBe(1);
});

test("enqueue with requireDurable throws when the spool write fails — cursor must not advance", () => {
  const s = mkSession("dd2");
  // Point the spool at an impossible path via JOY_HOME_DIR? saveQueue takes
  // baseDir internally — simulate by monkeypatching writeFileSync is brittle;
  // instead verify the CONTRACT via the exported saveQueue directly:
  // a failing write returns false (queueStore), and enqueue() maps false to a
  // throw + unstage (verified by code path below with a poisoned baseDir).
  expect(saveQueue("x", [{ id: "a", text: "t", createdAt: 1, source: "relay", mirrorToRelay: false, visible: false }], "/dev/null/impossible")).toBe(false);
});

// ── dialogFromPane — live captures, claude 2.1.198 (2026-07-20) ──────────────
// The three known interactive dialogs REPLACE the input box: no ready prompt,
// no "esc to interrupt", no transcript echo until resolved. All matched on the
// ▔-run top border + (numbered options OR a confirm/cancel footer).

const DIALOG_MODEL_PICKER = [
  "✻ Cogitated for 1s",
  "▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔",
  "   Select model",
  "   Switch between Claude models. Your pick becomes the default for new sessions.",
  "     1. Default (recommended)  Opus 4.8 with 1M context · Best for everyday, complex tasks",
  "     2. Opus                   Opus 4.8 with 1M context · Best for everyday, complex tasks",
  "     3. Fable                  Fable 5 · Most capable for your hardest and longest-running tasks",
  "     4. Sonnet                 Sonnet 5 · Efficient for routine tasks",
  "   ❯ 5. Haiku ✔                Haiku 4.5 · Fastest for quick answers",
  "   ○ Effort not supported for Haiku",
  "   Use /fast to turn on Fast mode (Opus 4.8).",
  "   Enter to set as default · s to use this session only · Esc to cancel",
].join("\n");

const DIALOG_SWITCH_CONFIRM = [
  "❯ /model",
  "  ⎿  Kept model as Haiku 4.5",
  "▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔",
  "   Switch model?",
  "   Your next response will be slower and use more tokens",
  "   This conversation is cached for the current model. Switching to Opus 4.8 means the full history gets re-read.",
  "   ❯ 1. Yes, switch to Opus 4.8",
  "     2. No, go back",
].join("\n");

const DIALOG_EFFORT_SLIDER = [
  "❯ /model opus",
  "  ⎿  Kept model as Haiku 4.5",
  "▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔",
  "   Effort",
  "                                       Faster                             Smarter",
  "                                       low     medium     high     xhigh      max",
  "   ←/→ to adjust · Enter to confirm · Esc to cancel",
].join("\n");

const PANE_READY_IDLE = [
  "● ok",
  "────────────────────────────────────────",
  "❯ ",
  "────────────────────────────────────────",
  "  ? for shortcuts · ← for agents",
].join("\n");

test("dialogFromPane: model picker — title + numbered options", () => {
  const d = dialogFromPane(DIALOG_MODEL_PICKER);
  expect(d).not.toBeNull();
  expect(d!.title).toBe("Select model");
  expect(d!.options.length).toBe(5);
  expect(d!.options[4]).toContain("Haiku");
  expect(d!.options[4].startsWith("❯")).toBe(false); // selection marker stripped
});

test("dialogFromPane: switch-model confirm — footerless, options carry it", () => {
  const d = dialogFromPane(DIALOG_SWITCH_CONFIRM);
  expect(d).not.toBeNull();
  expect(d!.title).toBe("Switch model?");
  expect(d!.options).toEqual(["1. Yes, switch to Opus 4.8", "2. No, go back"]);
});

test("dialogFromPane: /effort slider — no numbered options, footer carries it", () => {
  const d = dialogFromPane(DIALOG_EFFORT_SLIDER);
  expect(d).not.toBeNull();
  expect(d!.title).toBe("Effort");
  expect(d!.options).toEqual([]);
});

test("dialogFromPane: null on the ready prompt and generating panes", () => {
  expect(dialogFromPane(PANE_READY_IDLE)).toBeNull();
  expect(dialogFromPane("✻ Pondering… (esc to interrupt)")).toBeNull();
  // A ▔-run alone in scrolled content (no options, no footer) is not a dialog.
  expect(dialogFromPane("some output\n▔▔▔▔▔▔▔▔▔▔▔▔\nplain text below")).toBeNull();
});

test("dialogFromPane: no existing pane matcher claims the dialogs (regression guard)", () => {
  for (const pane of [DIALOG_MODEL_PICKER, DIALOG_SWITCH_CONFIRM, DIALOG_EFFORT_SLIDER]) {
    expect(paneShowsReadyPrompt(pane)).toBe(false);
    expect(paneShowsGenerating(pane)).toBe(false);
    expect(paneInputText(pane)).toBeNull();
  }
});

test("dialogFromPane: QUOTED dialog in scrollback above a live ready prompt is NOT a dialog", () => {
  // Reproduced by the gpt-5.6-sol review (finding 2): agent output quoting a
  // dialog, with the real input box alive below it. A real dialog REPLACES the
  // box, so a live ready prompt disproves the dialog.
  const pane = [
    "▔▔▔▔▔▔▔▔▔▔▔▔",
    "Select model",
    "1. Opus",
    "────────────────────────────────────────",
    "❯ ",
    "────────────────────────────────────────",
    "  ? for shortcuts · ← for agents",
  ].join("\n");
  expect(dialogFromPane(pane)).toBeNull();
  // Same content while claude is generating below it — also not a dialog.
  const generating = pane.replace("❯ ", "❯ ") + "\n✻ Pondering… (esc to interrupt)";
  expect(dialogFromPane(generating)).toBeNull();
});

test("dialogFromPane: quoted ready-box ABOVE a real dialog does not un-match it", () => {
  // Verify-round regression: the ready/generating disqualification must be
  // scoped BELOW the dialog rule — a conversation quoting the input box in
  // scrollback, with a real dialog open beneath, is still a dialog.
  const pane = [
    "● Here is what the prompt looks like:",
    "────────────────────────────────────────",
    "❯ ",
    "────────────────────────────────────────",
    "  ? for shortcuts · ← for agents",
    "▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔",
    "   Switch model?",
    "   ❯ 1. Yes, switch to Opus 4.8",
    "     2. No, go back",
  ].join("\n");
  const d = dialogFromPane(pane);
  expect(d).not.toBeNull();
  expect(d!.title).toBe("Switch model?");
});

// ── Title auto-update e2e (daemon side) ──────────────────────────────────────
// The two AI title paths: Claude's ai-title transcript entries and the agent's
// <joy-title/> tag in assistant text. Driven through onTranscriptEntry against
// a real Session + mock relay — the exact live path minus the file watcher.
function titleSession() {
  const summaries: string[] = [];
  const s = new Session(
    { id: "t1", tmuxWindow: "joy:j-t1", cwd: "/tmp/t", flags: [], status: "active", startedAt: 0, claudeSessionId: "sid-t1" } as any,
    { relayClient: null, broadcast: () => {}, addChatMessage: () => {} } as any,
  );
  const rs: any = {
    relaySessionId: "rs-t1",
    start() {}, stop() {}, send() {},
    setThinking() {}, updateRetry() {}, async clearThinkingMeta() {}, async updateLogin() {}, async updateDialog() {},
    setReceiptSink() {}, stampReceiptOnLastQueued() {}, updateQueue() {}, async updateBgTasks() {}, async updateContext() {},
    updateCompacting() {}, updateGoal() {}, notify() {}, notifyCustom() {},
    async updateSummary(t: string) { summaries.push(t); },
  };
  s.attachRelay(rs, true);
  return { s, summaries };
}

test("title e2e: ai-title entry applies live", () => {
  const { s, summaries } = titleSession();
  s.onTranscriptEntry({ type: "ai-title", aiTitle: "First real title", timestamp: new Date().toISOString() } as any);
  expect(summaries).toEqual(["First real title"]);
  expect(s.toJSON().summary).toBe("First real title");
});

test("title e2e: <joy-title/> tag in assistant text applies live", () => {
  const { s, summaries } = titleSession();
  s.onTranscriptEntry({
    type: "assistant", uuid: "u-jt-1", timestamp: new Date().toISOString(),
    message: { role: "assistant", content: [{ type: "text", text: 'Working on X now.\n\n<joy-title value="Session title e2e" />\n' }] },
  } as any);
  expect(summaries).toContain("Session title e2e");
  expect(s.toJSON().summary).toBe("Session title e2e");
});

test("title e2e: stale ai-title re-emission does NOT stomp an agent title; a NEW ai-title does", () => {
  const { s, summaries } = titleSession();
  const ts = () => new Date().toISOString();
  // Claude titles the session, then keeps re-emitting the same value on resume.
  s.onTranscriptEntry({ type: "ai-title", aiTitle: "Disable suggestions", timestamp: ts() } as any);
  // Agent re-titles via the tag.
  s.onTranscriptEntry({
    type: "assistant", uuid: "u-jt-2", timestamp: ts(),
    message: { role: "assistant", content: [{ type: "text", text: '<joy-title value="Queue debugging" />' }] },
  } as any);
  expect(s.toJSON().summary).toBe("Queue debugging");
  // Stale re-emission (identical value) — must NOT revert the agent title.
  s.onTranscriptEntry({ type: "ai-title", aiTitle: "Disable suggestions", timestamp: ts() } as any);
  expect(s.toJSON().summary).toBe("Queue debugging");
  // A genuinely NEW ai-title still applies (real re-title, e.g. user renamed in CLI).
  s.onTranscriptEntry({ type: "ai-title", aiTitle: "Brand new topic", timestamp: ts() } as any);
  expect(s.toJSON().summary).toBe("Brand new topic");
  expect(summaries).toEqual(["Disable suggestions", "Queue debugging", "Brand new topic"]);
});

// ── retryFromPane: the CLI's API-retry spinner is the ONLY 529 signal ────────
// (api_error transcript entries stopped appearing in 2.1.x — verified live
// 2026-07-29 against a 10-attempt 529 storm that left zero entries.)
import { retryFromPane } from "./session";

test("retryFromPane: parses the live 529 spinner line", () => {
  const pane = "✻ 529 Overloaded · Retrying in 18s · attempt 10/10\n  ⎿  If it persists, check https://status.claude.com.";
  expect(retryFromPane(pane)).toEqual({ status: 529, delaySec: 18, attempt: 10, total: 10 });
});

test("retryFromPane: variants and non-matches", () => {
  expect(retryFromPane("✻ 429 Rate limited · Retrying in 5s · attempt 2/10"))
    .toEqual({ status: 429, delaySec: 5, attempt: 2, total: 10 });
  expect(retryFromPane("✻ 500 Internal server error · Retrying in 60s · attempt 7/10"))
    .toEqual({ status: 500, delaySec: 60, attempt: 7, total: 10 });
  expect(retryFromPane("plain working pane")).toBeNull();
  // A user merely TALKING about a 529 in chat text must not trigger the banner.
  expect(retryFromPane("I saw a 529 yesterday, attempt 1/10 of my diet")).toBeNull();
});

// ── numbered pickers WITHOUT the ▔ modal rule (resume-from-summary etc.) ────
// Fixture is a live capture (2026-08-04). Detection deliberately keys on the
// numbered rows + default ❯ selection, NOT the border style — borders have
// changed across CLI versions.
const RESUME_PICKER = [
  "──────────────────────────────────────────────────────────────────────────────",
  "  This session is 3d 9h old and 528.3k tokens.",
  "",
  "  Resuming the full session will consume a substantial portion of your usage limits. We recommend resuming from a summary.",
  "",
  "  ❯ 1. Resume from summary (recommended)",
  "    2. Resume full session as-is",
  "    3. Don't ask me again",
].join("\n");

test("dialogFromPane picker fallback: detects the resume-from-summary picker (─ rule, not ▔)", () => {
  const d = dialogFromPane(RESUME_PICKER);
  expect(d).not.toBeNull();
  expect(d!.options).toEqual([
    "1. Resume from summary (recommended)",
    "2. Resume full session as-is",
    "3. Don't ask me again",
  ]);
  expect(d!.title).toMatch(/Resuming the full session/);
});

test("dialogFromPane picker fallback: detects it with the selection on a different row and NO border at all", () => {
  const noBorder = [
    "  Pick a thing.",
    "    1. First",
    "  ❯ 2. Second",
    "    3. Third",
  ].join("\n");
  const d = dialogFromPane(noBorder);
  expect(d).not.toBeNull();
  expect(d!.options).toHaveLength(3);
  expect(d!.title).toBe("Pick a thing.");
});

test("dialogFromPane picker fallback: a QUOTED picker above a live ready prompt is NOT a dialog", () => {
  const quoted = [
    "  ❯ 1. Resume from summary (recommended)",
    "    2. Resume full session as-is",
    "─────────────────────────────",
    "❯ ",
    "─────────────────────────────",
  ].join("\n");
  expect(dialogFromPane(quoted)).toBeNull();
});

test("dialogFromPane picker fallback: a numbered list in scrollback with no ❯ selection is NOT a dialog", () => {
  const list = [
    "  Here are the steps:",
    "  1. Install deps",
    "  2. Run the build",
    "  3. Ship it",
  ].join("\n");
  expect(dialogFromPane(list)).toBeNull();
});

test("dialogFromPane picker fallback: scrollback list + live picker: the ❯ run wins", () => {
  const mixed = [
    "  1. old scrollback item",
    "  2. another",
    "",
    "  Choose:",
    "  ❯ 1. Yes",
    "    2. No",
  ].join("\n");
  const d = dialogFromPane(mixed);
  expect(d).not.toBeNull();
  expect(d!.options).toEqual(["1. Yes", "2. No"]);
  expect(d!.title).toBe("Choose:");
});

test("parseJoyCommand: /joy-prompt is joy-owned (hyphenated name parses)", () => {
  expect(parseJoyCommand("/joy-prompt")).toEqual({ name: "joy-prompt", args: "" });
});

test("loginContinueFromPane: matches the post-login continue screen only", () => {
  expect(loginContinueFromPane("Logged in as faraz.yashar@gmail.com\nLogin successful. Press Enter to continue…")).toBe(true);
  expect(loginContinueFromPane("Login successful.\n   Press  Enter  to continue")).toBe(true);
  expect(loginContinueFromPane("❯ discussing login successful flows in the app")).toBe(false);
  expect(loginContinueFromPane("Press Enter to continue")).toBe(false);
});

// Regression: the daemon used to answer the folder-trust dialog with a hard-coded
// "1". Current claude builds list "No, exit" FIRST, so that answered *no* and
// killed the session the daemon had just spawned — the pane fell back to a shell
// and every dispatched prompt sat queued forever.
test("trustPromptKeys: walks to the trust row when 'No, exit' is listed first", () => {
  const pane = [
    " Accessing workspace:",
    " /tmp/v2-final",
    " Quick safety check: Is this a project you created or one you trust?",
    " Claude Code'll be able to read, edit, and execute files here.",
    " Security guide",
    " \u276f No, exit",
    "   Yes, I trust this folder",
    " Enter to confirm \u00b7 Esc to cancel",
  ].join("\n");
  expect(trustPromptKeys(pane)).toEqual(["Down", "Enter"]);
});

test("trustPromptKeys: walks up when the trust row is listed first", () => {
  const pane = [" Do you trust the files in this folder?", "   Yes, I trust this folder", " \u276f No, exit"].join("\n");
  expect(trustPromptKeys(pane)).toEqual(["Up", "Enter"]);
});

test("trustPromptKeys: no marker rendered yet assumes the first row is selected", () => {
  const pane = [" Is this a project you trust?", "   No, exit", "   Yes, I trust this folder"].join("\n");
  expect(trustPromptKeys(pane)).toEqual(["Down", "Enter"]);
});

test("trustPromptKeys: numbered menus select by digit", () => {
  const pane = [" Is this a project you trust?", " \u276f 1. Yes, proceed", "   2. No, exit"].join("\n");
  expect(trustPromptKeys(pane)).toEqual(["1", "Enter"]);
  const reordered = [" Is this a project you trust?", " \u276f 1. No, exit", "   2. Yes, I trust this folder"].join("\n");
  expect(trustPromptKeys(reordered)).toEqual(["2", "Enter"]);
});

test("trustPromptKeys: null until the options paint (never guesses)", () => {
  expect(trustPromptKeys(" Quick safety check: Is this a project you trust?")).toBeNull();
  expect(trustPromptKeys("")).toBeNull();
});

test("takesThinkingLease: real prompts hold the pane off, slash commands do not", () => {
  expect(takesThinkingLease("write me a function")).toBe(true);
  expect(takesThinkingLease("  think hard about /effort")).toBe(true); // a / mid-prompt is not a command
  // These generate nothing — a 170s lease pins busy() and holds the relay turn.
  expect(takesThinkingLease("/effort high")).toBe(false);
  expect(takesThinkingLease("/model opus")).toBe(false);
  expect(takesThinkingLease("  /status")).toBe(false);
  // No prompt on the hook: keep the old, safe behaviour and take the lease —
  // an unknown submit is far more likely a real turn than a slash command.
  expect(takesThinkingLease(null)).toBe(true);
  expect(takesThinkingLease(undefined)).toBe(true);
});

test("classifyBgTasks: a launch that never completed ages out of the counter", () => {
  const now = Date.now();
  const stale = now - BG_LAUNCH_TTL_MS - 60_000;
  const events: any[] = [
    { kind: "launch", id: "agent-lost", source: "agent", atMs: stale }, // notification never arrived
    { kind: "launch", id: "agent-live", source: "agent", atMs: now - 30_000 },
  ];
  const r = classifyBgTasks(events, new Set(), now);
  expect([...r.agent.outstanding]).toEqual(["agent-live"]);
  expect(r.agent.total).toBe(1);
  expect(r.outstanding.size).toBe(1);
});

test("classifyBgTasks: an OLD launch that did complete still counts as done", () => {
  const now = Date.now();
  const stale = now - BG_LAUNCH_TTL_MS - 60_000;
  const r = classifyBgTasks([
    { kind: "launch", id: "bg-1", source: "shell", atMs: stale },
    { kind: "complete", id: "bg-1" },
  ], new Set(), now);
  expect(r.shell.done).toBe(1);
  expect(r.shell.total).toBe(1);
  expect(r.outstanding.size).toBe(0);
});

test("classifyBgTasks: un-timestamped launches never age out", () => {
  const now = Date.now();
  const r = classifyBgTasks([{ kind: "launch", id: "bg-x", source: "shell" }], new Set(), now);
  expect(r.outstanding.has("bg-x")).toBe(true);
});

test("toolResultText: string and block results forward; image-only stays undefined; huge output keeps head + tail", () => {
  expect(toolResultText("hello\nworld")).toBe("hello\nworld");
  expect(toolResultText([{ type: "text", text: "a" }, { type: "image", source: {} }, { type: "text", text: "b" }])).toBe("a\nb");
  expect(toolResultText([{ type: "image", source: {} }])).toBeUndefined();
  expect(toolResultText(undefined)).toBeUndefined();
  expect(toolResultText("")).toBeUndefined();
  const big = "x".repeat(TOOL_RESULT_MAX_CHARS * 3);
  const out = toolResultText(big)!;
  expect(out.length).toBeLessThan(TOOL_RESULT_MAX_CHARS + 200);
  expect(out).toContain("characters truncated");
  expect(out.startsWith("x".repeat(100))).toBe(true);
  expect(out.endsWith("x".repeat(100))).toBe(true);
});
