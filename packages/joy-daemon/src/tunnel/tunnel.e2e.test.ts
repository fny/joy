// End-to-end tunnel test: the REAL relay router (routes.mjs + core.mjs +
// PGlite db), a REAL local HTTP target standing in for the daemon surface,
// the real executor, the real client. The only stub is auth's upstream
// account check — createAuth exposes fetchImpl for exactly this.
//
// What "thorough" means here: the happy path at three sizes, streaming
// (chunks observed before the response completes), header/body fidelity,
// and the adversarial/broken cases — offline daemon, foreign account,
// wrong client secret, and relay blindness (no plaintext in transit).
import { test, expect, beforeAll, afterAll } from "vitest";
import * as http from "node:http";
import * as net from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { startTunnelExecutor, type ExecutorHandle } from "./executor";
import { tunnelFetch, TunnelError } from "./client";

// The relay is ESM .mjs — vitest resolves these fine from the sibling package.
import { openDb } from "../../../joy-relay/src/db.mjs";
import { createCore } from "../../../joy-relay/src/core.mjs";
import { createNotify } from "../../../joy-relay/src/notify.mjs";
import { createAuth } from "../../../joy-relay/src/auth.mjs";
import { createRouter } from "../../../joy-relay/src/routes.mjs";
import { createTunnel } from "../../../joy-relay/src/tunnel.mjs";

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const SECRET_A = new Uint8Array(32).fill(3);
const MACHINE = "m-e2e-1";
const BIG = new Uint8Array(randomBytes(5 * 1024 * 1024));

let dataDir: string;
let relay: http.Server; let relayUrl: string;
let target: http.Server; let targetUrl: string;
let executor: ExecutorHandle | null = null;
let db: any;
let seenOnWire: Buffer[] = []; // TCP-level tap for the blindness assertion
let tap: net.Server; let tapUrl: string;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "joy-tunnel-e2e-"));
  db = await openDb(dataDir);
  const notify = createNotify();
  const core = createCore(db, notify);
  // Auth stub: 'tok-A' → account A, 'tok-B' → account B, anything else 401.
  const auth = createAuth({
    upstreamHost: "x", upstreamPort: 0,
    fetchImpl: async (_url: string, init: any) => {
      const token = String(init?.headers?.Authorization ?? "").replace("Bearer ", "");
      if (token === "tok-A") return { ok: true, json: async () => ({ id: "acct-A" }) } as any;
      if (token === "tok-B") return { ok: true, json: async () => ({ id: "acct-B" }) } as any;
      return { ok: false } as any;
    },
  });
  const tunnel = createTunnel({ notify });
  const router = createRouter({ core, auth, notify, db, tunnel });

  relay = http.createServer((req, res) => {
    void router.handle(req, res).then((handled: boolean) => {
      if (!handled) { res.writeHead(404); res.end(); }
    });
  });
  await new Promise<void>((r) => relay.listen(0, "127.0.0.1", r));
  relayUrl = `http://127.0.0.1:${(relay.address() as any).port}`;

  // Blindness tap: a dumb TCP proxy in FRONT of the relay records every byte
  // in both directions without touching stream consumption — exactly the
  // vantage point of "what could this hop read". First wiretap attempt
  // attached data listeners inside the request handler and RACED the router's
  // own body reader; taps must be passive.
  const relayPort = (relay.address() as any).port;
  tap = net.createServer((client) => {
    const up = net.connect(relayPort, "127.0.0.1");
    client.on("data", (c) => seenOnWire.push(Buffer.from(c)));
    up.on("data", (c) => seenOnWire.push(Buffer.from(c)));
    client.pipe(up).pipe(client);
    const kill = () => { client.destroy(); up.destroy(); };
    client.on("error", kill); up.on("error", kill);
  });
  await new Promise<void>((r) => tap.listen(0, "127.0.0.1", r));
  tapUrl = `http://127.0.0.1:${(tap.address() as any).port}`;

  // The stand-in daemon surface: enough shapes to exercise everything.
  target = http.createServer((req, res) => {
    const url = new URL(req.url!, "http://t");
    if (req.method === "GET" && url.pathname === "/hello") {
      res.writeHead(200, { "content-type": "application/json", "x-daemon": "yes" });
      res.end(JSON.stringify({ ok: true, secret: "MARKER_PLAINTEXT_hello" }));
    } else if (req.method === "GET" && url.pathname === "/big") {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      // Write in pieces so the executor genuinely streams.
      let off = 0;
      const step = () => {
        if (off >= BIG.length) return res.end();
        res.write(Buffer.from(BIG.subarray(off, off + 256 * 1024)));
        off += 256 * 1024;
        setImmediate(step);
      };
      step();
    } else if (req.method === "POST" && url.pathname === "/echo") {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        res.writeHead(201, { "content-type": "application/octet-stream", "x-echo-header": String(req.headers["x-probe"] ?? "") });
        res.end(Buffer.concat(chunks));
      });
    } else if (req.method === "GET" && url.pathname === "/drip") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: one\n\n");
      setTimeout(() => { res.write("data: two\n\n"); res.end(); }, 150);
    } else {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "nope" }));
    }
  });
  await new Promise<void>((r) => target.listen(0, "127.0.0.1", r));
  targetUrl = `http://127.0.0.1:${(target.address() as any).port}`;

  executor = startTunnelExecutor({
    relayUrl: tapUrl, accountToken: "tok-A", masterSecret: SECRET_A,
    machineId: MACHINE, targetBase: targetUrl,
  });
  // Wait for the executor to attach (first claim poll).
  await new Promise((r) => setTimeout(r, 300));
}, 30_000);

afterAll(async () => {
  await executor?.stop();
  relay?.close(); target?.close(); tap?.close();
  await db?.close?.();
  rmSync(dataDir, { recursive: true, force: true });
});

const call = (over: Partial<Parameters<typeof tunnelFetch>[0]> = {}) =>
  tunnelFetch({
    relayUrl: tapUrl, accountToken: "tok-A", masterSecret: SECRET_A, machineId: MACHINE,
    method: "GET", path: "/hello", ...over,
  });

test("GET round-trips status, headers and body through the sealed tunnel", async () => {
  const r = await call();
  expect(r.status).toBe(200);
  expect(r.headers["x-daemon"]).toBe("yes");
  expect(JSON.parse(Buffer.from(r.body).toString())).toEqual({ ok: true, secret: "MARKER_PLAINTEXT_hello" });
});

test("POST body and request headers arrive intact; daemon status/headers return", async () => {
  const body = new Uint8Array(randomBytes(300_000));
  const r = await call({ method: "POST", path: "/echo", body, headers: { "x-probe": "p1" } });
  expect(r.status).toBe(201);
  expect(r.headers["x-echo-header"]).toBe("p1");
  expect(sha(r.body)).toBe(sha(body));
});

test("5MB response streams: chunks observed before completion, digest intact", async () => {
  let chunksBeforeDone = 0;
  const r = await call({ path: "/big", onChunk: () => { chunksBeforeDone++; } });
  expect(r.status).toBe(200);
  expect(sha(r.body)).toBe(sha(BIG));
  expect(chunksBeforeDone).toBeGreaterThan(10); // genuinely chunked, not one blob
}, 30_000);

test("SSE-shaped response (multiple timed writes) arrives in order", async () => {
  const r = await call({ path: "/drip" });
  expect(Buffer.from(r.body).toString()).toBe("data: one\n\ndata: two\n\n");
}, 15_000);

test("daemon 404s pass through as sealed daemon answers, not relay errors", async () => {
  const r = await call({ path: "/missing" });
  expect(r.status).toBe(404);
});

test("relay blindness: no plaintext marker in anything on the wire", () => {
  expect(seenOnWire.length).toBeGreaterThan(0);
  const all = Buffer.concat(seenOnWire);
  expect(all.includes("MARKER_PLAINTEXT_hello")).toBe(false);
  expect(all.includes("GET /hello")).toBe(false); // even the tunneled PATH is sealed
});

test("foreign account is refused before any tunneling happens", async () => {
  await expect(call({ accountToken: "tok-B" })).rejects.toMatchObject({ status: 403 });
});

test("wrong client secret cannot read the daemon's sealed reply", async () => {
  await expect(call({ masterSecret: new Uint8Array(32).fill(9) })).rejects.toThrow(/authentication|Tamper/i);
});

test("offline daemon fails fast with daemon_offline", async () => {
  await expect(tunnelFetch({
    relayUrl: tapUrl, accountToken: "tok-A", masterSecret: SECRET_A,
    machineId: "m-never-attached", method: "GET", path: "/hello",
  })).rejects.toMatchObject({ code: expect.stringMatching(/daemon_offline|daemon_unknown/) });
});
