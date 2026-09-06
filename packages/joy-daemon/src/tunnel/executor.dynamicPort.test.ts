// #588 — a dynamically bound local HTTP port.
//
// With PORT=0 the kernel picks the port and only `onListening` learns it, but
// the executor captured `http://127.0.0.1:${PORT}` at construction. Every
// tunneled files / git / terminal / usage request therefore dialled port zero
// and came back a sealed 502, while the local HTTP surface was perfectly
// healthy. The base is resolved per request now, so the executor may start
// before the port exists — and follows it if it ever moves.
import { test, expect, beforeAll, afterAll } from "vitest";
import * as http from "node:http";
import { randomUUID } from "node:crypto";
import { startTunnelExecutor, type ExecutorHandle } from "./executor";
import { deriveTunnelKey } from "./sealedStream";
import { sealRequest, openHeadAndBody, type ResponseHead } from "./wire";

const MKEY = new Uint8Array(32).fill(7);
const MACHINE = "m-dynport";
const KEY = deriveTunnelKey(MKEY, MACHINE);

const inbox: { requestId: string; payload: string }[] = [];
const frames = new Map<string, Buffer[]>();
let relay: http.Server; let target: http.Server; let executor: ExecutorHandle;
/** What the executor should dial. Starts at port 0 — nothing listens there. */
let base = "http://127.0.0.1:0";

const readAll = (req: http.IncomingMessage) => new Promise<Buffer>((r) => { const c: Buffer[] = []; req.on("data", (d) => c.push(d)); req.on("end", () => r(Buffer.concat(c))); });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function deliver(path: string): string {
  const requestId = randomUUID();
  frames.set(requestId, []);
  const wire = sealRequest(KEY, { m: "GET", p: path, h: {}, t: Date.now() }, new Uint8Array(0));
  inbox.push({ requestId, payload: Buffer.from(wire).toString("base64") });
  return requestId;
}

/** The sealed response the relay collected, once the stream is complete. */
async function response(requestId: string, ms = 10_000): Promise<ResponseHead> {
  const deadline = Date.now() + ms;
  for (;;) {
    const got = frames.get(requestId)!;
    if (got.length) {
      try { return openHeadAndBody<ResponseHead>(KEY, new Uint8Array(Buffer.concat(got))).head; }
      catch { /* not every frame is in yet */ }
    }
    if (Date.now() > deadline) throw new Error("timeout waiting for the sealed response");
    await sleep(20);
  }
}

beforeAll(async () => {
  target = http.createServer(async (req, res) => {
    await readAll(req);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, path: req.url }));
  });
  await new Promise<void>((r) => target.listen(0, "127.0.0.1", r));
  relay = http.createServer(async (req, res) => {
    const url = new URL(req.url!, "http://x");
    if (/\/claims\/tunnel$/.test(url.pathname)) {
      await readAll(req);
      const deadline = Date.now() + 200;
      while (inbox.length === 0 && Date.now() < deadline) await sleep(5);
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ requests: inbox.splice(0) })); return;
    }
    const m = url.pathname.match(/\/tunnel\/([^/]+)\/frames$/);
    if (m) {
      const body = await readAll(req);
      frames.get(m[1])?.push(body);
      res.writeHead(200, { "content-type": "application/json" }); res.end('{"ok":true}'); return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise<void>((r) => relay.listen(0, "127.0.0.1", r));
  // Constructed BEFORE the local port is known — the boot order in server.ts,
  // where onListening fires after startTunnelExecutor has been called.
  executor = startTunnelExecutor({
    relayUrl: `http://127.0.0.1:${(relay.address() as any).port}`, accountToken: "t", machineKey: MKEY, machineId: MACHINE,
    targetBase: () => base, borrowLease: () => ({ leaseId: "L", leaseToken: "T" }),
  });
  await sleep(100);
}, 20_000);
afterAll(async () => { await executor?.stop(); relay?.close(); target?.close(); });

test("the executor dials the port the local server actually bound, not the one it was configured with", async () => {
  base = `http://127.0.0.1:${(target.address() as any).port}`; // what onListening does
  const head = await response(deliver("/api/files"));
  expect(head.s).toBe(200);
  expect(head.h?.["x-tunnel-error"]).toBeUndefined();
});

test("with nothing bound yet the failure is honest, not silent", async () => {
  const was = base;
  base = "http://127.0.0.1:0"; // the value the old executor kept forever
  try {
    const head = await response(deliver("/api/files"));
    expect(head.s).toBe(502);
    expect(head.h?.["x-tunnel-error"]).toBe("daemon_fetch_failed");
  } finally { base = was; }
});

test("a later rebind is picked up without restarting the executor", async () => {
  const second = http.createServer(async (req, res) => {
    await readAll(req);
    res.writeHead(201, { "content-type": "application/json" }); res.end('{"second":true}');
  });
  await new Promise<void>((r) => second.listen(0, "127.0.0.1", r));
  const was = base;
  try {
    base = `http://127.0.0.1:${(second.address() as any).port}`;
    expect((await response(deliver("/api/files"))).s).toBe(201);
  } finally { base = was; second.close(); }
});
