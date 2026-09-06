// Dispatch / steer / receipt regressions from the 2026-09 review campaign
// (#30 #31 #32 #33 #34 #35 #37 #39 #40 #110 #474 #475 #476 #477 #482 #483
// #484). Each drives a real Session against a scripted TmuxDriver (and, where
// receipts matter, a relay stub + the real receipt store under an isolated
// JOY_HOME_DIR) — the live path minus the tmux server.
import { test, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, appendFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Session, isSystemPromptEntry, paneShowsLoginForm } from "./session";
import { saveWindowRecord, loadWindowRecord } from "../domain/windowRecord";
import { ledgerFor } from "../domain/ledger";
import type { TmuxDriver } from "../tmux/driver";

let home: string;
beforeAll(() => { home = mkdtempSync(join(tmpdir(), "joy-c3-dispatch-")); process.env.JOY_HOME_DIR = home; });
afterAll(() => { delete process.env.JOY_HOME_DIR; rmSync(home, { recursive: true, force: true }); });
afterEach(() => { vi.useRealTimers(); });

const RULE = "─".repeat(60);
const FOOTER_IDLE = "  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents";
const FOOTER_GENERATING = "  ⏵⏵ auto mode on (shift+tab to cycle) · esc to interrupt · ← for agents";
const READY = [RULE, "❯ ", RULE, FOOTER_IDLE].join("\n");
const GENERATING = ["✽ Vibing…", RULE, "❯ ", RULE, FOOTER_GENERATING].join("\n");
const boxWith = (text: string) => [RULE, `❯ ${text}`, RULE, FOOTER_IDLE].join("\n");
const PERMISSION_DIALOG = [
  "▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔",
  "   Bash command: rm -rf build",
  "   Do you want to proceed?",
  "   ❯ 1. Yes",
  "     2. Yes, and don't ask again for rm commands",
  "     3. No, and tell Claude what to do differently (esc)",
].join("\n");

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));
const deps = () => ({ relayClient: null, broadcast: () => {}, addChatMessage: () => {} }) as any;
let n = 0;
const uid = (p: string) => `${p}-${Date.now().toString(36)}-${(n++).toString(36)}`;

/** Scripted tmux: a mutable pane, recorded keys/literals, and per-call hooks. */
function fakeTmux(init: { pane: string }) {
  const st = {
    pane: init.pane,
    keys: [] as string[],
    typed: [] as string[],
    onKey: null as null | ((k: string) => void | Promise<void>),
    onLiteral: null as null | ((t: string) => void | Promise<void>),
    onCapture: null as null | (() => void | Promise<void>),
    runSync: (() => ({ ok: true, out: "" })) as (...a: string[]) => { ok: boolean; out: string },
  };
  const driver = {
    async captureFresh() { await st.onCapture?.(); return { ok: true, out: st.pane }; },
    captureCached() { return { ok: true, out: st.pane }; },
    async key(_t: string, ...ks: string[]) { for (const k of ks) { st.keys.push(k); await st.onKey?.(k); } return { ok: true, out: "" }; },
    async literal(_t: string, text: string) { st.typed.push(text); await st.onLiteral?.(text); return { ok: true, out: "" }; },
    async command() { return { ok: true, out: "" }; },
    async commandOnce() { return { ok: true, out: "" }; },
    runSync(...a: string[]) { return st.runSync(...a); },
    track() {}, untrack() {},
  } as unknown as TmuxDriver;
  return { st, driver };
}

function mkSession(id: string, tmux: TmuxDriver, extra: Record<string, unknown> = {}, d = deps()) {
  return new Session(
    { id, tmuxWindow: `joy:j-${id}`, cwd: join(home, "cwd"), flags: [], status: "active", startedAt: 0, tmux, ...extra } as any,
    d,
  );
}

/** Relay stub: records rows sent, answers receipt stamps by acking through the sink. */
function relayStub(relaySessionId: string) {
  const sent: any[] = [];
  let sink: ((r: { uuid: string; turn: string }) => void) | null = null;
  const rs: any = {
    relaySessionId,
    start() {}, stop() {}, pausePull() {},
    send(row: any) { sent.push(row); },
    setThinking() {}, updateRetry() {}, async clearThinkingMeta() {}, async updateLogin() {}, async updateDialog() {},
    setReceiptSink(fn: any) { sink = fn; },
    stampReceiptOnLastQueued(r: { uuid: string; turn: string }) { sink?.(r); }, // server ack, synchronously
    updateQueue() {}, async updateBgTasks() {}, async updateContext() {}, updateCompacting() {}, updateGoal() {},
    notify() {}, notifyCustom() {}, async updateSummary() {}, async updateModelCode() {}, async archive() { return true; },
    updateJoyState() {},
  };
  const userRows = () => sent.filter((r) => r?.role === "user");
  return { rs, sent, userRows };
}

// ── #39 ──────────────────────────────────────────────────────────────────────

test("#39 sendRawKeys literal mode types multi-line text as lines joined by Enter", async () => {
  const { st, driver } = fakeTmux({ pane: READY });
  const s = mkSession(uid("raw"), driver);
  const r = await s.sendRawKeys("git commit\n-m 'x'\n", { literal: true });
  expect(r.ok).toBe(true);
  expect(st.typed).toEqual(["git commit", "-m 'x'"]);
  expect(st.keys).toEqual(["Enter", "Enter"]);
  s.end("killed");
});

// ── #33 ──────────────────────────────────────────────────────────────────────

test("#33 a steer never types into an open dialog — it parks on the queue head instead", async () => {
  const { st, driver } = fakeTmux({ pane: PERMISSION_DIALOG });
  const s = mkSession(uid("steer-dialog"), driver);
  s.enqueue("/steer 2 things: also run the tests");
  await settle(700);
  expect(st.typed.join("")).not.toContain("2 things");
  expect(st.keys).not.toContain("Enter");
  expect(s.queueState().pendingCount).toBe(1);   // parked, not lost
  expect(s.queueState().paused).toBe(false);      // nothing is wrong with the pane
  // The dialog resolves → the drain gate delivers it.
  st.pane = READY;
  s.resumeQueue();
  await vi.waitFor(() => expect(st.typed.join("")).toContain("2 things"), { timeout: 5000 });
  s.end("killed");
});

// ── #34 ──────────────────────────────────────────────────────────────────────

test("#34 the drain pump stands down while a steer owns the pane (no C-u on the steered text)", async () => {
  const { st, driver } = fakeTmux({ pane: GENERATING });
  const s = mkSession(uid("steer-drain"), driver);
  s.enqueue("queued behind the turn");        // held: pane is generating
  await settle(50);
  // The turn ends the instant the steer is typed: the box now shows S, idle.
  st.onLiteral = (t) => { if (t.includes("steer me")) st.pane = boxWith("steer me"); };
  st.onKey = (k) => { if (k === "Enter") st.pane = READY; };
  s.enqueue("/steer steer me");
  await settle(20);
  s.enqueue("another queued one");             // a drain trigger landing mid-steer
  await vi.waitFor(() => expect(st.keys).toContain("Enter"), { timeout: 3000 });
  // Old behaviour: the drain saw "steer me" as a stray draft and C-u'd it before the Enter.
  expect(st.keys.slice(0, st.keys.indexOf("Enter"))).not.toContain("C-u");
  // Once the steer landed, the queue drains normally.
  await vi.waitFor(() => expect(st.typed.join("|")).toContain("queued behind the turn"), { timeout: 5000 });
  s.end("killed");
});

// ── #35 ──────────────────────────────────────────────────────────────────────

test("#35 cancelQueued cancels an in-flight item whose Enter has not landed", async () => {
  const { st, driver } = fakeTmux({ pane: READY });
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  st.onLiteral = () => held;                    // the type hangs in the FIFO
  const s = mkSession(uid("cancel-typing"), driver);
  const item = s.enqueue("cancel me");
  await vi.waitFor(() => expect(s.queueState().inFlight).toBe("cancel me"));
  expect(s.cancelQueued(item.id)).toBe(true);   // used to be false: "not in the queue any more"
  release();
  await settle(600);                            // past ENTER_SUBMIT_DELAY_MS
  expect(st.keys).not.toContain("Enter");
  expect(s.queueItemState(item.id)).toBe("cancelled");
  expect(s.queueState().inFlight).toBeNull();
  s.end("killed");
});

test("#35 abort() during the typing window cancels that dispatch instead of treating its submit as a new send", async () => {
  const { st, driver } = fakeTmux({ pane: READY });
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  st.onLiteral = () => held;
  const s = mkSession(uid("abort-typing"), driver);
  const item = s.enqueue("abort me");
  await vi.waitFor(() => expect(s.queueState().inFlight).toBe("abort me"));
  // abort's own capture is what lets the typing finish (the FIFO drains) — the
  // submit timer is armed by the time abort re-reads state, i.e. it appeared
  // DURING abort's await for the same in-flight item.
  st.onCapture = async () => { release(); await settle(10); };
  const r = await s.abort();
  expect(r.ok).toBe(true);
  await settle(600);
  expect(st.keys).not.toContain("Enter");       // the Enter was cancelled
  expect(st.keys).toContain("Escape");
  expect(s.queueItemState(item.id)).toBe("cancelled");
  s.end("killed");
});

// ── #475 ─────────────────────────────────────────────────────────────────────

test("#475 Stop during the 5xx retry backoff cancels the scheduled retry even though the pane is idle", async () => {
  const notes: string[] = [];
  const { driver } = fakeTmux({ pane: READY });
  const s = mkSession(uid("retry-stop"), driver, { claudeSessionId: "sid" }, { relayClient: null, broadcast: () => {}, addChatMessage: (m: any) => { if (m.role === "assistant") notes.push(String(m.content)); } });
  s.onTranscriptEntry({ type: "system", subtype: "api_error", error: { formatted: "503 overloaded", status: 503 }, retryAttempt: 10, maxRetries: 10 } as any);
  s.onTranscriptEntry({ type: "system", subtype: "turn_duration", durationMs: 100 } as any);
  expect(notes.some((t) => /retrying in 15s/.test(t))).toBe(true);
  const r = await s.abort();
  expect(r.ok).toBe(true);
  expect(notes).toContain("Auto-retry cancelled"); // old code: idle guard returned first, timer stayed armed
  s.end("killed");
});

// ── #476 ─────────────────────────────────────────────────────────────────────

test("#476 a preserved terminal draft is restored ONCE after a slash-command echo", async () => {
  const { st, driver } = fakeTmux({ pane: boxWith("human draft") });
  st.onKey = (k) => { if (k === "C-u" || k === "Enter") st.pane = READY; };
  const s = mkSession(uid("draft-once"), driver);
  s.enqueue("/status");
  await vi.waitFor(() => expect(st.keys).toContain("Enter"), { timeout: 5000 });
  // The command echoes (system/local_command shape) → dispatch confirmed → draft restore.
  s.onTranscriptEntry({ type: "system", subtype: "local_command", content: "<command-name>/status</command-name>", timestamp: new Date().toISOString() } as any);
  await settle(300);
  expect(st.typed.filter((t) => t === "human draft")).toHaveLength(1);
  s.end("killed");
});

// ── #477 ─────────────────────────────────────────────────────────────────────

test("#477 a content-block user prompt (text + image) is mirrored like a string prompt", () => {
  const chat: any[] = [];
  const { driver } = fakeTmux({ pane: READY });
  const s = mkSession(uid("blocks"), driver, { claudeSessionId: "sid" }, { relayClient: null, broadcast: () => {}, addChatMessage: (m: any) => chat.push(m) });
  const { rs, userRows } = relayStub("rs-blocks");
  s.attachRelay(rs, true);
  s.onTranscriptEntry({
    type: "user", uuid: "u-blk", timestamp: new Date().toISOString(),
    message: { role: "user", content: [{ type: "text", text: "Explain this screenshot" }, { type: "image", source: { type: "base64", data: "AAAA" } }] },
  } as any);
  expect(chat.some((m) => m.role === "user" && m.content === "Explain this screenshot")).toBe(true);
  expect(userRows().some((r) => r.content?.text === "Explain this screenshot")).toBe(true);
  // A tool_result-only entry still produces no user bubble.
  s.onTranscriptEntry({ type: "user", uuid: "u-tr", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } } as any);
  expect(chat.filter((m) => m.role === "user")).toHaveLength(1);
  s.end("killed");
});

// ── #110 ─────────────────────────────────────────────────────────────────────

test("#110 a <task-notification> user entry is never the 5xx retry prompt", () => {
  expect(isSystemPromptEntry({ promptSource: "system" }, "anything")).toBe(true);
  expect(isSystemPromptEntry({ origin: { kind: "task-notification" } }, "x")).toBe(true);
  expect(isSystemPromptEntry({}, "<task-notification>\n<task-id>abc</task-id>")).toBe(true);
  expect(isSystemPromptEntry({}, "please fix the tests")).toBe(false);
});

test("#110 retry after a notification-started turn re-sends nothing instead of the notification XML", async () => {
  vi.useFakeTimers();
  const notes: string[] = [];
  const { st, driver } = fakeTmux({ pane: READY });
  const s = mkSession(uid("notif-retry"), driver, { claudeSessionId: "sid" }, { relayClient: null, broadcast: () => {}, addChatMessage: (m: any) => { if (m.role === "assistant") notes.push(String(m.content)); } });
  s.onTranscriptEntry({ type: "user", uuid: "u-tn", promptSource: "system", message: { role: "user", content: "<task-notification>\n<task-id>t1</task-id>\n<status>completed</status>\n</task-notification>" } } as any);
  s.onTranscriptEntry({ type: "system", subtype: "api_error", error: { formatted: "503", status: 503 } } as any);
  s.onTranscriptEntry({ type: "system", subtype: "turn_duration", durationMs: 1 } as any);
  await vi.advanceTimersByTimeAsync(15_500);
  expect(st.typed.join("")).not.toContain("task-notification");
  expect(notes.some((t) => /no prompt to re-send/.test(t))).toBe(true);
  s.end("killed");
});

// ── #474 ─────────────────────────────────────────────────────────────────────

test("#474 a replacement with a locked title does not publish the transcript's old ai-title on attach", () => {
  const id = uid("title-lock");
  const dir = join(home, "transcripts"); mkdirSync(dir, { recursive: true });
  const tp = join(dir, `${id}.jsonl`);
  writeFileSync(tp, JSON.stringify({ type: "ai-title", aiTitle: "Old project", timestamp: new Date().toISOString() }) + "\n");
  saveWindowRecord(id, { launchCwd: join(home, "cwd"), titleLockedByUser: true } as any);
  const { driver } = fakeTmux({ pane: READY });
  const s = mkSession(id, driver, { transcriptPath: tp });
  const summaries: string[] = [];
  const { rs } = relayStub("rs-" + id);
  rs.updateSummary = async (t: string) => { summaries.push(t); };
  s.attachRelay(rs, true);
  expect(summaries).toEqual([]);                 // old code: ["Old project"]
  expect(s.toJSON().summary).toBeUndefined();
  s.end("killed");
});

// ── #483 ─────────────────────────────────────────────────────────────────────

test("#483 a UserPromptSubmit hook that confirms before the Enter write resolves still yields exactly one mirrored bubble", async () => {
  const { st, driver } = fakeTmux({ pane: READY });
  let releaseEnter!: () => void;
  const enterHeld = new Promise<void>((r) => { releaseEnter = r; });
  st.onKey = (k) => (k === "Enter" ? enterHeld : undefined);
  const s = mkSession(uid("fast-hook"), driver, { claudeSessionId: "sid" });
  const { rs, userRows } = relayStub("rs-fast-hook");
  s.attachRelay(rs, true);
  s.enqueue("mirror me once", { mirrorToRelay: true, visible: false, source: "rpc" });
  await vi.waitFor(() => expect(st.keys).toContain("Enter"), { timeout: 3000 });
  s.onHookEvent({ event: "UserPromptSubmit", prompt: "mirror me once" });   // hook lands while the Enter write is pending
  expect(s.queueState().inFlight).toBeNull();
  releaseEnter();
  await settle(50);
  expect(userRows().filter((r) => r.content?.text === "mirror me once")).toHaveLength(1);
  // The transcript echo is deduped by the pending receipt — no second bubble.
  s.onTranscriptEntry({ type: "user", uuid: "u-echo-1", message: { role: "user", content: "mirror me once" } } as any);
  expect(userRows().filter((r) => r.content?.text === "mirror me once")).toHaveLength(1);
  s.end("killed");
});

// ── #484 ─────────────────────────────────────────────────────────────────────

test("#484 a synthetic command note persists its receipt, so a replacement's replay does not re-emit it", () => {
  const id = uid("note-receipt");
  const rsId = "rs-" + id;
  const notes: string[] = [];
  const d = () => ({ relayClient: null, broadcast: () => {}, addChatMessage: (m: any) => { if (m.role === "assistant") notes.push(String(m.content)); } });
  const entry = { type: "user", uuid: "u-note-1", timestamp: new Date().toISOString(), message: { role: "user", content: "<local-command-stdout>Model set to Fable</local-command-stdout>" } } as any;
  const a = mkSession(id, fakeTmux({ pane: READY }).driver, { claudeSessionId: "sid" }, d());
  a.attachRelay(relayStub(rsId).rs, true);
  a.onTranscriptEntry(entry);
  expect(notes).toEqual(["Model set to Fable"]);
  a.end("restart");
  // Same relay session, fresh process: the replay of the same uuid must be receipt-deduped.
  const b = mkSession(id, fakeTmux({ pane: READY }).driver, { claudeSessionId: "sid" }, d());
  b.attachRelay(relayStub(rsId).rs, true);
  b.onTranscriptEntry(entry);
  expect(notes).toEqual(["Model set to Fable"]); // old code: emitted twice
  b.end("killed");
});

// ── #31 ──────────────────────────────────────────────────────────────────────

test("#31 a late echo after a dispatch timeout drops the requeued twin and resumes, without a duplicate bubble", async () => {
  vi.useFakeTimers();
  const { st, driver } = fakeTmux({ pane: READY });
  const s = mkSession(uid("late-echo"), driver, { claudeSessionId: "sid" });
  const { rs, userRows } = relayStub("rs-late-echo");
  s.attachRelay(rs, true);
  const item = s.enqueue("slow to echo", { mirrorToRelay: false, visible: false, source: "relay", seq: 1 });
  await vi.advanceTimersByTimeAsync(400);        // typed + Enter
  expect(st.keys).toContain("Enter");
  await vi.advanceTimersByTimeAsync(30_500);     // echo window expires: requeued + paused
  expect(s.queueState().paused).toBe(true);
  expect(s.queueState().pauseReason).toBe("dispatch_timeout");
  expect(s.queueState().pendingCount).toBe(1);
  // The message DID land — its echo arrives late.
  s.onTranscriptEntry({ type: "user", uuid: "u-late", message: { role: "user", content: "slow to echo" } } as any);
  expect(userRows()).toHaveLength(0);            // old code: mirrored as a second bubble
  expect(s.queueState().pendingCount).toBe(0);   // old code: twin still queued → re-run on resume
  expect(s.queueState().paused).toBe(false);
  // #31 residual: the late echo COMMITS the delivered outcome (the ledger
  // attempt it matched settles the command) — the lane's per-item state is
  // never "unknown" for work that ran.
  expect(s.queueItemState(item.id)).toBe("delivered");
  s.end("killed");
});

// ── #32 ──────────────────────────────────────────────────────────────────────

test("#32 a foreign turn start does not confirm a dispatch whose text still sits in the input box", async () => {
  vi.useFakeTimers();
  const { st, driver } = fakeTmux({ pane: READY });
  const s = mkSession(uid("swallowed-enter"), driver, { claudeSessionId: "sid" });
  const { rs } = relayStub("rs-swallowed");
  s.attachRelay(rs, true);
  const item = s.enqueue("P the prompt", { mirrorToRelay: false, source: "rpc" });
  await vi.advanceTimersByTimeAsync(400);
  expect(st.keys).toContain("Enter");
  st.pane = boxWith("P the prompt");             // paste-detection absorbed the Enter: P is still in the box
  s.onTranscriptEntry({ type: "assistant", uuid: "u-foreign", message: { role: "assistant", model: "claude-x", content: [{ type: "text", text: "handling the task notification" }] } } as any);
  expect(s.queueState().inFlight).toBe("P the prompt"); // old code: null — "delivered", prompt lost
  expect(s.queueItemState(item.id)).toBe("pending");
  s.end("killed");
});

// ── #40 ──────────────────────────────────────────────────────────────────────

test("#40 a `!cmd` dispatch is confirmed by its <bash-input> echo", async () => {
  const { st, driver } = fakeTmux({ pane: READY });
  const s = mkSession(uid("bang"), driver, { claudeSessionId: "sid" });
  const item = s.enqueue("!make deploy", { source: "rpc" });
  await vi.waitFor(() => expect(st.keys).toContain("Enter"), { timeout: 3000 });
  expect(s.queueState().inFlight).toBe("!make deploy");
  s.onTranscriptEntry({ type: "user", uuid: "u-bash", message: { role: "user", content: "<bash-input>make deploy</bash-input>" } } as any);
  expect(s.queueState().inFlight).toBeNull();
  expect(s.queueItemState(item.id)).toBe("delivered");
  s.end("killed");
});

// ── #37 ──────────────────────────────────────────────────────────────────────

test("#37 a checkpoint armed before a /clear rebind persists the NEW binding, not the old path", async () => {
  vi.useFakeTimers();
  const id = uid("ckpt");
  const dir = join(home, "ckpt-" + id); mkdirSync(dir, { recursive: true });
  const f1 = join(dir, "one.jsonl"); const f2 = join(dir, "two.jsonl");
  const line = (t: string) => JSON.stringify({ type: "system", subtype: "turn_duration", durationMs: 1, note: t }) + "\n";
  writeFileSync(f1, line("a"));
  writeFileSync(f2, line("b") + line("c"));
  saveWindowRecord(id, { launchCwd: dir } as any);
  const s = mkSession(id, fakeTmux({ pane: READY }).driver, { claudeSessionId: "sid" });
  s.startTailer(f1);                             // entry from f1 arms the 5s checkpoint timer
  appendFileSync(f1, "");                        // no-op; the attach read already delivered the line
  await vi.advanceTimersByTimeAsync(10);
  s.startTailer(f2, true);                       // /clear → rebind inside the window
  await vi.advanceTimersByTimeAsync(6_000);
  const cp = ledgerFor().getCheckpoint(id, "claude_transcript");
  expect(cp?.ref).toBe(f2);                      // old code: f1 with f2's offset
  expect(cp?.offset).toBe(Buffer.byteLength(line("b") + line("c")));
  s.end("killed");
});

// ── #30 ──────────────────────────────────────────────────────────────────────

test("#30 a session whose pid is the pane's login shell re-resolves or ends instead of living forever", () => {
  const { st, driver } = fakeTmux({ pane: "claude@host:~/proj$ " });   // Claude exited: shell prompt
  st.runSync = (...a: string[]) => a[0] === "display-message" ? { ok: true, out: `${process.pid}\n` } : { ok: true, out: "" };
  const s = mkSession(uid("shell-pid"), driver, { pid: process.pid, claudeSessionId: "sid" });
  s.beginWatching();
  // Either the real child was found (test runner spawned one) or the shell had none → detached.
  // The old code did neither: pid alive → never re-resolved, never ended.
  expect(s.status === "ended" || s.toJSON().pid !== process.pid).toBe(true);
  if (s.status === "ended") expect(s.endReason).toBe("process_exited");
  else s.end("killed");
});

// ── #482 ─────────────────────────────────────────────────────────────────────

test("#482 /login-code needs the real login form — an oauth link quoted in chat is not one", () => {
  const chatWithLink = ["● Sign in at https://claude.ai/oauth/authorize?code=true&state=abc if prompted", RULE, "❯ ", RULE, FOOTER_IDLE].join("\n");
  expect(paneShowsLoginForm(chatWithLink)).toBe(false);
  const form = ["   Login", "", "https://claude.com/cai/oauth/authorize?code=true&client_id=abc", "", "   Paste code here if prompted >", "", "   Esc to cancel"].join("\n");
  expect(paneShowsLoginForm(form)).toBe(true);
});

test("#482 the code is typed only into the live login form (a chat pane with the link gets nothing)", async () => {
  const chatWithLink = ["● Open https://claude.ai/oauth/authorize?code=true&state=abc to log in", RULE, "❯ ", RULE, FOOTER_IDLE].join("\n");
  const { st, driver } = fakeTmux({ pane: chatWithLink });
  const s = mkSession(uid("login-code"), driver);
  s.enqueue("/login-code secret-code-123");
  await settle(500);
  expect(st.typed.join("")).not.toContain("secret-code-123");
  expect(st.keys).not.toContain("Enter");
  s.end("killed");
});

// ── ledger (C1): persisted attempts replace the in-memory pending queue ──────

test("C1 a restart between the type and the echo: the echo pairs with the persisted attempt — no duplicate bubble, no re-run", async () => {
  vi.useFakeTimers();
  const id = uid("crash-echo");
  const a = mkSession(id, fakeTmux({ pane: READY }).driver, { claudeSessionId: "sid" });
  const ra = relayStub("rs-" + id);
  a.attachRelay(ra.rs, true);
  const item = a.enqueue("survive the crash", { mirrorToRelay: false, visible: false, source: "rpc" });
  await vi.advanceTimersByTimeAsync(400);        // typed + Enter; attempt committed
  const ledger = ledgerFor();
  expect(ledger.getCommand(item.id)?.state).toBe("submitting");
  // "crash": the object is dropped without end(); the next daemon opens its generation.
  const b = mkSession(id, fakeTmux({ pane: READY }).driver, { claudeSessionId: "sid" });
  const rb = relayStub("rs-" + id);
  b.attachRelay(rb.rs, true);
  // The old attempt is an explicit unknown; the command is queued again (a
  // typed-but-unconfirmed prompt is retyped, as it always has been)…
  expect(ledger.attemptsForCommand(item.id).map((x) => x.state)).toEqual(["unknown"]);
  expect(b.queueState().pendingCount).toBe(1);
  // …but the FIRST typing's echo arrives: it matches the persisted attempt,
  // is not mirrored as a user bubble, and the re-dispatch of the same text is
  // dropped instead of running the prompt twice.
  b.onTranscriptEntry({ type: "user", uuid: "u-crash-echo", message: { role: "user", content: "survive the crash" } } as any);
  expect(rb.userRows()).toHaveLength(0);
  expect(ledger.getCommand(item.id)).toMatchObject({ state: "completed", terminalReason: "delivered" });
  expect(ledger.hasReceipt(id, "transcript_uuid", "u-crash-echo")).toBe(true);
  await vi.advanceTimersByTimeAsync(1500);
  expect(b.queueItemState(item.id)).toBe("delivered");
  expect(b.queueState().pendingCount).toBe(0);
  a.end("killed"); b.end("killed");
});

test("C1 a cancel that lands before the dispatch is honoured by the ledger: the row is cancelled, never typed (#77/#35)", async () => {
  vi.useFakeTimers();
  const { st, driver } = fakeTmux({ pane: GENERATING });   // busy: nothing drains yet
  const s = mkSession(uid("cancel-first"), driver, { claudeSessionId: "sid" });
  const item = s.enqueue("do not run", { mirrorToRelay: false, visible: false, source: "rpc" });
  const ledger = ledgerFor();
  // The cancel reaches the ledger by another path (a control-lane cancel on a
  // replacement, a late callback) — the in-memory copy is still queued.
  ledger.requestCancel(item.id);
  st.pane = READY;
  s.resumeQueue();
  await vi.advanceTimersByTimeAsync(2000);
  expect(st.typed.join("")).not.toContain("do not run");
  expect(s.queueItemState(item.id)).toBe("cancelled");
  expect(ledger.getCommand(item.id)?.state).toBe("cancelled");
  s.end("killed");
});

// ── Review residuals on 7bfa9248 (re-verified against the C1 ledger + hook-authority main) ──

test("#32 residual: an UNKNOWN cached box (capture failed / no live box) never lets a foreign turn start confirm a plain prompt — the echo does", async () => {
  vi.useFakeTimers();
  const { st, driver } = fakeTmux({ pane: READY });
  const s = mkSession(uid("foreign-unknown"), driver, { claudeSessionId: "sid" });
  const { rs } = relayStub("rs-foreign-unknown");
  s.attachRelay(rs, true);
  const item = s.enqueue("P not actually submitted", { mirrorToRelay: false, source: "rpc" });
  await vi.advanceTimersByTimeAsync(400);
  expect(st.keys).toContain("Enter");
  (driver as any).captureCached = () => ({ ok: false, out: "" });      // no evidence either way
  s.onTranscriptEntry({ type: "assistant", uuid: "foreign", message: { role: "assistant", model: "claude-x", content: [{ type: "text", text: "background output" }] } } as any);
  expect(s.queueItemState(item.id)).toBe("pending");                    // old code: delivered — the unsent prompt vanished
  expect(s.queueState().inFlight).toBe("P not actually submitted");
  // No live box on screen (a dialog is up) is equally not evidence.
  s.onTranscriptEntry({ type: "system", subtype: "turn_duration", durationMs: 1 } as any);
  (driver as any).captureCached = () => ({ ok: true, out: PERMISSION_DIALOG });
  s.onTranscriptEntry({ type: "assistant", uuid: "foreign-2", message: { role: "assistant", model: "claude-x", content: [{ type: "text", text: "more" }] } } as any);
  expect(s.queueItemState(item.id)).toBe("pending");
  // The text-matched transcript echo is the evidence that confirms it.
  s.onTranscriptEntry({ type: "user", uuid: "u-echo", message: { role: "user", content: "P not actually submitted" } } as any);
  expect(s.queueItemState(item.id)).toBe("delivered");
  s.end("killed");
});

test("#35 residual: a cancel during the SECOND dispatch's typing window is honoured — the previous item's submit mark no longer leaks into it", async () => {
  vi.useFakeTimers();
  const { st, driver } = fakeTmux({ pane: READY });
  const s = mkSession(uid("second-cancel"), driver, { claudeSessionId: "sid" });
  const { rs } = relayStub("rs-second-cancel");
  s.attachRelay(rs, true);
  s.enqueue("first", { mirrorToRelay: false, source: "rpc" });
  await vi.advanceTimersByTimeAsync(400);                                // A typed + Enter → its submit mark is set
  s.onTranscriptEntry({ type: "user", uuid: "first", message: { role: "user", content: "first" } } as any); // A delivered
  let release!: () => void;
  const hold = new Promise<void>((r) => { release = r; });
  st.onLiteral = () => hold;                                             // B's type hangs in the FIFO
  const item = s.enqueue("second", { mirrorToRelay: false, source: "rpc" });
  await vi.advanceTimersByTimeAsync(1);
  expect(s.queueState().inFlight).toBe("second");
  expect(s.cancelQueued(item.id)).toBe(true);                            // old code: false — A's timestamp was still there
  const r = await s.abort();
  expect(r.ok).toBe(true);
  release();
  await vi.advanceTimersByTimeAsync(500);
  expect(st.keys.filter((k) => k === "Enter")).toHaveLength(1);         // only A's Enter — B never submits
  expect(s.queueItemState(item.id)).toBe("cancelled");
  expect(s.queueState().inFlight).toBeNull();
  s.end("killed");
});

test("#40 residual: the system/local_command <bash-input> shape confirms a `!cmd` dispatch too", async () => {
  vi.useFakeTimers();
  const { st, driver } = fakeTmux({ pane: READY });
  const s = mkSession(uid("bash-system"), driver, { claudeSessionId: "sid" });
  const item = s.enqueue("!make deploy", { source: "rpc" });
  await vi.advanceTimersByTimeAsync(400);
  expect(st.keys).toContain("Enter");
  s.onTranscriptEntry({ type: "system", subtype: "local_command", content: "<bash-input>make deploy</bash-input>" } as any);
  expect(s.queueItemState(item.id)).toBe("delivered");                   // old code: pending → dispatch_timeout at 30s
  expect(s.queueState().inFlight).toBeNull();
  await vi.advanceTimersByTimeAsync(31_000);
  expect(s.queueState().paused).toBe(false);
  s.end("killed");
});

test("#34 residual: a steer superseded mid-settle does not release the NEWER steer's pane lease — a queued prompt waits for that steer to land", async () => {
  const { st, driver } = fakeTmux({ pane: READY });
  const s = mkSession(uid("steer-lease"), driver);
  s.enqueue("/steer first steer");
  await vi.waitFor(() => expect(st.typed).toContain("first steer"));    // A typed, its Enter pending
  let release!: () => void;
  const hold = new Promise<void>((r) => { release = r; });
  let held = false;
  st.onCapture = () => { if (!held) { held = true; return hold; } };    // B's capture hangs
  s.enqueue("/steer next steer");                                        // supersedes A (A's promise settles now)
  s.enqueue("queued prompt");                                            // a drain trigger landing mid-steer
  await settle(500);
  expect(st.typed).not.toContain("queued prompt");                       // old code: A's finally released B's flag → the drain typed it
  expect(st.typed).not.toContain("next steer");
  release();
  await vi.waitFor(() => expect(st.typed).toContain("queued prompt"), { timeout: 3000 });
  expect(st.typed.indexOf("next steer")).toBeLessThan(st.typed.indexOf("queued prompt"));
  s.end("killed");
});

test("#476 residual: a draft restore whose capture outlives the session (restart) never types into the replacement's window", async () => {
  const { st, driver } = fakeTmux({ pane: boxWith("human draft") });
  st.onKey = (k) => { if (k === "C-u" || k === "Enter") st.pane = READY; };
  const s = mkSession(uid("late-draft"), driver);
  s.enqueue("/status");
  await vi.waitFor(() => expect(st.keys).toContain("Enter"), { timeout: 5000 });
  let release!: () => void;
  const hold = new Promise<void>((r) => { release = r; });
  st.onCapture = () => hold;                                             // the restore's capture hangs
  s.onTranscriptEntry({ type: "system", subtype: "local_command", content: "<command-name>/status</command-name>" } as any);
  await settle(20);
  s.end("restart");                                                      // retired while the capture is in flight
  release();
  await settle(50);
  expect(st.typed.filter((t) => t === "human draft")).toHaveLength(0);  // old code: 1 — typed after teardown
});

test("#476 residual: a message queued while the draft restore holds the pane is typed AFTER the restore stands down — never merged with the draft", async () => {
  const { st, driver } = fakeTmux({ pane: boxWith("human draft") });
  st.onKey = (k) => { if (k === "C-u" || k === "Enter") st.pane = READY; };
  const s = mkSession(uid("draft-vs-queue"), driver);
  s.enqueue("/status");
  await vi.waitFor(() => expect(st.keys).toContain("Enter"), { timeout: 5000 });
  let release!: () => void;
  const hold = new Promise<void>((r) => { release = r; });
  let held = false;
  st.onCapture = () => { if (!held) { held = true; return hold; } };
  s.onTranscriptEntry({ type: "system", subtype: "local_command", content: "<command-name>/status</command-name>" } as any);
  await settle(20);
  s.enqueue("go");                                                       // lands while the restore owns the pane
  await settle(50);
  expect(st.typed).not.toContain("go");                                  // the drain stood down (lease held)
  release();
  await vi.waitFor(() => expect(st.typed).toContain("go"), { timeout: 3000 });
  expect(st.typed).not.toContain("human draft");                         // handed back, not typed under the prompt
  s.end("killed");
});

const PLAN_PANE = [RULE, "❯ ", RULE, "  ⏸ plan mode on (shift+tab to cycle)"].join("\n");
const BYPASS_PANE = [RULE, "❯ ", RULE, "  ⏵⏵ bypass permissions on (shift+tab to cycle)"].join("\n");

test("#480 residual: setPermissionMode reads FRESH captures on both sides of the cycle — a stale cached footer naming the target neither short-circuits nor persists", async () => {
  const { st, driver } = fakeTmux({ pane: PLAN_PANE });
  let fresh = 0;
  st.onCapture = () => { fresh++; };
  st.onKey = (k) => { if (k === "BTab") st.pane = BYPASS_PANE; };        // plan → bypass is one Shift+Tab
  (driver as any).captureCached = () => ({ ok: true, out: BYPASS_PANE }); // the sweep's stale frame already says bypass
  const id = uid("mode-fresh");
  saveWindowRecord(id, { launchCwd: join(home, "cwd") });               // a launch writes the record the mode persists into
  const s = mkSession(id, driver);
  const r = await s.setPermissionMode("bypassPermissions");
  expect(r).toMatchObject({ ok: true, mode: "bypassPermissions" });
  expect(st.keys).toEqual(["BTab"]);                                     // old code: no keys, no fresh read, "success"
  expect(fresh).toBeGreaterThanOrEqual(2);                               // read before AND after the cycle
  expect(loadWindowRecord(id)?.claudePermissionMode).toBe("bypassPermissions");
  s.end("killed");
});

test("#480 residual: a failed Shift+Tab is a failed setPermissionMode — nothing persisted, no stale-footer success", async () => {
  const { driver } = fakeTmux({ pane: PLAN_PANE });
  (driver as any).key = async () => ({ ok: false, out: "", error: "send-keys failed" });
  (driver as any).captureCached = () => ({ ok: true, out: BYPASS_PANE });
  const id = uid("mode-keyfail");
  const s = mkSession(id, driver);
  const r = await s.setPermissionMode("bypassPermissions");
  expect(r.ok).toBe(false);
  expect(r.error).toMatch(/Shift\+Tab/);
  expect(loadWindowRecord(id)?.claudePermissionMode).toBeUndefined();
  // No live footer (a dialog is up) → the mode cannot be verified fresh: an error, not the hook's stale value.
  const { driver: d2 } = fakeTmux({ pane: PERMISSION_DIALOG });
  const t = mkSession(uid("mode-dialog"), d2);
  t.onHookEvent({ event: "PostToolUse", permission_mode: "plan" });
  expect((await t.setPermissionMode("plan")).ok).toBe(false);
  s.end("killed"); t.end("killed");
});

test("#485 residual: a multi-line numbered draft in the bordered box is a draft — the gate clears it and dispatches instead of waiting forever", async () => {
  const { st, driver } = fakeTmux({ pane: [RULE, "❯ 1. first", "  2. second", RULE, FOOTER_IDLE].join("\n") });
  st.onKey = (k) => { if (k === "C-u") st.pane = READY; };
  const s = mkSession(uid("numbered-draft"), driver);
  s.enqueue("go");
  await vi.waitFor(() => expect(st.typed).toContain("go"), { timeout: 3000 }); // old code: null box → "not ready" retries forever
  expect(st.keys).toContain("C-u");
  expect(s.queueState().paused).toBe(false);
  s.end("killed");
});
