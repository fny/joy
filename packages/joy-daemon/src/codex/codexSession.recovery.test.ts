// CodexSession recovery and ordering against the app-server, with the client
// and the spawn mocked so the real rejoin/spawn → resume → thread/read →
// flush → coordinator path runs in-process against an isolated JOY_HOME_DIR.
// The relay is a recorder: what the session would send, in order, with the
// localIds the real relay dedupes on.
//
//   #512  a turn that completed before its turn/start response resolved never
//         comes back as active; the next prompt runs.
//   #513  rejoining a running turn restores its active state (busy, thinking,
//         interruptible by id); a queued prompt waits for it.
//   #515  ending an active session clears busy.
//   #518  the delivered high-water never passes a turn whose history replay
//         was deferred; the next recovery replays it once it is full.
//   #519  a live answer buffered while thread/read was pending re-uses the
//         identity replay allocated; a genuinely new one keeps its own.
//   #131  a prompt typed in the attached TUI is mirrored BEFORE the turn
//         bracket; a joy-sent one's echo opens the bracket.
import { test, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const H = vi.hoisted(() => ({
  clients: [] as any[],
  turnStarts: [] as Array<{ text: string; clientId?: string }>,
  interrupts: [] as string[],
  history: { thread: { id: "TH", turns: [] as unknown[] } } as Record<string, unknown>,
  /** Runs INSIDE turn/start before it resolves — notifications that beat the response. */
  onTurnStart: null as null | ((client: any, clientId: string | undefined, turnId: string) => void),
  /** Runs INSIDE thread/read before it resolves — live traffic during the read. */
  onThreadRead: null as null | ((client: any) => void),
  /** Runs when the session persists its window record — on a rejoin that is
   *  AFTER thread/read resolved and BEFORE the buffer flush: live traffic
   *  past the snapshot boundary. */
  onWindowRecordSaved: null as null | (() => void),
  /** The app-server refuses turn/start while this turn runs (its real answer). */
  busyTurn: null as string | null,
}));

vi.mock("./appServerClient", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./appServerClient")>();
  const { EventEmitter } = await import("node:events");
  class FakeClient {
    // Mirrors the real client's contract: every notification carries its
    // dispatch seq, and a thread/read response carries the barrier — the seq
    // count at the moment the RESPONSE FRAME was handled. `onThreadRead`
    // traffic runs before that moment (inside the barrier);
    // `onWindowRecordSaved` traffic runs after it (#519).
    #seq = 0;
    #cb: (n: any, seq: number) => void = () => {};
    notify = (n: { method: string; params?: Record<string, unknown> }) => { this.#cb(n, ++this.#seq); };
    constructor() { H.clients.push(this); }
    onNotification(cb: (n: any, seq: number) => void) { this.#cb = cb; }
    onServerRequest() {}
    onClose() {}
    resolveServerRequestExternally() {}
    async connect() { return {}; }
    async threadStart() { return { threadId: "TH", rolloutPath: null, model: null }; }
    async threadResume(threadId: string) { return { threadId, model: null, reasoningEffort: null }; }
    async threadRead() {
      H.onThreadRead?.(this);
      const raw = H.history as { thread?: Record<string, unknown> };
      return { thread: (raw.thread ?? raw) as Record<string, unknown>, notifBarrier: this.#seq };
    }
    async turnStart(_t: string, text: string, opts: { clientUserMessageId?: string }) {
      H.turnStarts.push({ text, clientId: opts.clientUserMessageId });
      if (H.busyTurn) throw new orig.JsonRpcResponseError(-32600, `turn ${H.busyTurn} already active`);
      const turnId = `T${H.turnStarts.length}`;
      H.onTurnStart?.(this, opts.clientUserMessageId, turnId);
      return { turnId };
    }
    async turnInterrupt(_t: string, turnId: string) { H.interrupts.push(turnId); }
    close() {}
  }
  const fakeProc = () => Object.assign(new EventEmitter(), { pid: 4242, exitCode: null, stderr: null, kill() { return true; } });
  return { ...orig, CodexAppServerClient: FakeClient as any, spawnCodexAppServer: vi.fn(() => fakeProc()) };
});

vi.mock("../domain/windowRecord", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../domain/windowRecord")>();
  return { ...orig, saveWindowRecord: (...args: Parameters<typeof orig.saveWindowRecord>) => { const r = orig.saveWindowRecord(...args); H.onWindowRecordSaved?.(); return r; } };
});

import { CodexSession } from "./codexSession";
import { ledgerFor } from "../domain/ledger";
import { queueFor } from "../domain/queueFacade";
import { joyStateDir } from "../paths";
import type { SessionDeps } from "../claude/session";
import type { TmuxDriver } from "../tmux/driver";

let home: string;
beforeAll(() => { home = mkdtempSync(join(tmpdir(), "joy-codex-recovery-")); process.env.JOY_HOME_DIR = home; });
afterAll(() => { delete process.env.JOY_HOME_DIR; rmSync(home, { recursive: true, force: true }); });
beforeEach(() => {
  H.turnStarts.length = 0; H.interrupts.length = 0;
  H.history = { thread: { id: "TH", turns: [] } };
  H.onTurnStart = null; H.onThreadRead = null; H.onWindowRecordSaved = null; H.busyTurn = null;
});

const deps: SessionDeps = { relayClient: null, broadcast: () => {}, addChatMessage: () => {} };
const ok = async () => ({ ok: true, out: "" });
const fakeTmux = { literal: ok, key: ok, command: ok, commandOnce: ok, captureFresh: ok, captureCached: () => ({ ok: true, out: "" }), runSync: () => ({ ok: true, out: "" }), track() {}, untrack() {} } as unknown as TmuxDriver;
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ledger = () => ledgerFor();

interface Sent { localId: string | undefined; t: string; text?: string; result?: string }
/** A relay that records what is sent, in order, and lets a test ack a
 *  turn's terminal row (the receipt sink → delivered-turn checkpoint). */
function fakeRelay() {
  const sent: Sent[] = [];
  const receipts: Array<{ uuid: string; turn: string }> = [];
  const thinking: boolean[] = [];
  let sink: ((r: { uuid: string; turn: string }) => void) | null = null;
  const impl: Record<string, unknown> = {
    relaySessionId: "relay-1", metadataSnapshot: null, outboundPersistDegraded: false,
    send: (w: any, localId?: string) => {
      const ev = w?.content?.data?.ev;
      sent.push(ev ? { localId, t: String(ev.t), text: ev.text, result: ev.result } : { localId, t: w?.role === "user" || w?.content?.type === "text" ? "user" : String(w?.content?.type), text: w?.content?.text });
    },
    setReceiptSink: (s: any) => { sink = s; },
    stampReceiptOnLastQueued: (r: any) => { receipts.push(r); },
    setThinking: (v: boolean) => { thinking.push(v); },
  };
  const relay = new Proxy(impl, { get: (t, k) => (k in t ? t[k as string] : () => Promise.resolve(true)) });
  return { relay: relay as any, sent, receipts, thinking, ack: (turn: string) => sink?.({ uuid: `turn:${turn}`, turn }) };
}

/** A session resuming thread TH. `rejoin` plants the socket file so the
 *  session takes the live-orphan path (connect + resume + read) instead of a
 *  fresh spawn. */
async function started(id: string, opts: { relay?: any; rejoin?: boolean; freshCard?: boolean } = {}): Promise<{ s: CodexSession; client: any }> {
  const before = H.clients.length;
  if (opts.rejoin) { mkdirSync(joyStateDir(), { recursive: true }); writeFileSync(join(joyStateDir(), `codex-${id}.sock`), ""); }
  const s = new CodexSession({ id, tmuxWindow: "none", tmux: fakeTmux, cwd: home, status: "starting", startedAt: 0, codexThreadId: "TH", permissionMode: "bypassPermissions", freshCard: opts.freshCard }, deps);
  if (opts.relay) s.attachRelay(opts.relay);
  s.beginWatching();
  await vi.waitFor(() => expect(s.status).toBe("active"));
  return { s, client: H.clients[before] };
}

function echo(client: any, clientId: string, turn: string, answer?: string) {
  client.notify({ method: "turn/started", params: { threadId: "TH", turn: { id: turn } } });
  client.notify({ method: "item/started", params: { threadId: "TH", turnId: turn, item: { type: "userMessage", id: `msg_${turn}`, clientId } } });
  client.notify({ method: "item/completed", params: { threadId: "TH", turnId: turn, item: { type: "userMessage", id: `msg_${turn}`, clientId, text: "x" } } });
  if (answer) client.notify({ method: "item/completed", params: { threadId: "TH", turnId: turn, item: { type: "agentMessage", id: `ans_${turn}`, text: answer } } });
  client.notify({ method: "turn/completed", params: { threadId: "TH", turn: { id: turn, status: "completed" } } });
}

test("#512: a turn that started AND completed before the turn/start response resolved is settled by it, never restored as active; the next prompt runs", async () => {
  const { relay } = fakeRelay();
  const { s } = await started("rec-512", { relay });
  // The app-server's frames arrive together: the whole turn is observed
  // while the submit is still awaiting its response.
  H.onTurnStart = (client, clientId, turnId) => echo(client, clientId!, turnId);
  const a = queueFor(s).accept("one", { mirrorToRelay: false });
  const b = queueFor(s).accept("two", { mirrorToRelay: false });
  await vi.waitFor(() => expect(H.turnStarts).toHaveLength(2));
  await settle(20);
  expect(H.turnStarts.map((t) => t.text)).toEqual(["one", "two"]);
  expect(ledger().getCommand(a.id)).toMatchObject({ state: "completed", terminalReason: "completed" });
  expect(ledger().getCommand(b.id)).toMatchObject({ state: "completed", terminalReason: "completed" });
  expect(s.busy()).toBe(false);
  expect(queueFor(s).state()).toMatchObject({ busy: false, pendingCount: 0, inFlight: null, running: null });
  s.end("killed");
});

test("#513: rejoining a live orphan mid-turn restores the active turn — busy, thinking, interruptible by id — and a queued prompt waits for it", async () => {
  H.history = { thread: { id: "TH", turns: [
    { id: "T-live", status: "inProgress", items: [{ type: "userMessage", id: "item-0", content: [{ type: "text", text: "typed in the TUI" }] }] },
  ] } };
  H.busyTurn = "T-live";
  const { relay, thinking } = fakeRelay();
  const { s, client } = await started("rec-513", { relay, rejoin: true });
  expect(s.busy()).toBe(true);
  expect(s.toJSON().busy).toBe(true);
  expect(thinking.at(-1)).toBe(true);
  expect(queueFor(s).state()).toMatchObject({ busy: true, provenance: "terminal" });
  // A prompt queued behind it is probed once and refused busy by the server
  // (the coordinator's R8 rule: a foreign turn is never held for, a busy
  // refusal costs no budget) — it stays queued, nothing is interrupted.
  const q = queueFor(s).accept("next", { mirrorToRelay: false });
  await settle(50);
  expect(H.turnStarts).toHaveLength(1);
  expect(ledger().getCommand(q.id)?.state).toBe("queued");
  expect(H.interrupts).toEqual([]);
  // Stop names the live turn.
  expect(await s.abort()).toEqual({ ok: true });
  expect(H.interrupts).toEqual(["T-live"]);
  // Its real completion (the orphan's own notification) frees the session;
  // the queued prompt runs then.
  H.busyTurn = null;
  client.notify({ method: "turn/completed", params: { threadId: "TH", turn: { id: "T-live", status: "interrupted" } } });
  await vi.waitFor(() => expect(ledger().getCommand(q.id)?.state).toBe("accepted"));
  expect(H.turnStarts.at(-1)).toEqual({ text: "next", clientId: `${q.id}#a2` }); // a fresh client id per attempt
  expect(thinking.at(-1)).toBe(false);
  expect(queueFor(s).state()).toMatchObject({ provenance: null });
  s.end("killed");
});

test("#513: a rejoined in-progress turn whose items came back partial is STILL the active one — busy, thinking, Stop interrupts it by id; its buffered completion frees the session", async () => {
  H.history = { thread: { id: "TH", turns: [
    { id: "T-live", status: "inProgress", itemsView: "partial", items: [] },
  ] } };
  H.busyTurn = "T-live";
  // The orphan's own tail lands while the read is pending: it is buffered,
  // flushed after reconcile, and completes the restored turn.
  H.onThreadRead = (client) => {
    client.notify({ method: "item/completed", params: { threadId: "TH", turnId: "T-live", item: { type: "agentMessage", id: "msg-tail", text: "the tail" } } });
  };
  const { relay, thinking, sent } = fakeRelay();
  const { s, client } = await started("rec-513-partial", { relay, rejoin: true });
  expect(s.busy()).toBe(true);
  expect(s.toJSON().busy).toBe(true);
  expect(thinking.at(-1)).toBe(true);
  expect(queueFor(s).state()).toMatchObject({ busy: true, provenance: "terminal" });
  // Content availability does not decide activity: Stop names the live turn.
  expect(await s.abort()).toEqual({ ok: true });
  expect(H.interrupts).toEqual(["T-live"]);
  // The buffered live text went out under the turn's bracket, not as a stray row.
  expect(sent.map((x) => x.t)).toEqual(["turn-start", "text"]);
  expect(sent[1]).toMatchObject({ text: "the tail", localId: "codex:TH:turn:T-live:item:agentMessage:0:text" });
  // The orphan's real completion frees the session.
  H.busyTurn = null;
  client.notify({ method: "turn/completed", params: { threadId: "TH", turn: { id: "T-live", status: "interrupted" } } });
  expect(s.busy()).toBe(false);
  expect(thinking.at(-1)).toBe(false);
  expect(sent.at(-1)?.t).toBe("turn-end");
  // The deferred turn is never checkpointed as delivered (#518 still holds).
  expect(ledger().getCheckpoint("rec-513-partial", "codex_turn")?.ref ?? null).toBeNull();
  s.end("killed");
});

test("#515: ending a session whose thread is active clears busy for busy() and toJSON()", async () => {
  const { relay } = fakeRelay();
  const { s, client } = await started("rec-515", { relay });
  client.notify({ method: "thread/status/changed", params: { threadId: "TH", status: { type: "active" } } });
  expect(s.busy()).toBe(true);
  expect(s.toJSON().busy).toBe(true);
  s.end("process_exited");
  expect(s.status).toBe("ended");
  expect(s.busy()).toBe(false);
  expect(s.toJSON().busy).toBe(false);
});

test("#518: a later turn's ack never checkpoints past a deferred (non-full) earlier turn; the next recovery replays it once full", async () => {
  const id = "rec-518";
  H.history = { thread: { id: "TH", turns: [
    { id: "T1", status: "completed", itemsView: "partial", items: [] },
    { id: "T2", status: "completed", itemsView: "full", items: [{ type: "agentMessage", id: "item-0", text: "second answer" }] },
  ] } };
  const r1 = fakeRelay();
  const { s } = await started(id, { relay: r1.relay });
  expect(r1.sent.filter((x) => x.t === "text").map((x) => x.text)).toEqual(["second answer"]);
  expect(r1.receipts).toContainEqual({ uuid: "turn:T2", turn: "T2" });
  r1.ack("T2"); // the relay acks T2's terminal row
  expect(ledger().getCheckpoint(id, "codex_turn")?.ref ?? null).toBeNull(); // NOT "T2": T1 is a hole before it
  s.end("process_exited");

  // Second recovery: T1's items are available now — its answer lands, once.
  H.history = { thread: { id: "TH", turns: [
    { id: "T1", status: "completed", itemsView: "full", items: [{ type: "agentMessage", id: "item-0", text: "first answer" }] },
    { id: "T2", status: "completed", itemsView: "full", items: [{ type: "agentMessage", id: "item-0", text: "second answer" }] },
  ] } };
  const r2 = fakeRelay();
  const { s: s2 } = await started(id, { relay: r2.relay });
  expect(r2.sent.filter((x) => x.t === "text").map((x) => x.text)).toEqual(["first answer", "second answer"]);
  r2.ack("T1"); r2.ack("T2");
  expect(ledger().getCheckpoint(id, "codex_turn")?.ref).toBe("T2");
  s2.end("killed");
});

test("#519: a live answer buffered while thread/read was pending re-uses the identity history replay allocated; a new one after the snapshot keeps its own", async () => {
  H.history = { thread: { id: "TH", turns: [
    { id: "T-live", status: "inProgress", items: [
      { type: "userMessage", id: "item-0", content: [{ type: "text", text: "go" }] },
      { type: "agentMessage", id: "item-1", text: "the answer" },
    ] },
  ] } };
  // The same answer arrives live (under its live id) while the read is pending.
  H.onThreadRead = (client) => {
    client.notify({ method: "item/started", params: { threadId: "TH", turnId: "T-live", item: { type: "agentMessage", id: "msg-live", text: "" } } });
    client.notify({ method: "item/completed", params: { threadId: "TH", turnId: "T-live", item: { type: "agentMessage", id: "msg-live", text: "the answer" } } });
  };
  const { relay, sent } = fakeRelay();
  const { s, client } = await started("rec-519", { relay, rejoin: true });
  const texts = () => sent.filter((x) => x.t === "text").map((x) => x.localId);
  // Replay, then the flushed live copy: the SAME localId (the relay dedupes it) — never agentMessage:1.
  expect(texts()).toEqual(["codex:TH:turn:T-live:item:agentMessage:0:text", "codex:TH:turn:T-live:item:agentMessage:0:text"]);
  // A genuinely new answer after the snapshot is the next ordinal.
  client.notify({ method: "item/completed", params: { threadId: "TH", turnId: "T-live", item: { type: "agentMessage", id: "msg-next", text: "more" } } });
  expect(texts().at(-1)).toBe("codex:TH:turn:T-live:item:agentMessage:1:text");
  s.end("killed");
});

test("#519: a NEW execution of the same command buffered during the read is not the old one — both results reach the relay under distinct ids", async () => {
  H.history = { thread: { id: "TH", turns: [
    { id: "T-live", status: "inProgress", items: [{ type: "commandExecution", id: "item-0", command: "date", aggregatedOutput: "old timestamp", exitCode: 0 }] },
  ] } };
  // The same command runs AGAIN while the read is pending: equal input, a different output.
  H.onThreadRead = (client) => {
    client.notify({ method: "item/started", params: { threadId: "TH", turnId: "T-live", item: { type: "commandExecution", id: "new-command", command: "date" } } });
    client.notify({ method: "item/completed", params: { threadId: "TH", turnId: "T-live", item: { type: "commandExecution", id: "new-command", command: "date", aggregatedOutput: "new timestamp", exitCode: 0 } } });
  };
  const { relay, sent } = fakeRelay();
  const { s } = await started("rec-519-repeat", { relay, rejoin: true });
  const ends = sent.filter((x) => x.t === "tool-call-end");
  expect(ends.map((x) => [x.localId, x.result])).toEqual([
    ["codex:TH:turn:T-live:item:commandExecution:0:tool-end", "old timestamp"],
    ["codex:TH:turn:T-live:item:commandExecution:1:tool-end", "new timestamp"],
  ]);
  expect(sent.filter((x) => x.t === "tool-call-start").map((x) => x.localId)).toEqual([
    "codex:TH:turn:T-live:item:commandExecution:0:tool-start",
    "codex:TH:turn:T-live:item:commandExecution:1:tool-start",
  ]);
  s.end("killed");
});

test("#519: the snapshot boundary — an occurrence that arrives AFTER thread/read resolved is new even when its whole content equals a replayed item; the same runtime id binds", async () => {
  H.history = { thread: { id: "TH", turns: [
    { id: "T-live", status: "inProgress", items: [
      { type: "commandExecution", id: "call_same", command: "echo hi", aggregatedOutput: "hi", exitCode: 0 },
      { type: "commandExecution", id: "item-1", command: "echo hi", aggregatedOutput: "hi", exitCode: 0 },
    ] },
  ] } };
  // Inside the boundary: the runtime's own id names the first item (its
  // content differs — the snapshot had it before the output settled).
  H.onThreadRead = (client) => {
    client.notify({ method: "item/completed", params: { threadId: "TH", turnId: "T-live", item: { type: "commandExecution", id: "call_same", command: "echo hi", aggregatedOutput: "hi\n", exitCode: 0 } } });
  };
  // Past the boundary (read resolved, flush pending): identical content, but
  // the snapshot cannot contain it — a third `echo hi`.
  H.onWindowRecordSaved = () => {
    H.onWindowRecordSaved = null; // the first save on a rejoin is the post-read one
    const client = H.clients.at(-1);
    client.notify({ method: "item/started", params: { threadId: "TH", turnId: "T-live", item: { type: "commandExecution", id: "call_third", command: "echo hi" } } });
    client.notify({ method: "item/completed", params: { threadId: "TH", turnId: "T-live", item: { type: "commandExecution", id: "call_third", command: "echo hi", aggregatedOutput: "hi", exitCode: 0 } } });
  };
  const { relay, sent } = fakeRelay();
  const { s } = await started("rec-519-boundary", { relay, rejoin: true });
  expect(sent.filter((x) => x.t === "tool-call-end").map((x) => [x.localId, x.result])).toEqual([
    ["codex:TH:turn:T-live:item:commandExecution:0:tool-end", "hi"],
    ["codex:TH:turn:T-live:item:commandExecution:1:tool-end", "hi"],
    ["codex:TH:turn:T-live:item:commandExecution:0:tool-end", "hi\n"], // bound by id: the replayed identity, re-sent
    ["codex:TH:turn:T-live:item:commandExecution:2:tool-end", "hi"],   // past the boundary: its own
  ]);
  s.end("killed");
});

test("#519: an equal-text NEW prompt during the read is its own user row, not the replayed one", async () => {
  H.history = { thread: { id: "TH", turns: [
    { id: "T1", status: "completed", items: [
      { type: "userMessage", id: "item-0", content: [{ type: "text", text: "hi" }] },
      { type: "agentMessage", id: "item-1", text: "hello" },
    ] },
  ] } };
  // The user types the same prompt again in the TUI while the read is pending: a new turn.
  H.onThreadRead = (client) => {
    client.notify({ method: "turn/started", params: { threadId: "TH", turn: { id: "T2" } } });
    client.notify({ method: "item/started", params: { threadId: "TH", turnId: "T2", item: { type: "userMessage", id: "msg_2" } } });
    client.notify({ method: "item/completed", params: { threadId: "TH", turnId: "T2", item: { type: "userMessage", id: "msg_2", text: "hi" } } });
  };
  const { relay, sent } = fakeRelay();
  const { s } = await started("rec-519-user", { relay, rejoin: true });
  expect(sent.filter((x) => x.t === "user").map((x) => [x.localId, x.text])).toEqual([
    ["turn:T1:item:userMessage:0:user", "hi"],
    ["turn:T2:item:userMessage:0:user", "hi"],
  ]);
  // …and the new prompt lands BEFORE its turn bracket (#131).
  expect(sent.map((x) => x.t)).toEqual(["user", "turn-start", "text", "turn-end", "user", "turn-start"]);
  s.end("killed");
});

test("#131: a prompt typed in the attached TUI is mirrored BEFORE the turn bracket; a joy-sent prompt's echo opens the bracket", async () => {
  const { relay, sent } = fakeRelay();
  const { s, client } = await started("rec-131", { relay });
  // Codex's order for a TUI prompt: turn/started, THEN the userMessage item.
  client.notify({ method: "turn/started", params: { threadId: "TH", turn: { id: "T-tui" } } });
  client.notify({ method: "thread/status/changed", params: { threadId: "TH", status: { type: "active" } } });
  client.notify({ method: "item/started", params: { threadId: "TH", turnId: "T-tui", item: { type: "userMessage", id: "msg_1" } } });
  client.notify({ method: "item/completed", params: { threadId: "TH", turnId: "T-tui", item: { type: "userMessage", id: "msg_1", text: "typed here" } } });
  client.notify({ method: "item/completed", params: { threadId: "TH", turnId: "T-tui", item: { type: "agentMessage", id: "msg_2", text: "reply" } } });
  client.notify({ method: "turn/completed", params: { threadId: "TH", turn: { id: "T-tui", status: "completed" } } });
  expect(sent.map((x) => x.t)).toEqual(["user", "turn-start", "text", "turn-end"]);
  expect(sent[0]).toMatchObject({ text: "typed here", localId: "turn:T-tui:item:userMessage:0:user" });
  expect(sent[1].localId).toBe("codex:TH:turn:T-tui:start");
  sent.length = 0;

  // A joy-sent prompt: the mirror row is already in the card; its echo opens the bracket.
  const c = queueFor(s).accept("from joy");
  await vi.waitFor(() => expect(H.turnStarts).toHaveLength(1));
  echo(client, c.id, "T1", "answer");
  expect(sent.map((x) => x.t)).toEqual(["user", "turn-start", "text", "turn-end"]);
  expect(sent[0]).toMatchObject({ text: "from joy", localId: `codex:in:rec-131:${c.id}` });
  await settle(10);
  expect(ledger().getCommand(c.id)?.state).toBe("completed");
  s.end("killed");
});

test.each([
  ["clientId", (id: string) => ({ clientId: id })],
  ["clientUserMessageId", (id: string) => ({ clientUserMessageId: id })],
])("#131: a TUI prompt stamped with a FOREIGN %s is still mirrored BEFORE the turn bracket — a client id this session never submitted opens nothing", async (_form, stamp) => {
  const { relay, sent } = fakeRelay();
  const { s, client } = await started(`rec-131-foreign-${_form}`, { relay });
  // The TUI (or another app-server client) stamps its own id on the prompt.
  client.notify({ method: "turn/started", params: { threadId: "TH", turn: { id: "T-tui" } } });
  client.notify({ method: "item/started", params: { threadId: "TH", turnId: "T-tui", item: { type: "userMessage", id: "m", ...stamp("external-tui-id") } } });
  client.notify({ method: "item/completed", params: { threadId: "TH", turnId: "T-tui", item: { type: "userMessage", id: "m", ...stamp("external-tui-id"), text: "typed in TUI" } } });
  client.notify({ method: "item/completed", params: { threadId: "TH", turnId: "T-tui", item: { type: "agentMessage", id: "msg_2", text: "reply" } } });
  client.notify({ method: "turn/completed", params: { threadId: "TH", turn: { id: "T-tui", status: "completed" } } });
  expect(sent.map((x) => x.t)).toEqual(["user", "turn-start", "text", "turn-end"]);
  expect(sent[0]).toMatchObject({ text: "typed in TUI", localId: "turn:T-tui:item:userMessage:0:user" });
  expect(sent[1].localId).toBe("codex:TH:turn:T-tui:start");
  // Nothing of ours was confirmed by it.
  expect(queueFor(s).state()).toMatchObject({ inFlight: null, running: null });
  s.end("killed");
});

test("#519: two executions under DISTINCT runtime ids never alias, however equal their whole content — call_old is the history's, call_new is its own", async () => {
  const exec = { type: "commandExecution", command: "echo hi", cwd: "/same", aggregatedOutput: "hi", exitCode: 0, status: "completed" };
  H.history = { thread: { id: "TH", turns: [{ id: "T-live", status: "inProgress", items: [{ ...exec, id: "call_old" }] }] } };
  // Inside the boundary: the same command, same cwd, same output — a second run.
  H.onThreadRead = (client) => {
    client.notify({ method: "item/started", params: { threadId: "TH", turnId: "T-live", item: { ...exec, id: "call_new" } } });
    client.notify({ method: "item/completed", params: { threadId: "TH", turnId: "T-live", item: { ...exec, id: "call_new" } } });
  };
  const { relay, sent } = fakeRelay();
  const { s } = await started("rec-519-runtime-ids", { relay, rejoin: true });
  expect(sent.filter((x) => x.t === "tool-call-start").map((x) => x.localId)).toEqual([
    "codex:TH:turn:T-live:item:commandExecution:0:tool-start",
    "codex:TH:turn:T-live:item:commandExecution:1:tool-start",
  ]);
  expect(sent.filter((x) => x.t === "tool-call-end").map((x) => x.localId)).toEqual([
    "codex:TH:turn:T-live:item:commandExecution:0:tool-end",
    "codex:TH:turn:T-live:item:commandExecution:1:tool-end",
  ]);
  s.end("killed");
});

test("#519: exact-id binds are reserved FIRST — an earlier equal-content live item never takes the slot a later notification names by id", async () => {
  H.history = { thread: { id: "TH", turns: [{ id: "T-live", status: "inProgress", items: [
    { type: "agentMessage", id: "msg_x", text: "same answer" },  // the runtime's own id
    { type: "agentMessage", id: "item-1", text: "same answer" }, // positional
  ] }] } };
  // Buffer order: the content-only candidate BEFORE the id-named one.
  H.onThreadRead = (client) => {
    client.notify({ method: "item/completed", params: { threadId: "TH", turnId: "T-live", item: { type: "agentMessage", id: "msg_new", text: "same answer" } } });
    client.notify({ method: "item/completed", params: { threadId: "TH", turnId: "T-live", item: { type: "agentMessage", id: "msg_x", text: "same answer" } } });
  };
  const { relay, sent } = fakeRelay();
  const { s } = await started("rec-519-reserve", { relay, rejoin: true });
  expect(sent.filter((x) => x.t === "text").map((x) => x.localId)).toEqual([
    "codex:TH:turn:T-live:item:agentMessage:0:text", // replay msg_x
    "codex:TH:turn:T-live:item:agentMessage:1:text", // replay item-1
    "codex:TH:turn:T-live:item:agentMessage:1:text", // msg_new → the positional twin (a single pass gave it :0, msg_x's)
    "codex:TH:turn:T-live:item:agentMessage:0:text", // msg_x → its own, by id
  ]);
  s.end("killed");
});

test("#519: a history item under a RUNTIME id is never content-matched — an equal answer under another id is a new occurrence, and the id-named one still binds", async () => {
  H.history = { thread: { id: "TH", turns: [{ id: "T-live", status: "inProgress", items: [{ type: "agentMessage", id: "msg_original", text: "same answer" }] }] } };
  H.onThreadRead = (client) => {
    client.notify({ method: "item/completed", params: { threadId: "TH", turnId: "T-live", item: { type: "agentMessage", id: "msg_another", text: "same answer" } } });
    client.notify({ method: "item/completed", params: { threadId: "TH", turnId: "T-live", item: { type: "agentMessage", id: "msg_original", text: "same answer" } } });
  };
  const { relay, sent } = fakeRelay();
  const { s } = await started("rec-519-runtime-history", { relay, rejoin: true });
  expect(sent.filter((x) => x.t === "text").map((x) => x.localId)).toEqual([
    "codex:TH:turn:T-live:item:agentMessage:0:text", // replay
    "codex:TH:turn:T-live:item:agentMessage:1:text", // msg_another: new (a content match aliased it to :0)
    "codex:TH:turn:T-live:item:agentMessage:0:text", // msg_original: the replayed identity, re-sent
  ]);
  s.end("killed");
});

test.each([
  ["positional", "item-0"],
  ["exact runtime", "msg-a"],
])("#519: a REPEATED completion buffered during the read is the same occurrence — it never consumes a second history slot, and the next live item takes that slot (%s history id)", async (_label, firstId) => {
  // Two equal answers in history; the live buffer carries msg-a, msg-a
  // AGAIN (a re-delivered completion), then msg-b — all inside the snapshot.
  H.history = { thread: { id: "TH", turns: [{ id: "T-live", status: "inProgress", items: [
    { type: "agentMessage", id: firstId, text: "same answer" },
    { type: "agentMessage", id: "item-1", text: "same answer" },
  ] }] } };
  H.onThreadRead = (client) => {
    for (const id of ["msg-a", "msg-a", "msg-b"]) client.notify({ method: "item/completed", params: { threadId: "TH", turnId: "T-live", item: { type: "agentMessage", id, text: "same answer" } } });
  };
  const { relay, sent } = fakeRelay();
  const { s, client } = await started(`rec-519-repeat-${firstId}`, { relay, rejoin: true });
  const texts = () => sent.filter((x) => x.t === "text").map((x) => x.localId);
  expect(texts()).toEqual([
    "codex:TH:turn:T-live:item:agentMessage:0:text", // replay, first answer
    "codex:TH:turn:T-live:item:agentMessage:1:text", // replay, second answer
    "codex:TH:turn:T-live:item:agentMessage:0:text", // msg-a → the first slot
    "codex:TH:turn:T-live:item:agentMessage:0:text", // msg-a again → the SAME identity (relay-deduped); the repeat used to eat slot :1
    "codex:TH:turn:T-live:item:agentMessage:1:text", // msg-b → the second slot (it used to be pushed to a third ordinal, :2)
  ]);
  expect(new Set(texts()).size).toBe(2); // two occurrences, two identities
  // An ordinary duplicate after buffering still re-uses its identity.
  client.notify({ method: "item/completed", params: { threadId: "TH", turnId: "T-live", item: { type: "agentMessage", id: "msg-b", text: "same answer" } } });
  expect(texts().at(-1)).toBe("codex:TH:turn:T-live:item:agentMessage:1:text");
  expect(new Set(texts()).size).toBe(2);
  s.end("killed");
});
