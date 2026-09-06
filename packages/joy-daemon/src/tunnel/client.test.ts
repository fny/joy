// Client half of the tunnel against a scripted relay: the 503 busy family is
// retried with the relay's retry-after (bounded), daemon_offline is not, an
// early refusal is seen while a large body is still uploading, and a stream
// cut after its head is `connection_slow` (a GET re-asked once), not tamper.
import { test, expect, beforeAll, afterAll } from "vitest";
import * as http from "node:http";
import { tunnelFetch, TunnelError, retryAfterMs, TUNNEL_MAX_ATTEMPTS } from "./client";
import { deriveTunnelKey, SealedWriter } from "./sealedStream";
import { openHeadAndBody, requestBinding, type RequestHead, type ResponseHead } from "./wire";

const MASTER = new Uint8Array(32).fill(5);
const MACHINE = "m-client";
const KEY = deriveTunnelKey(MASTER, MACHINE);
const enc = (s: string) => new TextEncoder().encode(s);
const readAll = (req: http.IncomingMessage) => new Promise<Buffer>((r) => { const c: Buffer[] = []; req.on("data", (d) => c.push(d)); req.on("end", () => r(Buffer.concat(c))); });

type Step =
  | { kind: "json"; status: number; error: string; retryAfter?: string; readBody?: boolean }
  | { kind: "ok"; body: string }
  | { kind: "cut"; body: string }; // head + one body frame, then the socket is destroyed (no FINAL)
let script: Step[] = [];
let hits: { at: number; bodyBytes: number }[] = [];
let relay: http.Server; let relayUrl: string;

/** Sealed frames the daemon's executor would post for `head`+`body`, bound to the request. */
function sealFor(reqWire: Buffer, status: number, body: Uint8Array, final: boolean): Buffer {
  const w = new SealedWriter(KEY);
  const headBytes = enc(JSON.stringify({ s: status, h: { "content-type": "text/plain" }, r: requestBinding(reqWire) } satisfies ResponseHead));
  const parts = [w.header(), w.push(headBytes, false), w.push(body, final)];
  return Buffer.concat(parts.map((p) => Buffer.from(p)));
}

beforeAll(async () => {
  relay = http.createServer(async (req, res) => {
    const step = script.shift() ?? { kind: "json", status: 500, error: "unscripted" } as Step;
    if (step.kind === "json" && step.readBody === false) {
      // Refuse from the headers alone, like the relay's admission: the body
      // is never read; Node dumps it after the response so the client sees
      // the answer rather than a reset.
      hits.push({ at: Date.now(), bodyBytes: -1 });
      res.writeHead(step.status, { "content-type": "application/json", ...(step.retryAfter ? { "retry-after": step.retryAfter } : {}) });
      res.end(JSON.stringify({ error: step.error }));
      return;
    }
    const wire = await readAll(req);
    hits.push({ at: Date.now(), bodyBytes: wire.length });
    if (step.kind === "json") {
      res.writeHead(step.status, { "content-type": "application/json", ...(step.retryAfter ? { "retry-after": step.retryAfter } : {}) });
      res.end(JSON.stringify({ error: step.error }));
      return;
    }
    res.writeHead(200, { "content-type": "application/octet-stream" });
    if (step.kind === "ok") { res.end(sealFor(wire, 200, enc(step.body), true)); return; }
    res.write(sealFor(wire, 200, enc(step.body), false));
    setTimeout(() => res.destroy(), 30);
  });
  await new Promise<void>((r) => relay.listen(0, "127.0.0.1", r));
  relayUrl = `http://127.0.0.1:${(relay.address() as any).port}`;
});
afterAll(() => { relay?.close(); });

const call = (method = "GET", body?: Uint8Array) => tunnelFetch({
  relayUrl, accountToken: "tok", masterSecret: MASTER, machineId: MACHINE, method, path: "/v2/status", body,
});

test("retryAfterMs: seconds → ms, default 1s, capped at 5s", () => {
  expect(retryAfterMs("1")).toBe(1000);
  expect(retryAfterMs("0")).toBe(0);
  expect(retryAfterMs(null)).toBe(1000);
  expect(retryAfterMs("garbage")).toBe(1000);
  expect(retryAfterMs("60")).toBe(5000);
});

test("503 relay_busy / daemon_busy are retried after retry-after; the third attempt's answer is returned", async () => {
  hits = [];
  script = [
    { kind: "json", status: 503, error: "relay_busy", retryAfter: "0" },
    { kind: "json", status: 503, error: "daemon_busy", retryAfter: "0" },
    { kind: "ok", body: "finally" },
  ];
  const r = await call();
  expect(r.status).toBe(200);
  expect(new TextDecoder().decode(r.body)).toBe("finally");
  expect(hits.length).toBe(3);
});

test("still busy after the bounded attempts → TunnelError 503 with the relay's code, no more posts", async () => {
  hits = [];
  script = Array.from({ length: 10 }, () => ({ kind: "json", status: 503, error: "daemon_busy", retryAfter: "0" } as Step));
  await expect(call()).rejects.toMatchObject({ status: 503, code: "daemon_busy" });
  expect(hits.length).toBe(TUNNEL_MAX_ATTEMPTS);
  script = [];
});

test("retry-after paces the retry (0.2s honoured between attempts)", async () => {
  hits = [];
  script = [{ kind: "json", status: 503, error: "relay_busy", retryAfter: "0.2" }, { kind: "ok", body: "ok" }];
  await call();
  expect(hits[1].at - hits[0].at).toBeGreaterThanOrEqual(180);
});

test("503 daemon_offline is NOT retried — one post, immediate error", async () => {
  hits = [];
  script = [{ kind: "json", status: 503, error: "daemon_offline" }, { kind: "ok", body: "never" }];
  await expect(call()).rejects.toMatchObject({ status: 503, code: "daemon_offline" });
  expect(hits.length).toBe(1);
  script = [];
});

test("an early refusal (413 before the body is read) is seen while a 6 MiB body is still uploading", async () => {
  hits = [];
  script = [{ kind: "json", status: 413, error: "body_too_large", readBody: false }];
  const big = new Uint8Array(6 * 1024 * 1024);
  await expect(call("POST", big)).rejects.toMatchObject({ status: 413, code: "body_too_large" });
  expect(hits.length).toBe(1);
  expect(hits[0].bodyBytes).toBe(-1); // answered without reading the upload
});

test("a stream cut after its head is connection_slow (not tamper); a GET is re-asked once and succeeds", async () => {
  hits = [];
  script = [{ kind: "cut", body: "partial" }, { kind: "ok", body: "whole" }];
  const r = await call("GET");
  expect(new TextDecoder().decode(r.body)).toBe("whole");
  expect(hits.length).toBe(2);
  // Each attempt is a fresh sealed request (new stream id / t), never a byte-identical replay.
  script = [{ kind: "cut", body: "x" }, { kind: "cut", body: "y" }];
  await expect(call("GET")).rejects.toMatchObject({ status: 502, code: "connection_slow" });
  expect(hits.length).toBe(4);
});

test("a cut POST is not re-asked — connection_slow after one attempt", async () => {
  hits = [];
  script = [{ kind: "cut", body: "partial" }, { kind: "ok", body: "never" }];
  const err = await call("POST", enc("write")).catch((e) => e);
  expect(err).toBeInstanceOf(TunnelError);
  expect((err as TunnelError).code).toBe("connection_slow");
  expect(hits.length).toBe(1);
  script = [];
});

test("every attempt re-seals: the relay saw distinct stream ids and readable heads", async () => {
  hits = [];
  const seen: string[] = [];
  const orig = relay.listeners("request") as Array<(...a: any[]) => void>;
  relay.removeAllListeners("request");
  relay.on("request", async (req, res) => {
    const wire = await readAll(req);
    seen.push(requestBinding(wire));
    const { head } = openHeadAndBody<RequestHead>(KEY, wire);
    expect(head.m).toBe("GET"); expect(head.p).toBe("/v2/status");
    if (seen.length < 2) { res.writeHead(503, { "content-type": "application/json", "retry-after": "0" }); res.end('{"error":"relay_busy"}'); return; }
    res.writeHead(200, { "content-type": "application/octet-stream" }); res.end(sealFor(wire, 204, new Uint8Array(0), true));
  });
  try {
    const r = await call();
    expect(r.status).toBe(204);
    expect(seen.length).toBe(2);
    expect(seen[0]).not.toBe(seen[1]);
  } finally {
    relay.removeAllListeners("request");
    for (const l of orig) relay.on("request", l);
  }
});
