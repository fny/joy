// #82 follow-ups on the executor in OWN-lease mode, against a relay whose
// perimeter gate this test flips:
//  - a failed FIRST lease acquire (gate on, no key) is logged and retried
//    with backoff — it used to reject the loop promise unobserved, an
//    unhandledRejection that took the process down;
//  - the "relay key required" line is said once per OUTAGE, not once per
//    process: after the key is accepted again a later flip / key rotation
//    logs again.
import { test, expect, beforeAll, afterAll } from "vitest";
import * as http from "node:http";
import { randomUUID } from "node:crypto";
import { startTunnelExecutor, type ExecutorHandle } from "./executor";
import { deriveTunnelKey } from "./sealedStream";
import { sealRequest, openHeadAndBody, type ResponseHead } from "./wire";

const MKEY = new Uint8Array(32).fill(5);
const MACHINE = "m-gate";
const KEY = deriveTunnelKey(MKEY, MACHINE);

let gateKey: string | null = null; // the relay's JOY_RELAY_ACCESS_KEY; null = gate open
const inbox: { requestId: string; payload: string }[] = [];
const frames = new Map<string, Buffer[]>();
const logs: string[] = [];
let relay: http.Server; let target: http.Server; let executor: ExecutorHandle;
let savedKey: string | undefined; let savedHome: string | undefined;
const readAll = (req: http.IncomingMessage) => new Promise<Buffer>((r) => { const c: Buffer[] = []; req.on("data", (d) => c.push(d)); req.on("end", () => r(Buffer.concat(c))); });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean, ms = 8_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) { if (Date.now() > deadline) throw new Error("timeout"); await sleep(20); }
}
function deliver(path: string): string {
  const requestId = randomUUID();
  frames.set(requestId, []);
  inbox.push({ requestId, payload: Buffer.from(sealRequest(KEY, { m: "GET", p: path, h: {}, t: Date.now() }, new Uint8Array(0))).toString("base64") });
  return requestId;
}
const status = (id: string): number | null => {
  try { return openHeadAndBody<ResponseHead>(KEY, new Uint8Array(Buffer.concat(frames.get(id)!))).head.s; } catch { return null; }
};
const gateLines = () => logs.filter((l) => /refused: relay key required/.test(l));
const acceptedLines = () => logs.filter((l) => /accepted again/.test(l));

beforeAll(async () => {
  savedKey = process.env.JOY_RELAY_ACCESS_KEY; savedHome = process.env.JOY_HOME_DIR;
  delete process.env.JOY_RELAY_ACCESS_KEY;
  process.env.JOY_HOME_DIR = `/tmp/joy-executor-gate-${process.pid}`; // no perimeter.key on disk
  target = http.createServer(async (req, res) => { await readAll(req); res.writeHead(200); res.end("hello"); });
  await new Promise<void>((r) => target.listen(0, "127.0.0.1", r));
  relay = http.createServer(async (req, res) => {
    const body = await readAll(req);
    if (gateKey !== null && req.headers["x-joy-relay-key"] !== gateKey) {
      res.writeHead(401, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "relay key required", relay: "joy-relay" })); return;
    }
    const url = new URL(req.url!, "http://x");
    if (url.pathname === "/joy/v2/daemon/leases") {
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ leaseId: "L1", leaseToken: "T1", ttlSeconds: 60 })); return;
    }
    if (/\/claims\/tunnel$/.test(url.pathname)) {
      const deadline = Date.now() + 150;
      while (inbox.length === 0 && Date.now() < deadline) await sleep(5);
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ requests: inbox.splice(0) })); return;
    }
    const m = url.pathname.match(/\/tunnel\/([^/]+)\/frames$/);
    if (m) { frames.get(m[1])?.push(body); res.writeHead(200, { "content-type": "application/json" }); res.end('{"ok":true}'); return; }
    res.writeHead(404); res.end();
  });
  await new Promise<void>((r) => relay.listen(0, "127.0.0.1", r));
}, 20_000);
afterAll(async () => {
  await executor?.stop(); relay?.close(); target?.close();
  if (savedKey === undefined) delete process.env.JOY_RELAY_ACCESS_KEY; else process.env.JOY_RELAY_ACCESS_KEY = savedKey;
  if (savedHome === undefined) delete process.env.JOY_HOME_DIR; else process.env.JOY_HOME_DIR = savedHome;
});

test("own-lease: a gate-refused FIRST acquire is logged and retried, never an unobserved rejection", async () => {
  gateKey = "gate-" + randomUUID();
  const unhandled: unknown[] = [];
  const onUnhandled = (e: unknown) => unhandled.push(e);
  process.on("unhandledRejection", onUnhandled);
  executor = startTunnelExecutor({
    relayUrl: `http://127.0.0.1:${(relay.address() as any).port}`, accountToken: "acct", machineKey: MKEY, machineId: MACHINE,
    targetBase: `http://127.0.0.1:${(target.address() as any).port}`, targetHeaders: { "X-Joy-Token": "local-secret" },
    log: (l) => logs.push(l),
  });
  await until(() => logs.some((l) => /lease acquire failed: 401 .*relay key required.*retrying in 1000 ms/.test(l)));
  expect(gateLines().length).toBe(1);
  expect(executor.leaseId()).toBeNull();
  // The operator sets the key: the next retry acquires and serves.
  process.env.JOY_RELAY_ACCESS_KEY = gateKey;
  await until(() => executor.leaseId() === "L1", 5_000);
  const id = deliver("/ok");
  await until(() => status(id) === 200);
  await sleep(50);
  process.off("unhandledRejection", onUnhandled);
  expect(unhandled).toEqual([]);
  expect(acceptedLines().length).toBe(1);
  expect(gateLines().length).toBe(1); // still once for this outage
}, 15_000);

test("a later key rotation is logged AGAIN, then cleared once the new key is accepted", async () => {
  const before = gateLines().length;
  gateKey = "rotated-" + randomUUID(); // daemon still presents the old key
  await until(() => gateLines().length === before + 1, 6_000);
  await sleep(1200); // more refused claims/re-acquires: still one line for this outage
  expect(gateLines().length).toBe(before + 1);
  process.env.JOY_RELAY_ACCESS_KEY = gateKey;
  const id = deliver("/after-rotation");
  await until(() => status(id) === 200, 6_000);
  expect(acceptedLines().length).toBe(2);
  expect(logs.some((l) => l.includes(gateKey!))).toBe(false); // the key value is never logged
}, 15_000);
