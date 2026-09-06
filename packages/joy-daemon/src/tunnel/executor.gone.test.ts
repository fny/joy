// #83: the relay answers a frame post for a gone (client left, idle deadline)
// or foreign request with 404 request_gone / 403 wrong_daemon. The executor
// must then RELEASE the local response it was streaming — a local SSE
// response read to nobody used to stay open for as long as the local surface
// kept writing. The REAL executor runs here against a relay this test
// controls and a target whose response lifetime it observes.
import { test, expect, beforeAll, afterAll } from "vitest";
import * as http from "node:http";
import { randomUUID } from "node:crypto";
import { startTunnelExecutor, type ExecutorHandle } from "./executor";
import { deriveTunnelKey } from "./sealedStream";
import { sealRequest } from "./wire";

const MKEY = new Uint8Array(32).fill(9);
const MACHINE = "m-gone";
const KEY = deriveTunnelKey(MKEY, MACHINE);

const inbox: { requestId: string; payload: string }[] = [];
/** Per request: how many frame posts to accept before the relay's 4xx, and what it answers. */
const script = new Map<string, { okPosts: number; status: number; error: string; posts: number }>();
/** Target-side view: open SSE responses by request path, and whether they closed. */
const streams = new Map<string, { closed: boolean; writes: number }>();
let relay: http.Server; let target: http.Server; let executor: ExecutorHandle;
const readAll = (req: http.IncomingMessage) => new Promise<Buffer>((r) => { const c: Buffer[] = []; req.on("data", (d) => c.push(d)); req.on("end", () => r(Buffer.concat(c))); });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) { if (Date.now() > deadline) throw new Error("timeout"); await sleep(20); }
}

function deliver(path: string, okPosts: number, status: number, error: string): string {
  const requestId = randomUUID();
  script.set(requestId, { okPosts, status, error, posts: 0 });
  const wire = sealRequest(KEY, { m: "GET", p: path, h: {}, t: Date.now() }, new Uint8Array(0));
  inbox.push({ requestId, payload: Buffer.from(wire).toString("base64") });
  return requestId;
}

beforeAll(async () => {
  // The local surface: an SSE endpoint that writes forever, until the client goes away.
  target = http.createServer(async (req, res) => {
    await readAll(req);
    const st = { closed: false, writes: 0 };
    streams.set(req.url!, st);
    res.writeHead(200, { "content-type": "text/event-stream" });
    const timer = setInterval(() => { st.writes++; res.write(`data: ${st.writes}\n\n`); }, 20);
    res.on("close", () => { st.closed = true; clearInterval(timer); });
  });
  await new Promise<void>((r) => target.listen(0, "127.0.0.1", r));
  relay = http.createServer(async (req, res) => {
    const url = new URL(req.url!, "http://x");
    if (/\/claims\/tunnel$/.test(url.pathname)) {
      await readAll(req);
      const deadline = Date.now() + 300;
      while (inbox.length === 0 && Date.now() < deadline) await sleep(5);
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ requests: inbox.splice(0) })); return;
    }
    const m = url.pathname.match(/\/tunnel\/([^/]+)\/frames$/);
    if (m) {
      await readAll(req);
      const sc = script.get(m[1])!;
      sc.posts++;
      if (sc.posts > sc.okPosts) {
        res.writeHead(sc.status, { "content-type": "application/json" }); res.end(JSON.stringify({ error: sc.error })); return;
      }
      res.writeHead(200, { "content-type": "application/json" }); res.end('{"ok":true}'); return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise<void>((r) => relay.listen(0, "127.0.0.1", r));
  executor = startTunnelExecutor({
    relayUrl: `http://127.0.0.1:${(relay.address() as any).port}`, accountToken: "t", machineKey: MKEY, machineId: MACHINE,
    targetBase: `http://127.0.0.1:${(target.address() as any).port}`, borrowLease: () => ({ leaseId: "L", leaseToken: "T" }),
  });
  await sleep(100);
}, 20_000);
afterAll(async () => { await executor?.stop(); relay?.close(); target?.close(); });

test("404 request_gone mid-stream releases the local SSE response and stops the frame posts", async () => {
  const id = deliver("/events/gone", 3, 404, "request_gone");
  await until(() => streams.get("/events/gone")?.closed === true);
  const st = streams.get("/events/gone")!;
  const posts = script.get(id)!.posts;
  expect(posts).toBe(4);                       // 3 accepted + the one the relay refused, then nothing
  await sleep(200);
  expect(script.get(id)!.posts).toBe(4);       // no further posts after the refusal
  expect(st.writes).toBeLessThan(200);         // the target stopped writing because its client left, not because time ran out
});

test("403 wrong_daemon is treated the same way", async () => {
  const id = deliver("/events/foreign", 1, 403, "wrong_daemon");
  await until(() => streams.get("/events/foreign")?.closed === true);
  await sleep(200);
  expect(script.get(id)!.posts).toBe(2);
});

test("a stream the relay keeps accepting is NOT cut off (control)", async () => {
  deliver("/events/live", Number.MAX_SAFE_INTEGER, 200, "");
  await until(() => (streams.get("/events/live")?.writes ?? 0) >= 5);
  expect(streams.get("/events/live")!.closed).toBe(false);
});
