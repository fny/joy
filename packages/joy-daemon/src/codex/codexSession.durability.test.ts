// Inbound durability of CodexSession against the app-server, with the client
// and the spawn mocked so the real start → resume → reconcile → dispatch path
// runs end to end in-process. Every test uses an isolated JOY_HOME_DIR so no
// live daemon state (~/.joy) is read or written.
//
//   #516  the seq dedupe must survive the delivery echo (live AND after a
//         restart) — a redelivered seq is never a second turn/start.
//   #514  a failed pre-send spool write HOLDS the send; persistence is retried,
//         the prompt is sent exactly once when it succeeds.
//   medium (codexSession.ts:731): two non-relay sends in one millisecond must
//         mirror under DISTINCT localIds.
import { test, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const H = vi.hoisted(() => ({
  clients: [] as any[],
  turnStarts: [] as Array<{ text: string; clientId?: string }>,
  /** When it returns true for the items being saved, the spool write "fails". */
  failSave: ((_items: unknown[]) => false) as (items: any[]) => boolean,
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
    async threadRead() { return { thread: { id: "TH", turns: [] } }; }
    async turnStart(_t: string, text: string, opts: { clientUserMessageId?: string }) {
      H.turnStarts.push({ text, clientId: opts.clientUserMessageId });
      return { turnId: `T${H.turnStarts.length}` };
    }
    async turnInterrupt() {}
    close() {}
  }
  const fakeProc = () => Object.assign(new EventEmitter(), { pid: 4242, exitCode: null, stderr: null, kill() { return true; } });
  return { ...orig, CodexAppServerClient: FakeClient as any, spawnCodexAppServer: vi.fn(() => fakeProc()) };
});

vi.mock("./codexInboundStore", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./codexInboundStore")>();
  return {
    ...orig,
    saveCodexInbound: (id: string, items: any[], base?: string) => (H.failSave(items) ? false : orig.saveCodexInbound(id, items, base)),
  };
});

import { CodexSession } from "./codexSession";
import { loadCodexInbound } from "./codexInboundStore";
import { loadCheckpoint } from "./codexCheckpointStore";
import type { SessionDeps } from "../claude/session";
import type { TmuxDriver } from "../tmux/driver";

let home: string;
beforeAll(() => { home = mkdtempSync(join(tmpdir(), "joy-codex-durability-")); process.env.JOY_HOME_DIR = home; });
afterAll(() => { delete process.env.JOY_HOME_DIR; rmSync(home, { recursive: true, force: true }); });

const deps: SessionDeps = { relayClient: null, broadcast: () => {}, addChatMessage: () => {} };
const ok = async () => ({ ok: true, out: "" });
const fakeTmux = { literal: ok, key: ok, command: ok, commandOnce: ok, captureFresh: ok, captureCached: () => ({ ok: true, out: "" }), runSync: () => ({ ok: true, out: "" }), track() {}, untrack() {} } as unknown as TmuxDriver;
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A session resuming thread TH (the recovery constructor path: it LOADS the
 *  spool + checkpoint from disk) whose app-server is the fake above. */
async function started(id: string): Promise<{ s: CodexSession; client: any }> {
  const before = H.clients.length;
  const s = new CodexSession({ id, tmuxWindow: "none", tmux: fakeTmux, cwd: home, status: "starting", startedAt: 0, codexThreadId: "TH", permissionMode: "bypassPermissions" }, deps);
  s.beginWatching();
  await vi.waitFor(() => expect(s.status).toBe("active"));
  return { s, client: H.clients[before] };
}

function echo(client: any, id: string, seq: number, turn: string) {
  const clientId = `codex-in:${id}:${seq}`;
  client.notify({ method: "turn/started", params: { threadId: "TH", turn: { id: turn } } });
  client.notify({ method: "item/started", params: { threadId: "TH", turnId: turn, item: { type: "userMessage", id: `msg_${seq}`, clientId } } });
  client.notify({ method: "item/completed", params: { threadId: "TH", turnId: turn, item: { type: "userMessage", id: `msg_${seq}`, clientId, text: "x" } } });
  client.notify({ method: "turn/completed", params: { threadId: "TH", turn: { id: turn, status: "completed" } } });
}

test("#516: a seq redelivered AFTER its echo removed it from the spool is not started again", async () => {
  const id = "dur-516";
  H.turnStarts.length = 0;
  const { s, client } = await started(id);
  s.enqueue("do the thing", { seq: 42, mirrorToRelay: false });
  await vi.waitFor(() => expect(H.turnStarts).toHaveLength(1));
  // Accepted; the userMessage echo confirms delivery and drains the spool.
  echo(client, id, 42, "T1");
  await settle(10);
  expect(loadCodexInbound(id)).toEqual([]);
  expect(s.queueState().pendingCount).toBe(0);
  // The receipt is durable, keyed by seq → the clientId it ran under.
  expect(loadCheckpoint(id).seqReceipts).toEqual([{ seq: 42, clientId: `codex-in:${id}:42` }]);

  // Crash-before-cursor-persist: the relay hands us seq 42 again after the turn
  // completed. Same logical message → no spool entry, no second turn/start.
  const again = s.enqueue("do the thing", { seq: 42, mirrorToRelay: false });
  await settle(30);
  expect(again.id).toBe(`codex-in:${id}:42`);
  expect(s.queueItemState(again.id)).toBe("delivered");
  expect(H.turnStarts).toHaveLength(1);
  expect(loadCodexInbound(id)).toEqual([]);

  // A genuinely new seq still flows.
  s.enqueue("next", { seq: 43, mirrorToRelay: false });
  await vi.waitFor(() => expect(H.turnStarts).toHaveLength(2));
  expect(H.turnStarts[1]).toEqual({ text: "next", clientId: `codex-in:${id}:43` });
  s.end("process_exited"); // a crash-shaped end: keeps the checkpoint on disk
});

test("#516: the receipt survives a daemon restart — recovery does not resend a confirmed seq", async () => {
  const id = "dur-516-recover";
  H.turnStarts.length = 0;
  const { s, client } = await started(id);
  s.enqueue("first", { seq: 7, mirrorToRelay: false });
  await vi.waitFor(() => expect(H.turnStarts).toHaveLength(1));
  echo(client, id, 7, "T1");
  await settle(10);
  s.end("process_exited"); // daemon dies; the checkpoint with the receipt is on disk

  // The replacement loads the checkpoint in its constructor (before the relay
  // can pull) and the relay redelivers seq 7 — it must be recognised, not run.
  const { s: s2 } = await started(id);
  const r = s2.enqueue("first", { seq: 7, mirrorToRelay: false });
  await settle(30);
  expect(r.id).toBe(`codex-in:${id}:7`);
  expect(H.turnStarts).toHaveLength(1);
  expect(s2.queueState().pendingCount).toBe(0);
  // ...while the next seq runs normally.
  s2.enqueue("second", { seq: 8, mirrorToRelay: false });
  await vi.waitFor(() => expect(H.turnStarts).toHaveLength(2));
  s2.end("process_exited");
});

test("#514: a failed sentUnknown write holds the send; the retry sends exactly once", async () => {
  const id = "dur-514";
  H.turnStarts.length = 0;
  const { s } = await started(id);
  // The 'queued' insert persists; the 'sentUnknown' transition does not.
  H.failSave = (items) => items.some((i) => i.state === "sentUnknown");
  try {
    s.enqueue("send me", { seq: 1, mirrorToRelay: false });
    await settle(150);
    // NOT sent: the durable spool still says queued, so a crash before the echo
    // would make recovery resend a prompt codex had already accepted.
    expect(H.turnStarts).toHaveLength(0);
    expect(loadCodexInbound(id)).toEqual([expect.objectContaining({ seq: 1, state: "queued" })]);
    expect(s.queueState().pendingCount).toBe(1); // in-memory state restored to queued
  } finally {
    H.failSave = () => false;
  }
  // Persistence recovers → the scheduled retry sends it, once, with the
  // sentUnknown state durable BEFORE the socket write.
  await vi.waitFor(() => expect(H.turnStarts).toHaveLength(1), { timeout: 6000, interval: 50 });
  expect(loadCodexInbound(id)).toEqual([expect.objectContaining({ seq: 1, state: "sentUnknown" })]);
  await settle(50);
  expect(H.turnStarts).toHaveLength(1);
  s.end("killed");
}, 10_000);

test("two non-relay sends in the same millisecond mirror under distinct localIds", async () => {
  const id = "dur-localid";
  const sent: Array<string | undefined> = [];
  // A relay that only records what is sent; every other call is a no-op.
  const relay = new Proxy({}, {
    get: (_t, k) => k === "send" ? ((_w: unknown, localId?: string) => { sent.push(localId); })
      : k === "relaySessionId" ? "relay-1"
        : k === "metadataSnapshot" ? null
          : (() => Promise.resolve(true)),
  });
  const s = new CodexSession({ id, tmuxWindow: "none", tmux: fakeTmux, cwd: home, status: "starting", startedAt: 0 }, deps);
  s.attachRelay(relay as any);
  const a = s.enqueue("one");
  const b = s.enqueue("two"); // same tick, same Date.now() in practice
  expect(a.id).not.toBe(b.id);
  expect(sent).toHaveLength(2);
  expect(new Set(sent).size).toBe(2);
  // Relay sends keep the seq-keyed localId (a redelivery SHOULD dedupe there).
  s.enqueue("three", { seq: 99 });
  expect(sent[2]).toBe(`codex:in:${id}:99`);
  s.end("killed");
});
