// Hook authority (spike Wave F, candidate A, step one — docs/review-campaign-
// 2026-09-claude-runtime-spike.md). A fake hook feed drives a real Session
// against a scripted pane that is STALE or CONTRADICTORY, asserting that hooks
// win once the session's `hooksLive` latch has flipped and that the pane
// rules apply unchanged when it never does (#30 #32 #479 #480 #482).
import { test, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Session, HOOK_SESSION_END_GRACE_MS } from "./session";
import { loadWindowRecord, saveWindowRecord } from "../domain/windowRecord";
import type { TmuxDriver } from "../tmux/driver";

let home: string;
beforeAll(() => { home = mkdtempSync(join(tmpdir(), "joy-hook-authority-")); process.env.JOY_HOME_DIR = home; });
afterAll(() => { delete process.env.JOY_HOME_DIR; rmSync(home, { recursive: true, force: true }); });
afterEach(() => { vi.useRealTimers(); });

const RULE = "─".repeat(60);
const FOOTER_IDLE = "  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents";
const FOOTER_GENERATING = "  ⏵⏵ auto mode on (shift+tab to cycle) · esc to interrupt · ← for agents";
const READY = [RULE, "❯ ", RULE, FOOTER_IDLE].join("\n");
const GENERATING = ["✽ Vibing…", RULE, "❯ ", RULE, FOOTER_GENERATING].join("\n");
const PERMISSION_DIALOG = [
  "▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔",
  "   Bash command: rm -rf build",
  "   Do you want to proceed?",
  "   ❯ 1. Yes",
  "     2. Yes, and don't ask again for rm commands",
  "     3. No, and tell Claude what to do differently (esc)",
].join("\n");
const LOGIN_FORM = ["   Login", "", "https://claude.com/cai/oauth/authorize?code=true&client_id=abc", "", "   Paste code here if prompted >", "", "   Esc to cancel"].join("\n");
const CHAT_WITH_LINK = ["● Open https://claude.ai/oauth/authorize?code=true&state=abc to log in", RULE, "❯ ", RULE, FOOTER_IDLE].join("\n");

const deps = () => ({ relayClient: null, broadcast: () => {}, addChatMessage: () => {} }) as any;
let n = 0;
const uid = (p: string) => `${p}-${Date.now().toString(36)}-${(n++).toString(36)}`;

function fakeTmux(init: { pane: string }) {
  const st = { pane: init.pane, keys: [] as string[], typed: [] as string[] };
  const driver = {
    async captureFresh() { return { ok: true, out: st.pane }; },
    captureCached() { return { ok: true, out: st.pane }; },
    async key(_t: string, ...ks: string[]) { st.keys.push(...ks); return { ok: true, out: "" }; },
    async literal(_t: string, text: string) { st.typed.push(text); return { ok: true, out: "" }; },
    async command() { return { ok: true, out: "" }; },
    async commandOnce() { return { ok: true, out: "" }; },
    runSync() { return { ok: true, out: "" }; },
    track() {}, untrack() {},
  } as unknown as TmuxDriver;
  return { st, driver };
}

function mkSession(id: string, tmux: TmuxDriver, extra: Record<string, unknown> = {}) {
  saveWindowRecord(id, { launchCwd: join(home, "cwd") }); // a launch always writes the record first
  return new Session(
    { id, tmuxWindow: `joy:j-${id}`, cwd: join(home, "cwd"), flags: [], status: "active", startedAt: 0, tmux, ...extra } as any,
    deps(),
  );
}

function relayStub(relaySessionId: string) {
  const thinking: boolean[] = [];
  const pushes: string[] = [];
  const rs: any = {
    relaySessionId,
    start() {}, stop() {}, pausePull() {},
    send() {},
    setThinking(t: boolean) { thinking.push(t); }, updateRetry() {}, async clearThinkingMeta() {}, async updateLogin() {}, async updateDialog() {},
    setReceiptSink() {}, stampReceiptOnLastQueued() {},
    updateQueue() {}, async updateBgTasks() {}, async updateContext() {}, updateCompacting() {}, updateGoal() {},
    notify(kind: string) { pushes.push(kind); }, notifyCustom() {}, async updateSummary() {}, async updateModelCode() {}, async archive() { return true; },
    updateJoyState() {},
  };
  return { rs, thinking, pushes };
}

// ── the full feed: submit → generating → stop → session end ─────────────────

test("hooks live: a fake hook feed drives submit → generating → stop → exit while the pane stays stale and contradictory", async () => {
  vi.useFakeTimers();
  const { st, driver } = fakeTmux({ pane: READY });
  const s = mkSession(uid("feed"), driver, { claudeSessionId: "sid" });
  const { rs } = relayStub("rs-feed");
  s.attachRelay(rs, true);
  s.beginWatching(); // pane polls run (3s thinking reconcile, 5s pid probe)
  expect(s.hookState().live).toBe(false);

  const item = s.enqueue("P the prompt", { mirrorToRelay: false, source: "rpc" });
  await vi.advanceTimersByTimeAsync(400);
  expect(st.keys).toContain("Enter");
  expect(s.queueState().inFlight).toBe("P the prompt");

  // 1. UserPromptSubmit with the exact text confirms delivery — the pane still
  //    shows an idle READY frame (stale), which no longer matters.
  s.onHookEvent({ event: "UserPromptSubmit", prompt: "P the prompt", prompt_id: "p1", permission_mode: "plan" });
  expect(s.hookState().live).toBe(true);
  expect(s.queueState().inFlight).toBeNull();
  expect(s.queueItemState(item.id)).toBe("delivered");
  expect(s.busy()).toBe(true);
  // permission_mode rode on the hook: persisted, and used where the footer is not on screen.
  expect(loadWindowRecord(s.id)?.claudePermissionMode).toBe("plan");
  expect(s.hookState().permissionMode).toBe("plan");

  // 2. Generating: the pane contradicts (idle READY frame for 30s of polls);
  //    with hooks live the pane cannot clear thinking.
  await vi.advanceTimersByTimeAsync(30_000);
  expect(s.busy()).toBe(true);
  s.onHookEvent({ event: "PostToolUse", tool_name: "Bash", permission_mode: "plan" });
  expect(s.busy()).toBe(true);

  // 3. Stop → idle instantly, even though the pane NOW shows a stale
  //    "esc to interrupt" frame — with hooks live the pane never SETS thinking (#479).
  st.pane = GENERATING;
  s.onHookEvent({ event: "Stop", permission_mode: "plan" });
  expect(s.busy()).toBe(false);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(s.busy()).toBe(false);

  // 4. SessionEnd(clear) is a conversation rotation: nothing ends.
  s.onHookEvent({ event: "SessionEnd", end_reason: "clear", session_id: "sid" });
  await vi.advanceTimersByTimeAsync(HOOK_SESSION_END_GRACE_MS + 10);
  expect(s.status).toBe("active");

  // 5. SessionEnd(other) with no live pid: detached after the grace — the pane
  //    still paints a healthy frame, and the old 60s frozen-frame grace is gone (#30).
  s.onHookEvent({ event: "SessionEnd", end_reason: "other", session_id: "sid" });
  expect(s.status).toBe("active"); // not on the hook alone
  await vi.advanceTimersByTimeAsync(HOOK_SESSION_END_GRACE_MS + 10);
  expect(s.status).toBe("ended");
  expect(s.endReason).toBe("process_exited");
});

test("hooks live: SessionEnd is withdrawn when the pid is still alive after the grace, or when a later hook proves the process lives on", async () => {
  vi.useFakeTimers();
  const { driver } = fakeTmux({ pane: READY });
  // Our own pid stands in for a claude that did not exit (a same-id restart replacement).
  const s = mkSession(uid("end-alive"), driver, { claudeSessionId: "sid", pid: process.pid });
  s.onHookEvent({ event: "SessionEnd", end_reason: "other", session_id: "sid" });
  expect(s.hookState().sessionEnd?.reason).toBe("other");
  await vi.advanceTimersByTimeAsync(HOOK_SESSION_END_GRACE_MS + 10);
  expect(s.status).toBe("active");
  expect(s.hookState().sessionEnd).toBeNull(); // handed back to the pid probe

  // A pending end followed by any other hook from the process is withdrawn.
  const t = mkSession(uid("end-withdrawn"), driver, { claudeSessionId: "sid" });
  t.onHookEvent({ event: "SessionEnd", end_reason: "prompt_input_exit", session_id: "sid" });
  t.onHookEvent({ event: "SessionStart", source: "startup", session_id: "sid" });
  await vi.advanceTimersByTimeAsync(HOOK_SESSION_END_GRACE_MS + 10);
  expect(t.status).toBe("active");
  expect(t.hookState().sessionEnd).toBeNull();

  // A SessionEnd for a different conversation id is not ours.
  const u = mkSession(uid("end-other-sid"), driver, { claudeSessionId: "sid" });
  u.onHookEvent({ event: "SessionEnd", end_reason: "other", session_id: "someone-else" });
  await vi.advanceTimersByTimeAsync(HOOK_SESSION_END_GRACE_MS + 10);
  expect(u.status).toBe("active");
  s.end("killed"); t.end("killed"); u.end("killed");
});

// ── #32: a foreign turn never confirms a plain prompt once hooks are live ────

test("#32 hooks live: a foreign turn start does NOT confirm the in-flight prompt even when the box reads empty; UserPromptSubmit does", async () => {
  vi.useFakeTimers();
  const { st, driver } = fakeTmux({ pane: READY });
  const s = mkSession(uid("foreign"), driver, { claudeSessionId: "sid" });
  s.onHookEvent({ event: "SessionStart", source: "startup", session_id: "sid" }); // latch on
  const item = s.enqueue("P the prompt", { mirrorToRelay: false, source: "rpc" });
  await vi.advanceTimersByTimeAsync(400);
  expect(st.keys).toContain("Enter");
  // The pane's box reads EMPTY (a misread, or the prompt scrolled) — the
  // hook-less rule would have confirmed on this turn start.
  s.onTranscriptEntry({ type: "assistant", uuid: "u-foreign", message: { role: "assistant", model: "claude-x", content: [{ type: "text", text: "handling a task notification" }] } } as any);
  expect(s.queueState().inFlight).toBe("P the prompt");
  expect(s.queueItemState(item.id)).toBe("pending");
  // The real confirmation: the hook with the exact text.
  s.onHookEvent({ event: "UserPromptSubmit", prompt: "P the prompt" });
  expect(s.queueState().inFlight).toBeNull();
  expect(s.queueItemState(item.id)).toBe("delivered");
  s.end("killed");
});

test("#32 hooks live: a slash command keeps the turn-start confirm (UserPromptSubmit does not fire for built-ins)", async () => {
  vi.useFakeTimers();
  const { st, driver } = fakeTmux({ pane: READY });
  const s = mkSession(uid("slash"), driver, { claudeSessionId: "sid" });
  const { rs } = relayStub("rs-slash");
  s.attachRelay(rs, true); // turn-start is only observed with a relay attached
  s.onHookEvent({ event: "SessionStart", source: "startup", session_id: "sid" });
  const item = s.enqueue("/compact focus on the tests", { mirrorToRelay: false, source: "rpc" });
  await vi.advanceTimersByTimeAsync(400);
  expect(st.keys).toContain("Enter");
  s.onTranscriptEntry({ type: "assistant", uuid: "u-cmd", message: { role: "assistant", model: "claude-x", content: [{ type: "text", text: "compacting" }] } } as any);
  expect(s.queueState().inFlight).toBeNull();
  expect(s.queueItemState(item.id)).toBe("delivered");
  s.end("killed");
});

// ── no hook ever: behaviour identical to today ──────────────────────────────

test("no hook seen: the pane rules stay in force — turn start confirms on an empty box, the pane sets and clears thinking, exit waits for the pid probe", async () => {
  vi.useFakeTimers();
  const { st, driver } = fakeTmux({ pane: READY });
  const s = mkSession(uid("no-hooks"), driver, { claudeSessionId: "sid" });
  const { rs } = relayStub("rs-no-hooks");
  s.attachRelay(rs, true);
  s.beginWatching();
  expect(s.hookState().live).toBe(false);

  // Turn-start confirm with an empty box (today's rule).
  const item = s.enqueue("P the prompt", { mirrorToRelay: false, source: "rpc" });
  await vi.advanceTimersByTimeAsync(400);
  expect(st.keys).toContain("Enter");
  s.onTranscriptEntry({ type: "assistant", uuid: "u-1", message: { role: "assistant", model: "claude-x", content: [{ type: "text", text: "on it" }] } } as any);
  expect(s.queueItemState(item.id)).toBe("delivered");
  s.onTranscriptEntry({ type: "system", subtype: "turn_duration", durationMs: 10 } as any);
  expect(s.busy()).toBe(false);

  // The pane SETS thinking on a generating frame…
  st.pane = GENERATING;
  await vi.advanceTimersByTimeAsync(3_100);
  expect(s.busy()).toBe(true);
  // …and CLEARS it after two idle reads (no lease: the pane set it).
  st.pane = READY;
  await vi.advanceTimersByTimeAsync(6_200);
  expect(s.busy()).toBe(false);
  expect(s.hookState().live).toBe(false);
  s.end("killed");
});

test("no hook seen: detectPermissionMode is the pane parser alone; with hooks live the hook value fills in when no box is on screen (#480)", () => {
  const { st, driver } = fakeTmux({ pane: PERMISSION_DIALOG }); // no live box → footer not on screen
  const s = mkSession(uid("mode"), driver, { claudeSessionId: "sid" });
  expect(s.detectPermissionMode()).toBe("default"); // today's guess
  s.onHookEvent({ event: "PostToolUse", tool_name: "Read", permission_mode: "acceptEdits" });
  expect(s.detectPermissionMode()).toBe("acceptEdits"); // the hook knows
  expect(loadWindowRecord(s.id)?.claudePermissionMode).toBe("acceptEdits");
  // With a live box the footer is fresher than the hook (a Shift+Tab fires no hook).
  st.pane = READY; // footer: auto mode on
  expect(s.detectPermissionMode()).toBe("auto");
  s.end("killed");
});

test("#480 a hook's permission_mode corrects a wrongly persisted mode", () => {
  const { driver } = fakeTmux({ pane: READY });
  const id = uid("mode-fix");
  const s = mkSession(id, driver, { claudeSessionId: "sid" });
  saveWindowRecord(id, { claudePermissionMode: "bypassPermissions" }); // the false success #480 used to persist
  s.onHookEvent({ event: "Stop", permission_mode: "plan" });
  expect(loadWindowRecord(id)?.claudePermissionMode).toBe("plan");
  s.end("killed");
});

// ── #482: the login-code gate ───────────────────────────────────────────────

test("#482 hooks live: /login-code types only inside an auth episode (StopFailure authentication_failed) — and never into a chat pane quoting the URL", async () => {
  const { st, driver } = fakeTmux({ pane: CHAT_WITH_LINK });
  const s = mkSession(uid("login"), driver, { claudeSessionId: "sid" });
  s.onHookEvent({ event: "SessionStart", source: "startup", session_id: "sid" });

  // No episode, no login bar → refused outright (even before the form check).
  st.pane = LOGIN_FORM;
  s.enqueue("/login-code secret-1");
  await new Promise((r) => setTimeout(r, 300));
  expect(st.typed.join("")).not.toContain("secret-1");

  // StopFailure(authentication_failed) opens the episode → the code goes in.
  s.onHookEvent({ event: "StopFailure", error_type: "authentication_failed" });
  expect(s.hookState().authFailure?.errorType).toBe("authentication_failed");
  expect(s.busy()).toBe(false);
  s.enqueue("/login-code secret-2");
  await vi.waitFor(() => expect(st.typed.join("")).toContain("secret-2"), { timeout: 3000 });
  await vi.waitFor(() => expect(st.keys).toContain("Enter"), { timeout: 3000 });

  // Inside the episode a chat pane that merely quotes the URL still gets nothing (the form is pane-only).
  st.pane = CHAT_WITH_LINK;
  s.enqueue("/login-code secret-3");
  await new Promise((r) => setTimeout(r, 300));
  expect(st.typed.join("")).not.toContain("secret-3");

  // Notification(auth_success) closes the episode → refused again.
  s.onHookEvent({ event: "Notification", notification_type: "auth_success", message: "Logged in" });
  expect(s.hookState().authFailure).toBeNull();
  st.pane = LOGIN_FORM;
  s.enqueue("/login-code secret-4");
  await new Promise((r) => setTimeout(r, 300));
  expect(st.typed.join("")).not.toContain("secret-4");
  s.end("killed");
});

test("#482 no hook seen: /login-code keeps today's pane-only gate (form on screen → typed)", async () => {
  const { st, driver } = fakeTmux({ pane: LOGIN_FORM });
  const s = mkSession(uid("login-legacy"), driver, { claudeSessionId: "sid" });
  s.enqueue("/login-code secret-legacy");
  await vi.waitFor(() => expect(st.typed.join("")).toContain("secret-legacy"), { timeout: 3000 });
  s.end("killed");
});

// ── needs_input ─────────────────────────────────────────────────────────────

test("PermissionRequest / Notification(permission_prompt) → needs_input (one push per episode); PostToolUse clears it; idle_prompt is idleness, not a question", () => {
  const { driver } = fakeTmux({ pane: PERMISSION_DIALOG });
  const s = mkSession(uid("needs-input"), driver, { claudeSessionId: "sid" });
  const { rs, pushes } = relayStub("rs-needs-input");
  s.attachRelay(rs, true);
  s.onHookEvent({ event: "UserPromptSubmit", prompt: "rm the build dir" });
  expect(s.busy()).toBe(true);
  s.onHookEvent({ event: "PermissionRequest", tool_name: "Bash", permission_mode: "default" });
  expect(s.needsInput()).toMatchObject({ kind: "permission", tool: "Bash" });
  s.onHookEvent({ event: "Notification", notification_type: "permission_prompt", message: "Claude needs your permission to use Bash" });
  s.onHookEvent({ event: "Notification", notification_type: "permission_prompt", message: "Claude needs your permission to use Bash" });
  expect(pushes).toEqual(["permission"]); // once per episode
  expect(s.needsInput()?.tool).toBe("Bash"); // the tool name from PermissionRequest survives
  s.onHookEvent({ event: "PostToolUse", tool_name: "Bash", permission_mode: "default" });
  expect(s.needsInput()).toBeNull();
  s.onHookEvent({ event: "Notification", notification_type: "idle_prompt", message: "Claude is waiting for your input" });
  expect(s.needsInput()).toBeNull();
  expect(s.busy()).toBe(false);
  s.end("killed");
});

test("PostToolUse is a refresh, not a setter: it re-asserts thinking only inside an open turn (a background subagent's tools cannot make an idle session busy)", () => {
  const { driver } = fakeTmux({ pane: READY });
  const s = mkSession(uid("post-tool"), driver, { claudeSessionId: "sid" });
  const { rs } = relayStub("rs-post-tool");
  s.attachRelay(rs, true);
  s.onHookEvent({ event: "Stop" });
  expect(s.busy()).toBe(false);
  s.onHookEvent({ event: "PostToolUse", tool_name: "Bash" }); // no turn open
  expect(s.busy()).toBe(false);
  s.end("killed");
});

test("StopFailure(rate_limit) clears thinking without opening an auth episode", () => {
  const { driver } = fakeTmux({ pane: READY });
  const s = mkSession(uid("stop-failure"), driver, { claudeSessionId: "sid" });
  s.onHookEvent({ event: "UserPromptSubmit", prompt: "go" });
  expect(s.busy()).toBe(true);
  s.onHookEvent({ event: "StopFailure", error_type: "rate_limit" });
  expect(s.busy()).toBe(false);
  expect(s.hookState().authFailure).toBeNull();
  s.end("killed");
});

test("an unknown hook event still flips the latch (a newer hook set is proof the forwarder is installed)", () => {
  const { driver } = fakeTmux({ pane: READY });
  const s = mkSession(uid("unknown-hook"), driver, { claudeSessionId: "sid" });
  expect(s.onHookEvent({ event: "PostToolBatch", permission_mode: "auto" })).toEqual({ ok: false });
  expect(s.hookState().live).toBe(true);
  expect(s.onHookEvent({})).toEqual({ ok: false });
  s.end("killed");
});
