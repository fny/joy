// A stand-in daemon for the Direct-mode smoke test (direct-smoke.mjs), run
// with the daemon's tsx. The transport is the REAL one: the daemon's tunnel
// executor claims the sealed signaling request from the real relay, and its
// WebRTC transport (transports/rtc.ts, werift) answers the browser's offer and
// serves the data channel. Behind it, the few daemon routes Direct mode calls,
// with an agent the test plays through /_test/*.
//
// env: RELAY_URL TOKEN MACHINE_ID MACHINE_KEY (base64)
// stdout: "listening <port>" once up.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { acceptRtcOffer, closeAllRtcPeers } from "../../joy-daemon/src/transports/rtc";
import { startTunnelExecutor } from "../../joy-daemon/src/tunnel/executor";

const TOKEN = randomUUID();
type Rec = { seq: number; at: number; record: unknown };
const sessions = new Map<string, { spec: Record<string, unknown>; log: Rec[]; busy: boolean; followers: Set<ServerResponse> }>();
const prompts: Array<{ id: string; text: string }> = [];

const body = (req: IncomingMessage) => new Promise<any>((resolve) => { let s = ""; req.on("data", (c) => (s += c)); req.on("end", () => { try { resolve(s ? JSON.parse(s) : {}); } catch { resolve({}); } }); });
const json = (res: ServerResponse, obj: unknown, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };

function append(id: string, record: unknown) {
  const s = sessions.get(id)!;
  const r = { seq: s.log.length + 1, at: Date.now(), record };
  s.log.push(r);
  for (const f of s.followers) f.write(JSON.stringify(r) + "\n");
}
const agentEv = (ev: Record<string, unknown>) => ({ role: "session", content: { type: "session", data: { id: randomUUID(), time: Date.now(), role: "agent", ev } }, meta: { sentFrom: "joy" } });

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const p = url.pathname;
  // The test's own hand on the agent — never through the channel.
  if (p.startsWith("/_test/")) {
    if (p === "/_test/prompts") return json(res, { prompts, sessions: [...sessions.keys()], specs: [...sessions.values()].map((s) => s.spec) });
    if (p === "/_test/say") {
      const { id, text, end } = await body(req);
      append(id, agentEv({ t: "text", text }));
      if (end) { append(id, agentEv({ t: "turn-end", status: "completed" })); sessions.get(id)!.busy = false; }
      return json(res, { ok: true });
    }
    return json(res, { error: "no" }, 404);
  }
  if (req.headers["x-joy-token"] !== TOKEN) return json(res, { error: "unauthorized" }, 401);
  if (req.method === "POST" && p === "/v2/rtc/connect") {
    const { sdp } = await body(req);
    return json(res, { sdp: await acceptRtcOffer(sdp, { targetBase: `http://127.0.0.1:${(server.address() as any).port}`, targetHeaders: { "X-Joy-Token": TOKEN } }) });
  }
  if (req.method === "POST" && p === "/sessions") {
    const spec = await body(req);
    const id = randomUUID().replace(/-/g, "").slice(0, 8);
    sessions.set(id, { spec, log: [], busy: false, followers: new Set() });
    return json(res, { id, cwd: spec.cwd, agent: spec.agent }, 201);
  }
  if (req.method === "GET" && p === "/sessions") return json(res, [...sessions.keys()].map((id) => ({ id })));
  if (req.method === "POST" && p === "/send") {
    const { session_id, text } = await body(req);
    const s = sessions.get(session_id);
    if (!s) return json(res, { error: "session_not_found" }, 404);
    s.busy = true;
    append(session_id, { role: "user", content: { type: "text", text }, meta: { sentFrom: "joy" } });
    append(session_id, agentEv({ t: "turn-start" }));
    prompts.push({ id: session_id, text });
    return json(res, { ok: true });
  }
  const m = p.match(/^\/sessions\/([^/]+)\/(check|events)$/);
  const s = m ? sessions.get(m[1]) : undefined;
  if (m && !s) return json(res, { error: "session_not_found" }, 404);
  if (m?.[2] === "check") return json(res, { state: s!.busy ? "busy" : "idle" });
  if (m?.[2] === "events") {
    const head = s!.log.length;
    const after = url.searchParams.has("after") ? Number(url.searchParams.get("after")) : undefined;
    const last = url.searchParams.has("last") ? Number(url.searchParams.get("last")) : undefined;
    const hist = last !== undefined ? s!.log.slice(Math.max(0, head - last)) : s!.log.filter((r) => r.seq > (after ?? 0));
    res.writeHead(200, { "content-type": "application/x-ndjson" });
    res.write(JSON.stringify({ hello: true, seq: head }) + "\n");
    for (const r of hist) res.write(JSON.stringify(r) + "\n");
    if (url.searchParams.get("follow") !== "1") return res.end();
    s!.followers.add(res);
    req.on("close", () => s!.followers.delete(res));
    return;
  }
  json(res, { error: "not_found" }, 404);
});

server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as any).port;
  startTunnelExecutor({
    relayUrl: process.env.RELAY_URL!, accountToken: process.env.TOKEN!, machineId: process.env.MACHINE_ID!,
    machineKey: new Uint8Array(Buffer.from(process.env.MACHINE_KEY!, "base64")),
    targetBase: `http://127.0.0.1:${port}`, targetHeaders: { "X-Joy-Token": TOKEN },
    log: (l) => process.stderr.write(l + "\n"),
  });
  process.stdout.write(`listening ${port}\n`);
});
process.on("SIGTERM", async () => { await closeAllRtcPeers(); process.exit(0); });
