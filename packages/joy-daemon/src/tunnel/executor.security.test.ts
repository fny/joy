// #119 / #82 on the tunnel executor, against a relay and a target this test
// controls (same shape as executor.gone.test.ts, but in OWN-lease mode so the
// lease acquire/renew fetches are exercised too):
//  - a sealed request whose path would rehome the local fetch (`@host/…`,
//    `//host/…`, a bare relative path) is answered with a sealed 400 bad_path
//    and NEVER reaches the target — the daemon token stays on loopback (#119);
//  - every relay fetch (lease, claim, frames) carries x-joy-relay-key when a
//    perimeter key is configured, so flipping the gate does not silently kill
//    the tunnel plane (#82).
import { test, expect, beforeAll, afterAll } from "vitest";
import * as http from "node:http";
import { randomUUID } from "node:crypto";
import { startTunnelExecutor, resolveLocalPath, type ExecutorHandle } from "./executor";
import { deriveTunnelKey } from "./sealedStream";
import { sealRequest, openHeadAndBody, type ResponseHead } from "./wire";

const MKEY = new Uint8Array(32).fill(3);
const MACHINE = "m-sec";
const KEY = deriveTunnelKey(MKEY, MACHINE);
const GATE_KEY = "perimeter-key-for-test";

const inbox: { requestId: string; payload: string }[] = [];
const relayHits: Array<{ path: string; key: string | undefined }> = [];
const frames = new Map<string, Buffer[]>();
const targetHits: string[] = [];
let relay: http.Server; let target: http.Server; let executor: ExecutorHandle;
let savedKey: string | undefined;
const readAll = (req: http.IncomingMessage) => new Promise<Buffer>((r) => { const c: Buffer[] = []; req.on("data", (d) => c.push(d)); req.on("end", () => r(Buffer.concat(c))); });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) { if (Date.now() > deadline) throw new Error("timeout"); await sleep(20); }
}
function deliver(path: string): string {
  const requestId = randomUUID();
  frames.set(requestId, []);
  const wire = sealRequest(KEY, { m: "GET", p: path, h: {}, t: Date.now() }, new Uint8Array(0));
  inbox.push({ requestId, payload: Buffer.from(wire).toString("base64") });
  return requestId;
}
/** The complete sealed response the relay collected for a request. */
function response(requestId: string): { head: ResponseHead; body: string } {
  const { head, body } = openHeadAndBody<ResponseHead>(KEY, new Uint8Array(Buffer.concat(frames.get(requestId)!)));
  return { head, body: Buffer.from(body).toString("utf8") };
}

beforeAll(async () => {
  savedKey = process.env.JOY_RELAY_ACCESS_KEY;
  process.env.JOY_RELAY_ACCESS_KEY = GATE_KEY;
  target = http.createServer(async (req, res) => {
    await readAll(req);
    targetHits.push(req.url!);
    res.writeHead(200, { "content-type": "text/plain" }); res.end("hello");
  });
  await new Promise<void>((r) => target.listen(0, "127.0.0.1", r));
  relay = http.createServer(async (req, res) => {
    const url = new URL(req.url!, "http://x");
    relayHits.push({ path: url.pathname, key: req.headers["x-joy-relay-key"] as string | undefined });
    const body = await readAll(req);
    if (url.pathname === "/joy/v2/daemon/leases") {
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ leaseId: "L9", leaseToken: "T9", ttlSeconds: 60 })); return;
    }
    if (/\/claims\/tunnel$/.test(url.pathname)) {
      const deadline = Date.now() + 300;
      while (inbox.length === 0 && Date.now() < deadline) await sleep(5);
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ requests: inbox.splice(0) })); return;
    }
    const m = url.pathname.match(/\/tunnel\/([^/]+)\/frames$/);
    if (m) {
      frames.get(m[1])?.push(body);
      res.writeHead(200, { "content-type": "application/json" }); res.end('{"ok":true}'); return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise<void>((r) => relay.listen(0, "127.0.0.1", r));
  executor = startTunnelExecutor({
    relayUrl: `http://127.0.0.1:${(relay.address() as any).port}`, accountToken: "acct", machineKey: MKEY, machineId: MACHINE,
    targetBase: `http://127.0.0.1:${(target.address() as any).port}`, targetHeaders: { "X-Joy-Token": "local-secret" },
  });
  await sleep(100);
}, 20_000);
afterAll(async () => {
  await executor?.stop(); relay?.close(); target?.close();
  if (savedKey === undefined) delete process.env.JOY_RELAY_ACCESS_KEY; else process.env.JOY_RELAY_ACCESS_KEY = savedKey;
});

test("resolveLocalPath: only /-rooted paths on the target origin are dispatchable (#119)", () => {
  const base = "http://127.0.0.1:4997";
  expect(resolveLocalPath(base, "/sessions")).toBe("http://127.0.0.1:4997/sessions");
  expect(resolveLocalPath(base, "/v2/files?path=a%20b")).toBe("http://127.0.0.1:4997/v2/files?path=a%20b");
  for (const bad of ["@evil.example/x", "//evil.example/x", "/\\evil.example/x", "/@evil.example/x", "http://evil.example/x", "sessions", "", "/a b", undefined, 42]) {
    expect(resolveLocalPath(base, bad), String(bad)).toBeNull();
  }
});

test("a rehoming path never reaches the target: sealed 400 bad_path, bound to the request (#119)", async () => {
  const ids = ["@evil.example/x", "//evil.example/x", "sessions"].map(deliver);
  await until(() => ids.every((id) => (frames.get(id)?.length ?? 0) > 0));
  for (const id of ids) {
    const { head, body } = response(id);
    expect(head.s).toBe(400);
    expect(head.h["x-tunnel-error"]).toBe("bad_path");
    expect(JSON.parse(body)).toEqual({ error: "bad_path" });
  }
  await sleep(100);
  expect(targetHits).toEqual([]); // nothing was dispatched anywhere
});

test("a legitimate path still reaches the target (control)", async () => {
  const id = deliver("/ok?x=1");
  await until(() => (frames.get(id)?.length ?? 0) > 0 && frames.get(id)!.length >= 1 && targetHits.length > 0);
  await until(() => { try { return response(id).head.s === 200; } catch { return false; } });
  expect(targetHits).toEqual(["/ok?x=1"]);
  expect(response(id).body).toBe("hello");
});

test("every relay fetch carries the perimeter key: lease acquire, tunnel claims, frame posts (#82)", async () => {
  const kinds = { lease: /^\/joy\/v2\/daemon\/leases$/, claim: /\/claims\/tunnel$/, frames: /\/frames$/ };
  for (const [name, re] of Object.entries(kinds)) {
    const hits = relayHits.filter((h) => re.test(h.path));
    expect(hits.length, name).toBeGreaterThan(0);
    expect(hits.every((h) => h.key === GATE_KEY), `${name} without x-joy-relay-key`).toBe(true);
  }
});
