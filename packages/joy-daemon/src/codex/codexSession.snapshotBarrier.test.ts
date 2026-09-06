// #519, the snapshot boundary against a REAL socket. The app-server's
// thread/read response and a NEW identical answer can land in ONE socket
// write; `ws` then dispatches both frames before the `await threadRead`
// continuation runs. A boundary sampled in that continuation (the buffer
// length) counted the new answer as inside the snapshot, bound it to the
// replayed item, and the relay deduped the real occurrence away. The client
// now tags each response with the notification barrier captured IN the frame
// handler, and the session uses that as the boundary. Both layers are
// exercised here over a unix socket with the response + notification
// corked into a single write (the reviewer's Wave F6 reproduction).
import { test, expect } from "vitest";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { CodexAppServerClient } from "./appServerClient";
import { CodexSession } from "./codexSession";
import { joyStateDir } from "../paths";
import type { SessionDeps } from "../claude/session";
import type { TmuxDriver } from "../tmux/driver";

type Rpc = { id?: number; method?: string; params?: Record<string, unknown> };

/** A WebSocket app-server on a unix socket. `onRequest` answers each client
 *  request; `respond` and `notify` write frames; `corked(ws, fn)` batches the
 *  frames fn writes into ONE socket write. */
async function appServer(sock: string, onRequest: (ws: WebSocket, msg: Rpc, api: { respond: (r: unknown) => void; notify: (method: string, params: Record<string, unknown>) => void; corked: (fn: () => void) => void }) => void) {
  const http = createServer();
  const wss = new WebSocketServer({ server: http, perMessageDeflate: false });
  wss.on("connection", (ws) => ws.on("message", (data) => {
    const msg = JSON.parse(String(data)) as Rpc;
    onRequest(ws, msg, {
      respond: (result) => ws.send(JSON.stringify({ id: msg.id, result })),
      notify: (method, params) => ws.send(JSON.stringify({ method, params })),
      corked: (fn) => { const s = (ws as unknown as { _socket: { cork(): void; uncork(): void } })._socket; s.cork(); try { fn(); } finally { s.uncork(); } },
    });
  }));
  await new Promise<void>((r) => http.listen(sock, r));
  return {
    close: async () => {
      for (const ws of wss.clients) ws.terminate();
      await new Promise<void>((r) => wss.close(() => r()));
      await new Promise<void>((r) => http.close(() => r()));
    },
  };
}

test("#519: the client's thread/read barrier excludes a notification coalesced into the SAME socket write as the response — even though it is dispatched before the await continuation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-barrier-"));
  const sock = join(dir, "s.sock");
  const wire: string[] = [];
  const server = await appServer(sock, (_ws, msg, { respond, notify, corked }) => {
    if (msg.method === "initialize") respond({});
    if (msg.method === "thread/read") corked(() => {
      wire.push("response"); respond({ thread: { id: "TH", turns: [] } });
      wire.push("notification"); notify("item/completed", { threadId: "TH", turnId: "T-live", item: { type: "agentMessage", id: "new", text: "same" } });
    });
  });
  const client = new CodexAppServerClient();
  const seen: Array<{ method: string; seq: number }> = [];
  const order: string[] = [];
  try {
    client.onNotification((n, seq) => { seen.push({ method: n.method, seq }); order.push("notification"); });
    await client.connect(sock, 2000);
    const { thread, notifBarrier } = await client.threadRead("TH");
    order.push("continuation");
    expect(wire).toEqual(["response", "notification"]);
    // The reviewer's observation still holds at the transport: the frame
    // behind the response is dispatched BEFORE the continuation runs…
    expect(order).toEqual(["notification", "continuation"]);
    expect(thread).toEqual({ id: "TH", turns: [] });
    // …but the barrier was captured in the frame handler, so the
    // notification's seq lies PAST it.
    expect(notifBarrier).toBe(0);
    expect(seen).toEqual([{ method: "item/completed", seq: 1 }]);
    expect(client.notificationSeq).toBe(1);
  } finally {
    client.close();
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#519: rejoin over a real socket — a NEW identical answer coalesced behind the thread/read response keeps its own identity; the replayed one keeps its", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-rejoin-"));
  const prev = process.env.JOY_HOME_DIR;
  process.env.JOY_HOME_DIR = dir;
  const id = "rejoin-519-real";
  mkdirSync(joyStateDir(), { recursive: true });
  const sock = join(joyStateDir(), `codex-${id}.sock`); // the orphan's socket → the session takes the rejoin path
  const sends: Array<{ t: string; text?: string; localId?: string }> = [];
  const wire: string[] = [];
  let reads = 0;
  const server = await appServer(sock, (_ws, msg, { respond, notify, corked }) => {
    if (msg.method === "initialize") respond({});
    if (msg.method === "thread/resume") respond({ thread: { id: "TH" } });
    if (msg.method === "thread/read") {
      const snapshot = { thread: { id: "TH", turns: [{ id: "T-live", status: "inProgress", items: [{ id: "item-0", type: "agentMessage", text: "same answer" }] }] } };
      if (reads++ > 0) { respond(snapshot); return; }
      corked(() => {
        wire.push("response (old occurrence)"); respond(snapshot);
        wire.push("new occurrence"); notify("item/completed", { threadId: "TH", turnId: "T-live", item: { id: "new-occurrence", type: "agentMessage", text: "same answer" } });
      });
    }
  });
  const ok = async () => ({ ok: true, out: "" });
  const tmux = { literal: ok, key: ok, command: ok, commandOnce: ok, captureFresh: ok, captureCached: () => ({ ok: true, out: "" }), runSync: () => ({ ok: true, out: "" }), track() {}, untrack() {} } as unknown as TmuxDriver;
  const relayImpl: Record<string, unknown> = {
    relaySessionId: "relay-1", metadataSnapshot: null, outboundPersistDegraded: false,
    send: (w: any, localId?: string) => { const ev = w?.content?.data?.ev; sends.push({ t: String(ev?.t), text: ev?.text, localId }); },
  };
  const relay = new Proxy(relayImpl, { get: (t, k) => (k in t ? t[k as string] : () => Promise.resolve(true)) });
  const deps: SessionDeps = { relayClient: null, broadcast: () => {}, addChatMessage: () => {} };
  const s = new CodexSession({ id, tmuxWindow: "none", tmux, cwd: dir, status: "starting", startedAt: 0, codexThreadId: "TH", permissionMode: "bypassPermissions" }, deps);
  try {
    s.attachRelay(relay as any);
    s.beginWatching();
    for (let i = 0; i < 200 && s.status === "starting"; i++) await new Promise((r) => setTimeout(r, 20));
    expect(s.status).toBe("active");
    expect(wire).toEqual(["response (old occurrence)", "new occurrence"]);
    const texts = sends.filter((x) => x.t === "text");
    expect(texts.map((x) => x.text)).toEqual(["same answer", "same answer"]);
    // Two occurrences, two identities: the replay's ordinal 0, the new
    // answer's ordinal 1. (A boundary sampled after the await gave both :0
    // and the relay dropped the new one as a duplicate.)
    expect(texts.map((x) => x.localId)).toEqual([
      "codex:TH:turn:T-live:item:agentMessage:0:text",
      "codex:TH:turn:T-live:item:agentMessage:1:text",
    ]);
  } finally {
    s.end("killed");
    await server.close();
    if (prev === undefined) delete process.env.JOY_HOME_DIR; else process.env.JOY_HOME_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});
