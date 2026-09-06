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
  /** The app-server refuses turn/start while this turn runs (its real answer). */
  busyTurn: null as string | null,
}));

vi.mock("./appServerClient", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./appServerClient")>();
  const { EventEmitter } = await import("node:events");
  class FakeClient {
    notify: (n: { method: string; params?: Record<string, unknown> }) => void = () => {};
    constructor() { H.clients.push(this); }
    onNotification(cb: (n: any) => void) { this.notify = cb; }
    onServerRequest() {}
    onClose() {}
    resolveServerRequestExternally() {}
    async connect() { return {}; }
    async threadStart() { return { threadId: "TH", rolloutPath: null, model: null }; }
    async threadResume(threadId: string) { return { threadId, model: null, reasoningEffort: null }; }
    async threadRead() { H.onThreadRead?.(this); return H.history; }
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
  H.onTurnStart = null; H.onThreadRead = null; H.busyTurn = null;
});

const deps: SessionDeps = { relayClient: null, broadcast: () => {}, addChatMessage: () => {} };
const ok = async () => ({ ok: true, out: "" });
const fakeTmux = { literal: ok, key: ok, command: ok, commandOnce: ok, captureFresh: ok, captureCached: () => ({ ok: true, out: "" }), runSync: () => ({ ok: true, out: "" }), track() {}, untrack() {} } as unknown as TmuxDriver;
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ledger = () => ledgerFor();

interface Sent { localId: string | undefined; t: string; text?: string }
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
      sent.push(ev ? { localId, t: String(ev.t), text: ev.text } : { localId, t: w?.role === "user" || w?.content?.type === "text" ? "user" : String(w?.content?.type), text: w?.content?.text });
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
