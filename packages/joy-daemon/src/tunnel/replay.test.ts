// Request replay to the daemon (#418 follow-up). The relay is untrusted: it
// can re-post a recorded sealed request or hold one back. The REAL executor
// runs here against a relay this test controls and a target that counts hits.
import { test, expect, beforeAll, afterAll } from "vitest";
import * as http from "node:http";
import { randomUUID } from "node:crypto";
import { startTunnelExecutor, type ExecutorHandle } from "./executor";
import { deriveTunnelKey } from "./sealedStream";
import { sealRequest, openHeadAndBody, requestBinding, type ResponseHead } from "./wire";
import { SeenStreamIds, staleReason, STALE_PAST_MS, STALE_FUTURE_MS } from "./replayGuard";

const MKEY = new Uint8Array(32).fill(7);
const MACHINE = "m-replay";
const KEY = deriveTunnelKey(MKEY, MACHINE);
const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

const inbox: { requestId: string; payload: string }[] = [];
const waiting = new Map<string, { bufs: Buffer[]; resolve: (b: Buffer) => void }>();
let relay: http.Server; let target: http.Server; let executor: ExecutorHandle;
let hits = 0;
const readAll = (req: http.IncomingMessage) => new Promise<Buffer>((r) => { const c: Buffer[] = []; req.on("data", (d) => c.push(d)); req.on("end", () => r(Buffer.concat(c))); });

/** What a (malicious) relay does: hand these exact bytes to the daemon as a
 *  fresh requestId; resolve with the daemon's complete sealed reply. */
function deliver(payload: Uint8Array): Promise<Buffer> {
  const requestId = randomUUID();
  return new Promise((resolve) => {
    waiting.set(requestId, { bufs: [], resolve });
    inbox.push({ requestId, payload: Buffer.from(payload).toString("base64") });
  });
}
const open = (resp: Buffer, wire: Uint8Array) => {
  const { head, body } = openHeadAndBody<ResponseHead>(KEY, resp, requestBinding(wire));
  return { head, body: dec(body) };
};

beforeAll(async () => {
  target = http.createServer(async (req, res) => { await readAll(req); hits++; res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ hits })); });
  await new Promise<void>((r) => target.listen(0, "127.0.0.1", r));
  relay = http.createServer(async (req, res) => {
    const url = new URL(req.url!, "http://x");
    if (/\/claims\/tunnel$/.test(url.pathname)) {
      await readAll(req);
      const deadline = Date.now() + 500;
      while (inbox.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ requests: inbox.splice(0) })); return;
    }
    const m = url.pathname.match(/\/tunnel\/([^/]+)\/frames$/);
    if (m) {
      const chunk = await readAll(req); const w = waiting.get(m[1])!;
      w.bufs.push(chunk);
      if (url.searchParams.get("done") === "1") { waiting.delete(m[1]); w.resolve(Buffer.concat(w.bufs)); }
      res.writeHead(200, { "content-type": "application/json" }); res.end('{"ok":true}'); return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise<void>((r) => relay.listen(0, "127.0.0.1", r));
  executor = startTunnelExecutor({
    relayUrl: `http://127.0.0.1:${(relay.address() as any).port}`, accountToken: "t", machineKey: MKEY, machineId: MACHINE,
    targetBase: `http://127.0.0.1:${(target.address() as any).port}`, borrowLease: () => ({ leaseId: "L", leaseToken: "T" }),
  });
  await new Promise((r) => setTimeout(r, 100));
}, 20_000);
afterAll(async () => { await executor?.stop(); relay?.close(); target?.close(); });

test("re-posted identical bytes execute ONCE; the second reply is a sealed 409 replayed_request bound to the request", async () => {
  const before = hits;
  const wire = sealRequest(KEY, { m: "POST", p: "/write", h: {}, t: Date.now() }, enc("once"));
  const first = open(await deliver(wire), wire);
  expect(first.head.s).toBe(200);
  const second = open(await deliver(wire), wire);       // relay replays
  const third = open(await deliver(wire), wire);        // …and again
  expect(hits).toBe(before + 1);
  for (const r of [second, third]) {
    expect(r.head.s).toBe(409);
    expect(r.head.h["x-tunnel-error"]).toBe("replayed_request");
    expect(r.head.h["content-type"]).toBe("application/json");
    expect(JSON.parse(r.body)).toEqual({ error: "replayed_request" });
    expect(r.head.r).toBe(requestBinding(wire));      // bound: another client never accepts it
  }
});

test("old app (no `t`) still works and is still deduped by stream id", async () => {
  const before = hits;
  const wire = sealRequest(KEY, { m: "POST", p: "/write", h: {} }, enc("legacy"));
  expect(open(await deliver(wire), wire).head.s).toBe(200);
  const replay = open(await deliver(wire), wire);
  expect(replay.head.s).toBe(409); expect(JSON.parse(replay.body)).toEqual({ error: "replayed_request" });
  expect(hits).toBe(before + 1);
});

test("a held-back request (`t` older than 10 min) or one from the future (> 2 min) gets 409 stale_request and never reaches the target", async () => {
  const before = hits;
  for (const t of [Date.now() - STALE_PAST_MS - 1_000, Date.now() + STALE_FUTURE_MS + 1_000]) {
    const wire = sealRequest(KEY, { m: "POST", p: "/write", h: {}, t }, enc("late"));
    const r = open(await deliver(wire), wire);
    expect(r.head.s).toBe(409); expect(r.head.h["x-tunnel-error"]).toBe("stale_request");
    expect(JSON.parse(r.body)).toEqual({ error: "stale_request" });
  }
  expect(hits).toBe(before);
  // inside the window (9 min old, 1 min ahead) still executes
  for (const t of [Date.now() - 9 * 60_000, Date.now() + 60_000]) {
    const wire = sealRequest(KEY, { m: "POST", p: "/write", h: {}, t }, enc("ok"));
    expect(open(await deliver(wire), wire).head.s).toBe(200);
  }
  expect(hits).toBe(before + 2);
});

test("an unsealable payload is NOT recorded — a spliced stream id cannot lock out the real request", async () => {
  const real = sealRequest(KEY, { m: "POST", p: "/write", h: {}, t: Date.now() }, enc("real"));
  const other = sealRequest(KEY, { m: "POST", p: "/write", h: {}, t: Date.now() }, enc("other"));
  const spliced = new Uint8Array(other.length); spliced.set(real.subarray(0, 16)); spliced.set(other.subarray(16), 16);
  const bad = openHeadAndBody<ResponseHead>(KEY, await deliver(spliced), requestBinding(real));
  expect(bad.head.s).toBe(400);
  expect(open(await deliver(real), real).head.s).toBe(200);
});

test("SeenStreamIds: bounded and windowed", () => {
  let now = 1_000_000;
  const g = new SeenStreamIds({ max: 3, windowMs: 1000, now: () => now });
  expect(g.seenOrRecord("a")).toBe(false);
  expect(g.seenOrRecord("a")).toBe(true);
  g.seenOrRecord("b"); g.seenOrRecord("c"); g.seenOrRecord("d"); // evicts a (oldest)
  expect(g.size).toBe(3);
  expect(g.seenOrRecord("a")).toBe(false);                     // forgotten by eviction
  now += 1000;                                                 // window elapsed
  expect(g.seenOrRecord("d")).toBe(false);                     // forgotten by expiry
  expect(g.seenOrRecord("d")).toBe(true);
});

test("staleReason: absent/garbage t is accepted (old client); bounds are inclusive of the window", () => {
  const now = 5_000_000_000;
  expect(staleReason(undefined, now)).toBeNull();
  expect(staleReason("123", now)).toBeNull();
  expect(staleReason(now - STALE_PAST_MS, now)).toBeNull();
  expect(staleReason(now - STALE_PAST_MS - 1, now)).toBe("stale_request");
  expect(staleReason(now + STALE_FUTURE_MS, now)).toBeNull();
  expect(staleReason(now + STALE_FUTURE_MS + 1, now)).toBe("stale_request");
});
