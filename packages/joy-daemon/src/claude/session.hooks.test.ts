// Hook authority (spike Wave F, candidate A, step one — docs/review-campaign-
// 2026-09-claude-runtime-spike.md). A fake hook feed drives a real Session
// against a scripted pane that is STALE or CONTRADICTORY, asserting that hooks
// win once the session's `hooksLive` latch has flipped and that the pane
// rules apply unchanged when it never does (#30 #32 #479 #480 #482).
import { test, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Session, HOOK_SESSION_END_GRACE_MS, HOOK_NEEDS_INPUT_STALE_MS } from "./session";
import { queueFor } from "../domain/queueFacade";
import { loadWindowRecord, saveWindowRecord } from "../domain/windowRecord";
import * as windowRecords from "../domain/windowRecord";
import { ensureHookSettings } from "./hooks";
import type { TmuxDriver } from "../tmux/driver";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { dirname } from "node:path";
import { writeFileSync } from "fs";

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

  const item = queueFor(s).accept("P the prompt", { mirrorToRelay: false, source: "rpc" });
  await vi.advanceTimersByTimeAsync(400);
  expect(st.keys).toContain("Enter");
  expect(queueFor(s).state().inFlight).toBe("P the prompt");

  // 1. UserPromptSubmit with the exact text confirms delivery — the pane still
  //    shows an idle READY frame (stale), which no longer matters.
  s.onHookEvent({ event: "UserPromptSubmit", prompt: "P the prompt", prompt_id: "p1", permission_mode: "plan" });
  expect(s.hookState().live).toBe(true);
  expect(queueFor(s).state().inFlight).toBeNull();
  expect(queueFor(s).itemState(item.id)).toBe("delivered");
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
  const item = queueFor(s).accept("P the prompt", { mirrorToRelay: false, source: "rpc" });
  await vi.advanceTimersByTimeAsync(400);
  expect(st.keys).toContain("Enter");
  // The pane's box reads EMPTY (a misread, or the prompt scrolled) — the
  // hook-less rule would have confirmed on this turn start.
  s.onTranscriptEntry({ type: "assistant", uuid: "u-foreign", message: { role: "assistant", model: "claude-x", content: [{ type: "text", text: "handling a task notification" }] } } as any);
  expect(queueFor(s).state().inFlight).toBe("P the prompt");
  expect(queueFor(s).itemState(item.id)).toBe("pending");
  // The real confirmation: the hook with the exact text.
  s.onHookEvent({ event: "UserPromptSubmit", prompt: "P the prompt" });
  expect(queueFor(s).state().inFlight).toBeNull();
  expect(queueFor(s).itemState(item.id)).toBe("delivered");
  s.end("killed");
});

test("#32 hooks live: a slash command keeps the turn-start confirm (UserPromptSubmit does not fire for built-ins)", async () => {
  vi.useFakeTimers();
  const { st, driver } = fakeTmux({ pane: READY });
  const s = mkSession(uid("slash"), driver, { claudeSessionId: "sid" });
  const { rs } = relayStub("rs-slash");
  s.attachRelay(rs, true); // turn-start is only observed with a relay attached
  s.onHookEvent({ event: "SessionStart", source: "startup", session_id: "sid" });
  const item = queueFor(s).accept("/compact focus on the tests", { mirrorToRelay: false, source: "rpc" });
  await vi.advanceTimersByTimeAsync(400);
  expect(st.keys).toContain("Enter");
  s.onTranscriptEntry({ type: "assistant", uuid: "u-cmd", message: { role: "assistant", model: "claude-x", content: [{ type: "text", text: "compacting" }] } } as any);
  await vi.advanceTimersByTimeAsync(10); // the confirm awaits a FRESH box read (empty here)
  expect(queueFor(s).state().inFlight).toBeNull();
  expect(queueFor(s).itemState(item.id)).toBe("delivered");
  s.end("killed");
});

// ── #498: the transcript turn a dispatch opens is named for its attempt ──────
// Claude never names its turns. The session binds the relay turn it opens for a
// dispatch to that dispatch's attempt, so GET /sessions/:id/queue/:qid carries
// the `turn` the reply's records carry and `joy ask` binds on it instead of
// guessing the first turn started after the send (Astra F9: an earlier queued
// message's answer came back labelled as this one's).

const turnStartsSent = (sent: any[]) => sent.filter((m) => m?.content?.data?.ev?.t === "turn-start").map((m) => m.content.data.turn as string);

test("#498 hooks live: confirmed by UserPromptSubmit before any assistant entry, the dispatch is named the turn the transcript then opens", async () => {
  vi.useFakeTimers();
  const { st, driver } = fakeTmux({ pane: READY });
  const s = mkSession(uid("name-turn"), driver, { claudeSessionId: "sid" });
  const { rs } = relayStub("rs-name-turn");
  const sent: any[] = []; rs.send = (m: any) => { sent.push(m); };
  s.attachRelay(rs, true);
  s.onHookEvent({ event: "SessionStart", source: "startup", session_id: "sid" });
  const item = queueFor(s).accept("P name my turn", { mirrorToRelay: false, source: "rpc" });
  await vi.advanceTimersByTimeAsync(400);
  expect(st.keys).toContain("Enter");
  s.onHookEvent({ event: "UserPromptSubmit", prompt: "P name my turn", prompt_id: "p1", permission_mode: "plan" });
  // delivered and its turn started (the hook's edge) — but no relay turn exists yet to name
  expect(queueFor(s).command(item.id)).toMatchObject({ state: "running", turnStarted: true, runtimeTurnId: null });
  s.onTranscriptEntry({ type: "assistant", uuid: "u-1", message: { role: "assistant", model: "claude-x", content: [{ type: "text", text: "on it" }] } } as any);
  const [turn] = turnStartsSent(sent);
  expect(turn).toBeTruthy();
  expect(queueFor(s).command(item.id)).toMatchObject({ state: "running", turnStarted: true, runtimeTurnId: turn });
  s.onHookEvent({ event: "Stop", permission_mode: "plan" });
  expect(queueFor(s).command(item.id)).toMatchObject({ state: "completed", runtimeTurnId: turn });
  // A second dispatch behind it gets ITS OWN turn, not the first one's.
  s.onTranscriptEntry({ type: "system", subtype: "turn_duration", durationMs: 10 } as any);
  const second = queueFor(s).accept("P and another", { mirrorToRelay: false, source: "rpc" });
  await vi.advanceTimersByTimeAsync(400);
  s.onHookEvent({ event: "UserPromptSubmit", prompt: "P and another", prompt_id: "p2", permission_mode: "plan" });
  s.onTranscriptEntry({ type: "assistant", uuid: "u-2", message: { role: "assistant", model: "claude-x", content: [{ type: "text", text: "again" }] } } as any);
  const turns = turnStartsSent(sent);
  expect(turns).toHaveLength(2);
  expect(queueFor(s).command(second.id)).toMatchObject({ runtimeTurnId: turns[1], turnStarted: true });
  expect(queueFor(s).command(item.id)?.runtimeTurnId).toBe(turn);
  s.end("killed");
});

test("#498 no hooks: the turn-start confirm names the turn it confirmed on; a slash command runs no turn of its own", async () => {
  vi.useFakeTimers();
  const { st, driver } = fakeTmux({ pane: READY });
  const s = mkSession(uid("name-turn-nohooks"), driver, { claudeSessionId: "sid" });
  const { rs } = relayStub("rs-name-turn-nohooks");
  const sent: any[] = []; rs.send = (m: any) => { sent.push(m); };
  s.attachRelay(rs, true);
  const item = queueFor(s).accept("P the prompt", { mirrorToRelay: false, source: "rpc" });
  await vi.advanceTimersByTimeAsync(400);
  expect(st.keys).toContain("Enter");
  s.onTranscriptEntry({ type: "assistant", uuid: "u-1", message: { role: "assistant", model: "claude-x", content: [{ type: "text", text: "on it" }] } } as any);
  await vi.advanceTimersByTimeAsync(10); // the confirm awaits a FRESH box read (empty here)
  const [turn] = turnStartsSent(sent);
  expect(queueFor(s).command(item.id)).toMatchObject({ state: "running", runtimeTurnId: turn, turnStarted: true });
  s.onTranscriptEntry({ type: "assistant", uuid: "u-2", message: { role: "assistant", model: "claude-x", stop_reason: "end_turn", content: [{ type: "text", text: "done" }] } } as any);
  expect(queueFor(s).command(item.id)).toMatchObject({ state: "completed", runtimeTurnId: turn });
  // A slash command's delivery is its completion: no runtime turn, nothing to attribute.
  const cmd = queueFor(s).accept("/compact focus on the tests", { mirrorToRelay: false, source: "rpc" });
  await vi.advanceTimersByTimeAsync(400);
  s.onTranscriptEntry({ type: "assistant", uuid: "u-cmd", message: { role: "assistant", model: "claude-x", content: [{ type: "text", text: "compacting" }] } } as any);
  await vi.advanceTimersByTimeAsync(10);
  expect(queueFor(s).command(cmd.id)).toMatchObject({ state: "completed", runtimeTurnId: null, turnStarted: false });
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
  const item = queueFor(s).accept("P the prompt", { mirrorToRelay: false, source: "rpc" });
  await vi.advanceTimersByTimeAsync(400);
  expect(st.keys).toContain("Enter");
  s.onTranscriptEntry({ type: "assistant", uuid: "u-1", message: { role: "assistant", model: "claude-x", content: [{ type: "text", text: "on it" }] } } as any);
  await vi.advanceTimersByTimeAsync(10); // the confirm awaits a FRESH box read (empty here)
  expect(queueFor(s).itemState(item.id)).toBe("delivered");
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
  queueFor(s).accept("/login-code secret-1", { visible: true });
  await new Promise((r) => setTimeout(r, 300));
  expect(st.typed.join("")).not.toContain("secret-1");

  // StopFailure(authentication_failed) opens the episode → the code goes in.
  s.onHookEvent({ event: "StopFailure", error_type: "authentication_failed" });
  expect(s.hookState().authFailure?.errorType).toBe("authentication_failed");
  expect(s.busy()).toBe(false);
  queueFor(s).accept("/login-code secret-2", { visible: true });
  await vi.waitFor(() => expect(st.typed.join("")).toContain("secret-2"), { timeout: 3000 });
  await vi.waitFor(() => expect(st.keys).toContain("Enter"), { timeout: 3000 });

  // Inside the episode a chat pane that merely quotes the URL still gets nothing (the form is pane-only).
  st.pane = CHAT_WITH_LINK;
  queueFor(s).accept("/login-code secret-3", { visible: true });
  await new Promise((r) => setTimeout(r, 300));
  expect(st.typed.join("")).not.toContain("secret-3");

  // Notification(auth_success) closes the episode → refused again.
  s.onHookEvent({ event: "Notification", notification_type: "auth_success", message: "Logged in" });
  expect(s.hookState().authFailure).toBeNull();
  st.pane = LOGIN_FORM;
  queueFor(s).accept("/login-code secret-4", { visible: true });
  await new Promise((r) => setTimeout(r, 300));
  expect(st.typed.join("")).not.toContain("secret-4");
  s.end("killed");
});

test("#482 no hook seen: /login-code keeps today's pane-only gate (form on screen → typed)", async () => {
  const { st, driver } = fakeTmux({ pane: LOGIN_FORM });
  const s = mkSession(uid("login-legacy"), driver, { claudeSessionId: "sid" });
  queueFor(s).accept("/login-code secret-legacy", { visible: true });
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

// ── 617dc734 review: ingress fence, wire contract, live-process end, subagents, turn authority ──

test("ingress fence: a stale process's hooks (another conversation id) flip no latch, persist no mode, close no turn and confirm no dispatch", async () => {
  vi.useFakeTimers();
  const { driver } = fakeTmux({ pane: READY });
  const id = uid("fence");
  const s = mkSession(id, driver, { claudeSessionId: "new" });
  expect(s.onHookEvent({ event: "SessionEnd", session_id: "old", end_reason: "other", permission_mode: "bypassPermissions" })).toEqual({ ok: false });
  expect(s.hookState().live).toBe(false);                 // old code: latch flipped before the sid check
  expect(s.hookState().sessionEnd).toBeNull();
  expect(loadWindowRecord(id)?.claudePermissionMode).toBeUndefined(); // old code: overwritten
  // The live process opens a turn; the predecessor's Stop cannot close it.
  s.onHookEvent({ event: "UserPromptSubmit", session_id: "new", prompt: "live new turn" });
  expect(s.busy()).toBe(true);
  s.onHookEvent({ event: "Stop", session_id: "old" });
  expect(s.busy()).toBe(true);                            // old code: false
  s.onHookEvent({ event: "Stop", session_id: "new" });
  expect(s.busy()).toBe(false);
  // Nor can its text-matching UserPromptSubmit confirm the replacement's dispatch.
  const item = queueFor(s).accept("same prompt", { mirrorToRelay: false });
  await vi.advanceTimersByTimeAsync(400);
  s.onHookEvent({ event: "UserPromptSubmit", session_id: "old", prompt: "same prompt" });
  expect(queueFor(s).itemState(item.id)).toBe("pending");      // old code: delivered
  s.onHookEvent({ event: "UserPromptSubmit", session_id: "new", prompt: "same prompt" });
  expect(queueFor(s).itemState(item.id)).toBe("delivered");
  s.end("killed");
});

test("SessionEnd wire contract: the generated forwarder ships Claude's `reason` as end_reason (a /clear is a rotation, not an exit) plus the subagent identity", async () => {
  const settings = ensureHookSettings();
  expect(settings).not.toBe("");
  const script = join(dirname(settings), "joy-hook.mjs");
  const bodies: any[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    res.end("{}");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as any).port;
  const file = join(home, "daemon-wire.json");
  writeFileSync(file, JSON.stringify({ port, token: "test-only" }));
  try {
    for (const payload of [
      { hook_event_name: "SessionEnd", session_id: "sid", reason: "clear" },
      { hook_event_name: "PostToolUse", session_id: "sid", agent_id: "bg-id", agent_type: "Explore", permission_mode: "plan", tool_name: "Read" },
    ]) {
      const child = spawn(process.execPath, [script], { env: { ...process.env, JOY_SESSION_ID: "test-session", JOY_DAEMON_FILE: file, JOY_LAUNCH_ID: "launch-abc" }, stdio: ["pipe", "pipe", "pipe"] });
      child.stdin.end(JSON.stringify(payload));
      const [code] = await once(child, "exit");
      expect(code).toBe(0);
    }
    // A claude launched WITHOUT the env (predates the field) sends no launch_id at all.
    {
      const env: NodeJS.ProcessEnv = { ...process.env, JOY_SESSION_ID: "test-session", JOY_DAEMON_FILE: file };
      delete env.JOY_LAUNCH_ID;
      const child = spawn(process.execPath, [script], { env, stdio: ["pipe", "pipe", "pipe"] });
      child.stdin.end(JSON.stringify({ hook_event_name: "Stop", session_id: "sid" }));
      const [code] = await once(child, "exit");
      expect(code).toBe(0);
    }
    expect(bodies).toHaveLength(3);
    expect(bodies[0]).toEqual({ event: "SessionEnd", session_id: "sid", end_reason: "clear", launch_id: "launch-abc" }); // old script: reason dropped → "other"
    expect(bodies[1]).toMatchObject({ event: "PostToolUse", agent_id: "bg-id", agent_type: "Explore", permission_mode: "plan", launch_id: "launch-abc" });
    expect(bodies[2]).toEqual({ event: "Stop", session_id: "sid" });
    // Fed to a session exactly as received: a rotation keeps the session. The raw wire name is accepted too.
    vi.useFakeTimers();
    const { driver } = fakeTmux({ pane: READY });
    const s = mkSession(uid("real-clear"), driver, { claudeSessionId: "sid", hookLaunchId: "launch-abc" });
    expect(s.onHookEvent(bodies[0])).toEqual({ ok: true });
    expect(s.hookState().sessionEnd).toBeNull();
    // The same wire body reaching a session of ANOTHER launch (same route id, same sid) is not its process's.
    const other = mkSession(uid("other-launch"), driver, { claudeSessionId: "sid", hookLaunchId: "launch-xyz" });
    expect(other.onHookEvent(bodies[1])).toEqual({ ok: false });
    expect(other.hookState().live).toBe(false);
    expect(other.onHookEvent(bodies[2])).toEqual({ ok: false }); // no launch_id at all: not ours either
    other.end("killed");
    const t = mkSession(uid("raw-resume"), driver, { claudeSessionId: "sid" });
    t.onHookEvent({ event: "SessionEnd", session_id: "sid", reason: "resume" });
    expect(t.hookState().sessionEnd).toBeNull();
    await vi.advanceTimersByTimeAsync(HOOK_SESSION_END_GRACE_MS + 10);
    expect(s.status).toBe("active");
    expect(t.status).toBe("active");
    s.end("killed"); t.end("killed");
  } finally {
    vi.useRealTimers();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("SessionEnd: an unresolved pid is re-resolved to the pane shell's LIVE child before ending — a live claude outranks a late hook", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"]);
  vi.useFakeTimers();
  const { driver } = fakeTmux({ pane: READY });
  (driver as any).runSync = () => ({ ok: true, out: String(process.pid) }); // the pane shell is this process; the child is its live claude
  const s = mkSession(uid("pid-unresolved"), driver, { claudeSessionId: "resumed-sid" });
  try {
    s.onHookEvent({ event: "SessionEnd", session_id: "resumed-sid", end_reason: "other" });
    await vi.advanceTimersByTimeAsync(HOOK_SESSION_END_GRACE_MS + 10);
    expect(s.status).toBe("active");                      // old code: ended without looking for a child
    expect(s.hookState().sessionEnd).toBeNull();
    expect(s.pid).toBeDefined();
    expect(s.pid).not.toBe(process.pid);
  } finally { child.kill("SIGKILL"); s.end("killed"); }
});

test("subagent events: a background agent's PostToolUse neither answers the main permission wait, nor revives the main turn, nor persists its mode; SubagentStop persists no mode either", () => {
  const { driver } = fakeTmux({ pane: PERMISSION_DIALOG });
  const id = uid("subagent");
  const s = mkSession(id, driver, { claudeSessionId: "sid" });
  const { rs, thinking } = relayStub("rs-sub");
  s.attachRelay(rs, true);
  s.onTranscriptEntry({ type: "assistant", uuid: "open-turn", message: { role: "assistant", content: [{ type: "tool_use", id: "main-tool", name: "Bash", input: { command: "rm build" } }] } } as any);
  s.onHookEvent({ event: "PermissionRequest", session_id: "sid", tool_name: "Bash", permission_mode: "default" });
  expect(s.needsInput()?.kind).toBe("permission");
  expect(loadWindowRecord(id)?.claudePermissionMode).toBe("default");
  const before = thinking.length;
  s.onHookEvent({ event: "PostToolUse", session_id: "sid", agent_id: "background-agent", tool_name: "Read", permission_mode: "bypassPermissions" });
  expect(s.needsInput()?.kind).toBe("permission");        // old code: null
  expect(thinking.slice(before)).toEqual([]);             // old code: thinking re-asserted inside the main turn
  expect(loadWindowRecord(id)?.claudePermissionMode).toBe("default"); // old code: bypassPermissions
  s.onHookEvent({ event: "SubagentStop", session_id: "sid", agent_id: "background-agent", permission_mode: "bypassPermissions" });
  expect(loadWindowRecord(id)?.claudePermissionMode).toBe("default");
  // The main agent's own tool completion answers the main wait.
  s.onHookEvent({ event: "PostToolUse", session_id: "sid", tool_name: "Bash" });
  expect(s.needsInput()).toBeNull();
  // A subagent's permission wait is tagged with its actor and answered only by that actor's tool.
  s.onHookEvent({ event: "PermissionRequest", session_id: "sid", agent_id: "background-agent", tool_name: "Write" });
  expect(s.needsInput()?.kind).toBe("permission");
  s.onHookEvent({ event: "PostToolUse", session_id: "sid", tool_name: "Bash" });
  expect(s.needsInput()?.kind).toBe("permission");
  s.onHookEvent({ event: "PostToolUse", session_id: "sid", agent_id: "background-agent", tool_name: "Write" });
  expect(s.needsInput()).toBeNull();
  s.end("killed");
});

test("a hook permission wait survives ONE contradictory (mid-repaint) capture — only a dialog ABSENT for the stale window clears it", async () => {
  vi.useFakeTimers();
  const { st, driver } = fakeTmux({ pane: PERMISSION_DIALOG });
  const s = mkSession(uid("permission-flicker"), driver, { claudeSessionId: "sid", pid: process.pid });
  const { rs } = relayStub("rs-permission");
  s.attachRelay(rs, true);
  s.beginWatching();
  s.onHookEvent({ event: "PermissionRequest", session_id: "sid", tool_name: "Bash" });
  await vi.advanceTimersByTimeAsync(12_000);
  expect(s.needsInput()?.kind).toBe("permission");
  st.pane = READY; await vi.advanceTimersByTimeAsync(3_000);            // one contradictory poll
  st.pane = PERMISSION_DIALOG; await vi.advanceTimersByTimeAsync(3_000); // the dialog is back
  expect(s.needsInput()?.kind).toBe("permission");                       // old code: erased for good at the first READY read
  st.pane = READY; await vi.advanceTimersByTimeAsync(HOOK_NEEDS_INPUT_STALE_MS + 6_000);
  expect(s.needsInput()).toBeNull();                                     // absent long enough → stale, as intended
  s.end("killed");
});

test("a failed permission-mode record write is not cached as done — the next identical hook retries it", () => {
  const { driver } = fakeTmux({ pane: READY });
  const id = uid("persist-mode");
  const s = mkSession(id, driver, { claudeSessionId: "sid" });
  const spy = vi.spyOn(windowRecords, "saveWindowRecord").mockReturnValue(false);
  try {
    s.onHookEvent({ event: "PostToolUse", session_id: "sid", permission_mode: "plan" });
    expect(spy).toHaveBeenCalledTimes(1);
  } finally { spy.mockRestore(); }
  expect(loadWindowRecord(id)?.claudePermissionMode).not.toBe("plan");
  s.onHookEvent({ event: "Stop", session_id: "sid", permission_mode: "plan" });
  expect(loadWindowRecord(id)?.claudePermissionMode).toBe("plan");       // old code: cached as persisted, never retried
  s.end("killed");
});

test("hook authority owns readiness: after Stop a queued prompt dispatches against a stale generating footer, an open transcript turn no longer holds busy(), and a background PostToolUse does not revive it", async () => {
  vi.useFakeTimers();
  const { st, driver } = fakeTmux({ pane: GENERATING });                // the frame never repaints
  const s = mkSession(uid("stop-authority"), driver, { claudeSessionId: "sid" });
  const { rs, thinking } = relayStub("rs-stop");
  s.attachRelay(rs, true);
  // The transcript's turn is open (its turn_duration is still being tailed) when Stop fires.
  s.onTranscriptEntry({ type: "assistant", uuid: "partial", message: { role: "assistant", model: "claude-x", content: [{ type: "text", text: "done" }] } } as any);
  s.onHookEvent({ event: "Stop", session_id: "sid" });
  expect(s.busy()).toBe(false);                                          // old code: true — the transcript #turn held it
  const before = thinking.length;
  s.onHookEvent({ event: "PostToolUse", session_id: "sid", agent_id: "background-agent", tool_name: "Read" });
  expect(thinking.slice(before)).toEqual([]);                            // old code: thinking re-asserted
  expect(s.busy()).toBe(false);
  const item = queueFor(s).accept("next prompt", { mirrorToRelay: false });
  await vi.advanceTimersByTimeAsync(1_000);
  expect(st.typed).toContain("next prompt");                             // old code: vetoed by the stale footer for the whole retry loop
  expect(st.keys).toContain("Enter");
  // The transcript's late turn_duration for the OLD turn changes nothing…
  s.onTranscriptEntry({ type: "system", subtype: "turn_duration", durationMs: 5 } as any);
  expect(queueFor(s).itemState(item.id)).toBe("pending");
  // …and the main agent's UserPromptSubmit is the real next-turn edge.
  s.onHookEvent({ event: "UserPromptSubmit", session_id: "sid", prompt: "next prompt" });
  expect(queueFor(s).itemState(item.id)).toBe("delivered");
  expect(s.busy()).toBe(true);
  s.end("killed");
});

// ── e8f8b2cc review residual: the lagging transcript terminal vs the next hook-owned run ──

test("late transcript terminal (e8f8b2cc): Stop A → dispatch + UserPromptSubmit B → A's lagging turn_duration arrives → B stays running with its thinking and confirmation ref; B's own Stop ends it", async () => {
  vi.useFakeTimers();
  const { st, driver } = fakeTmux({ pane: READY });
  const s = mkSession(uid("late-tail"), driver, { claudeSessionId: "sid" });
  const { rs, thinking } = relayStub("rs-late-tail");
  s.attachRelay(rs, true);
  const { coordinatorFor } = await import("../domain/coordinator");
  const stoppedAt = Date.now();
  s.onHookEvent({ event: "Stop", session_id: "sid" });                  // A ends (hook-owned terminal)
  const item = queueFor(s).accept("new command", { mirrorToRelay: false });
  await vi.advanceTimersByTimeAsync(1_000);
  expect(st.keys).toContain("Enter");
  s.onHookEvent({ event: "UserPromptSubmit", session_id: "sid", prompt: "new command" });
  expect(coordinatorFor().state(item.id)).toBe("running");
  const thinkingBefore = thinking.length;
  // A's turn_duration is tailed only now: stamped when A ended, before B's admission…
  s.onTranscriptEntry({ type: "system", subtype: "turn_duration", timestamp: new Date(stoppedAt).toISOString(), durationMs: 5 } as any);
  expect(coordinatorFor().state(item.id)).toBe("running");               // old code: completed
  expect(thinking.slice(thinkingBefore)).toEqual([]);                     // B's thinking is not cleared by A's edge
  // …and the reviewer's exact shape — stamped at the admission instant — is an older edge too.
  s.onTranscriptEntry({ type: "system", subtype: "turn_duration", timestamp: new Date().toISOString(), durationMs: 5 } as any);
  expect(coordinatorFor().state(item.id)).toBe("running");
  expect(s.busy()).toBe(true);
  // A lagging end_turn assistant entry of A's is the same older edge.
  s.onTranscriptEntry({ type: "assistant", uuid: "a-tail", timestamp: new Date(stoppedAt).toISOString(), message: { role: "assistant", model: "claude-x", stop_reason: "end_turn", content: [{ type: "text", text: "A's last words" }] } } as any);
  expect(coordinatorFor().state(item.id)).toBe("running");
  // A prompt typed into B's turn would still be confirmed by B's evidence: the
  // confirmation ref survived the older edges (a turn start names it).
  expect(s.hookState().live).toBe(true);
  // B's own hook terminal is THE edge.
  await vi.advanceTimersByTimeAsync(10);
  s.onHookEvent({ event: "Stop", session_id: "sid" });
  expect(coordinatorFor().state(item.id)).toBe("completed");
  expect(s.busy()).toBe(false);
  // With B closed by its Stop, B's own late turn_duration is a harmless duplicate: nothing re-runs, nothing changes.
  s.onTranscriptEntry({ type: "system", subtype: "turn_duration", timestamp: new Date().toISOString(), durationMs: 5 } as any);
  expect(coordinatorFor().state(item.id)).toBe("completed");
  s.end("killed");
});

test("late transcript terminal (e8f8b2cc): the interrupt marker keeps its authority for the OPEN hook turn (no Stop fires on Esc) and loses it for an older one", async () => {
  vi.useFakeTimers();
  const { driver } = fakeTmux({ pane: READY });
  const s = mkSession(uid("late-marker"), driver, { claudeSessionId: "sid" });
  const { rs } = relayStub("rs-late-marker");
  s.attachRelay(rs, true);
  const { coordinatorFor } = await import("../domain/coordinator");
  const stoppedAt = Date.now();
  s.onHookEvent({ event: "Stop", session_id: "sid" });
  const item = queueFor(s).accept("interrupt me", { mirrorToRelay: false });
  await vi.advanceTimersByTimeAsync(1_000);
  s.onHookEvent({ event: "UserPromptSubmit", session_id: "sid", prompt: "interrupt me" });
  expect(coordinatorFor().state(item.id)).toBe("running");
  // An older turn's interrupt marker (tailed late) changes nothing…
  s.onTranscriptEntry({ type: "user", uuid: "m-old", timestamp: new Date(stoppedAt).toISOString(), message: { role: "user", content: "[Request interrupted by user]" } } as any);
  expect(coordinatorFor().state(item.id)).toBe("running");
  // …the marker for THIS turn (Esc in the pane, no hook reports it) cancels it.
  await vi.advanceTimersByTimeAsync(500);
  s.onTranscriptEntry({ type: "user", uuid: "m-now", timestamp: new Date().toISOString(), message: { role: "user", content: "[Request interrupted by user]" } } as any);
  expect(coordinatorFor().state(item.id)).toBe("cancelled");
  s.end("killed");
});

// ── 617dc734 review residuals: launch identity, fresh turn-start evidence, #480 persistence ──

test("launch fence: a hook that does not echo THIS launch's id — the retired predecessor under the same route id and the same conversation id (a --resume replacement) — flips no latch, persists no mode, arms no end, closes no turn and confirms no dispatch", async () => {
  vi.useFakeTimers();
  const { driver } = fakeTmux({ pane: READY });
  const id = uid("launch-fence");
  const s = mkSession(id, driver, { claudeSessionId: "sid", hookLaunchId: "L2" });
  expect(s.hookState().launchId).toBe("L2");
  const stale = { session_id: "sid", launch_id: "L1" }; // the predecessor: same sid (resumed conversation), older launch
  // SessionEnd from the predecessor: the replacement neither ends nor switches to hook authority.
  expect(s.onHookEvent({ event: "SessionEnd", end_reason: "other", permission_mode: "bypassPermissions", ...stale })).toEqual({ ok: false });
  expect(s.hookState().live).toBe(false);
  expect(s.hookState().sessionEnd).toBeNull();
  expect(loadWindowRecord(id)?.claudePermissionMode).toBeUndefined();
  await vi.advanceTimersByTimeAsync(HOOK_SESSION_END_GRACE_MS + 10);
  expect(s.status).toBe("active");
  // Our own process's events are honoured; the predecessor's Stop cannot close our turn.
  expect(s.onHookEvent({ event: "UserPromptSubmit", session_id: "sid", launch_id: "L2", prompt: "live turn" })).toEqual({ ok: true });
  expect(s.hookState().live).toBe(true);
  expect(s.busy()).toBe(true);
  s.onHookEvent({ event: "Stop", ...stale });
  expect(s.busy()).toBe(true);
  s.onHookEvent({ event: "Stop", session_id: "sid", launch_id: "L2" });
  expect(s.busy()).toBe(false);
  // A pending end of OURS is withdrawn only by our own later event, never by the predecessor's.
  s.onHookEvent({ event: "SessionEnd", end_reason: "other", session_id: "sid", launch_id: "L2" });
  expect(s.hookState().sessionEnd?.reason).toBe("other");
  s.onHookEvent({ event: "PostToolUse", tool_name: "Read", ...stale });
  expect(s.hookState().sessionEnd?.reason).toBe("other");
  s.onHookEvent({ event: "PostToolUse", tool_name: "Read", session_id: "sid", launch_id: "L2" });
  expect(s.hookState().sessionEnd).toBeNull();
  // Nor can the predecessor's text-matching UserPromptSubmit confirm our dispatch.
  const item = queueFor(s).accept("same prompt", { mirrorToRelay: false });
  await vi.advanceTimersByTimeAsync(400);
  s.onHookEvent({ event: "UserPromptSubmit", prompt: "same prompt", ...stale });
  expect(queueFor(s).itemState(item.id)).toBe("pending");
  // An event with NO launch id is not ours either (a claude launched by hand, or before the env existed).
  s.onHookEvent({ event: "UserPromptSubmit", session_id: "sid", prompt: "same prompt" });
  expect(queueFor(s).itemState(item.id)).toBe("pending");
  s.onHookEvent({ event: "UserPromptSubmit", session_id: "sid", launch_id: "L2", prompt: "same prompt" });
  expect(queueFor(s).itemState(item.id)).toBe("delivered");
  // A session recorded WITHOUT a launch id (launched before the field, or adopted) has nothing to fence on.
  const legacy = mkSession(uid("launch-legacy"), driver, { claudeSessionId: "sid" });
  expect(legacy.hookState().launchId).toBeNull();
  expect(legacy.onHookEvent({ event: "Stop", session_id: "sid", launch_id: "whatever" })).toEqual({ ok: true });
  expect(legacy.hookState().live).toBe(true);
  s.end("killed"); legacy.end("killed");
});

test("#32 residual: a turn start confirms the hook-less plain prompt and the command only on a FRESH box read — the cached frame's empty box no longer credits a prompt the live pane still holds", async () => {
  vi.useFakeTimers();
  for (const [live, prompt] of [[false, "plain P"], [true, "/compact focus"]] as const) {
    const { st, driver } = fakeTmux({ pane: READY });
    const s = mkSession(uid("fresh-evidence"), driver, { claudeSessionId: "sid" });
    const { rs } = relayStub("rs-fresh");
    s.attachRelay(rs, true); // the turn-start path is the relay's
    if (live) s.onHookEvent({ event: "SessionStart", source: "startup", session_id: "sid" });
    const item = queueFor(s).accept(prompt, { mirrorToRelay: false });
    await vi.advanceTimersByTimeAsync(400);
    expect(st.keys).toContain("Enter");
    // Paste-detection absorbed the Enter: the LIVE box still holds the text while the
    // cached sweep frame (captureCached) still reads the empty box from before the type.
    let freshReads = 0;
    (driver as any).captureFresh = async () => { freshReads++; return { ok: true, out: [RULE, `❯ ${prompt}`, RULE, FOOTER_IDLE].join("\n") }; };
    s.onTranscriptEntry({ type: "assistant", uuid: "foreign", message: { role: "assistant", content: [{ type: "text", text: "a foreign task's response" }] } } as any);
    await vi.advanceTimersByTimeAsync(10);
    expect(freshReads).toBe(1);
    expect(queueFor(s).itemState(item.id)).toBe("pending");      // old code: delivered off the stale cached frame
    expect(queueFor(s).state().inFlight).toBe(prompt);
    s.end("killed");
  }
  // The positive case: the fresh read shows the box EMPTY → the turn is ours (hook-less plain prompt).
  {
    const { st, driver } = fakeTmux({ pane: READY });
    (driver as any).captureCached = () => ({ ok: true, out: [RULE, "❯ plain Q", RULE, FOOTER_IDLE].join("\n") }); // the STALE side this time
    const s = mkSession(uid("fresh-empty"), driver, { claudeSessionId: "sid" });
    const { rs } = relayStub("rs-fresh-empty");
    s.attachRelay(rs, true);
    const item = queueFor(s).accept("plain Q", { mirrorToRelay: false });
    await vi.advanceTimersByTimeAsync(400);
    expect(st.keys).toContain("Enter");
    s.onTranscriptEntry({ type: "assistant", uuid: "ours", message: { role: "assistant", content: [{ type: "text", text: "on it" }] } } as any);
    await vi.advanceTimersByTimeAsync(10);
    expect(queueFor(s).itemState(item.id)).toBe("delivered");
    s.end("killed");
  }
});

test("#480 residual: setPermissionMode advances its persistence cache only on a successful record write — the next hook carrying the mode retries the lost write", async () => {
  const PLAN = [RULE, "❯ ", RULE, "  ⏸ plan mode on (shift+tab to cycle)"].join("\n");
  const { driver } = fakeTmux({ pane: PLAN });
  const id = uid("mode-write-fail");
  const s = mkSession(id, driver, { claudeSessionId: "sid" });
  s.onHookEvent({ event: "SessionStart", source: "startup", session_id: "sid" });
  const spy = vi.spyOn(windowRecords, "saveWindowRecord").mockReturnValue(false);
  let r: Awaited<ReturnType<typeof s.setPermissionMode>>;
  try {
    r = await s.setPermissionMode("plan");                  // already in plan: verified fresh, zero keys
    expect(spy).toHaveBeenCalledTimes(1);
  } finally { spy.mockRestore(); }
  expect(r!).toMatchObject({ ok: true, mode: "plan" });     // claude IS in plan — the mode set is true even though the record is not
  expect(loadWindowRecord(id)?.claudePermissionMode).toBeUndefined();
  s.onHookEvent({ event: "Stop", session_id: "sid", permission_mode: "plan" });
  expect(loadWindowRecord(id)?.claudePermissionMode).toBe("plan"); // old code: the cache said "plan" already — never retried
  s.end("killed");
});

test("#480 residual: detectPermissionMode lets the NEWER evidence win — a cached footer frame older than the last hook does not override it; a frame repainted after the hook (or of unknown age) does", () => {
  const { driver } = fakeTmux({ pane: READY }); // footer: auto mode on
  let at: number | undefined;
  (driver as any).captureCached = () => ({ ok: true, out: READY, ...(at !== undefined ? { at } : {}) });
  const s = mkSession(uid("mode-freshness"), driver, { claudeSessionId: "sid" });
  at = Date.now() - 60_000;                                  // the sweep's frame predates the whole turn
  s.onHookEvent({ event: "PostToolUse", session_id: "sid", tool_name: "Read", permission_mode: "plan" });
  expect(s.detectPermissionMode()).toBe("plan");             // old code: "auto" off the stale frame
  at = Date.now() + 1;                                       // a repaint after the hook (a terminal Shift+Tab fires none)
  expect(s.detectPermissionMode()).toBe("auto");
  at = undefined;                                            // unknown age: today's footer-wins rule
  expect(s.detectPermissionMode()).toBe("auto");
  s.end("killed");
});

test("promptReadiness is the one decision the gates consume: it names the holding gate off the runtime turn, not the transcript's tail", () => {
  const { driver } = fakeTmux({ pane: GENERATING });
  const s = mkSession(uid("readiness"), driver, { claudeSessionId: "sid" });
  const { rs } = relayStub("rs-readiness");
  s.attachRelay(rs, true);
  expect(s.promptReadiness()).toEqual({ ready: true, reason: "clear to send" });
  s.onTranscriptEntry({ type: "assistant", uuid: "open", message: { role: "assistant", content: [{ type: "text", text: "working" }] } } as any);
  expect(s.promptReadiness()).toEqual({ ready: false, reason: "turn running (transcript)" });
  expect(s.turnOpen()).toBe(true);
  s.onHookEvent({ event: "Stop", session_id: "sid" });       // hook authority closes it while the tail is still open
  expect(s.turnOpen()).toBe(false);
  expect(s.promptReadiness()).toEqual({ ready: true, reason: "clear to send" });
  s.onHookEvent({ event: "UserPromptSubmit", session_id: "sid", prompt: "next" });
  s.onTranscriptEntry({ type: "assistant", uuid: "open-2", message: { role: "assistant", content: [{ type: "text", text: "again" }] } } as any);
  expect(s.promptReadiness()).toEqual({ ready: false, reason: "turn running (hook)" });
  s.end("killed");
  expect(s.promptReadiness()).toEqual({ ready: false, reason: "session ended" });
});
