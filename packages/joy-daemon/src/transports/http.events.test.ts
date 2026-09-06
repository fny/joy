// The daemon's local HTTP surface, driven by real clients:
//  - #596: /docs authenticated by header/bearer must render — the spec is
//    embedded in the page instead of fetched with a (missing) query token;
//  - #597 Wave B: the opening history of /sessions/:id/events and /events is
//    streamed with backpressure. A READING client receives a legitimate
//    12 MiB history (192 × 64 KiB records) in full; a NON-READING client is
//    dropped at the drain deadline; live records published during the flush
//    are delivered after it, in order, none lost.
import { test, expect, beforeAll, afterAll, vi } from "vitest";
import * as net from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
process.env.JOY_HOME_DIR = mkdtempSync(join(tmpdir(), "joy-http-test-"));
import { startHttpServer, streamHistoryThenFollow } from "./http";
import * as http from "node:http";
import { RelaySession, encodeTextEvent, forgetRecords } from "../relay/relay";

const TOKEN = "tok-http-test";
const SID = "sid-http";
const RECORD_TEXT = "x".repeat(64 * 1024);
const RECORDS = 192;
let server: Server; let port = 0; let publicDir: string;
const sseSubs = new Set<(s: string) => void>();
const stderrLines: string[] = [];
const chat: Array<{ id: string; role: string; content: string; session_id: string }> = [];
const registry: any = {
  get: (id: string) => (id === SID ? { id: SID } : undefined),
  chatHistory: () => chat,
  list: () => [],
  subscribeSse: (fn: (s: string) => void) => { sseSubs.add(fn); return () => sseSubs.delete(fn); },
};
const adapter = () => new RelaySession({ client: {} as any, relaySessionId: SID, metadata: {} });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const base = () => `http://127.0.0.1:${port}`;

beforeAll(async () => {
  vi.spyOn(process.stderr, "write").mockImplementation((c: any) => { stderrLines.push(String(c)); return true; });
  publicDir = mkdtempSync(join(tmpdir(), "joy-http-public-"));
  // 192 × 64 KiB records ≈ 12 MiB of NDJSON history — within the log's 2000-record cap.
  const a = adapter();
  for (let i = 0; i < RECORDS; i++) a.send(encodeTextEvent(RECORD_TEXT, { turn: "t" }), `hist:${i}`);
  await new Promise<void>((resolve) => {
    server = startHttpServer({ registry, port: 0, publicDir, token: TOKEN, onListening: (p) => { port = p; resolve(); }, eventStream: { drainDeadlineMs: 1500 } });
  });
}, 20_000);
afterAll(async () => {
  vi.restoreAllMocks();
  forgetRecords(SID);
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(publicDir, { recursive: true, force: true });
});

test("/docs authenticated by X-Joy-Token renders with the spec embedded, no query-token spec fetch (#596)", async () => {
  const r = await fetch(`${base()}/docs`, { headers: { "X-Joy-Token": TOKEN } });
  expect(r.status).toBe(200);
  const page = await r.text();
  expect(page).toContain("Redoc.init(");
  expect(page).toContain('"openapi"');
  expect(page).not.toContain("openapi.json?token=");
  // The bearer form works the same way; no credential at all is refused.
  const b = await fetch(`${base()}/docs`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  expect(b.status).toBe(200);
  expect((await fetch(`${base()}/docs`)).status).toBe(401);
});

test("a reading client receives the full 12 MiB session history (#597 Wave B)", async () => {
  const r = await fetch(`${base()}/sessions/${SID}/events?last=${RECORDS}`);
  expect(r.status).toBe(200);
  let body = "";
  try { body = await r.text(); } catch (e) { console.log("STDERR:", stderrLines, "ERR:", String(e)); throw e; }
  const lines = body.split("\n").filter(Boolean);
  expect(lines.length).toBe(RECORDS + 1);                       // hello + every record
  expect(JSON.parse(lines[0])).toMatchObject({ hello: true });
  expect(Buffer.byteLength(body)).toBeGreaterThan(12 * 1024 * 1024);
  const last = JSON.parse(lines[lines.length - 1]);
  expect(last.record.content.data.ev.text.length).toBe(RECORD_TEXT.length);
}, 20_000);

test("/events: a reading client receives a 12 MiB opening history (#597 Wave B)", async () => {
  chat.length = 0;
  for (let i = 0; i < RECORDS; i++) chat.push({ id: String(i), role: "assistant", content: RECORD_TEXT, session_id: SID });
  const ctrl = new AbortController();
  const r = await fetch(`${base()}/events`, { signal: ctrl.signal });
  expect(r.status).toBe(200);
  const reader = r.body!.getReader();
  // A FAST reader: collect chunks, look for the marker only in the tail (a
  // quadratic string-append client would itself be the slow reader here).
  const chunks: Uint8Array[] = [];
  const tail = () => Buffer.concat(chunks.slice(-2)).toString("latin1");
  while (!tail().includes("event: sessions_history")) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const got = Buffer.concat(chunks).toString("utf8");
  const m = /^event: history\ndata: (.*)\n\n/m.exec(got);
  expect(m).toBeTruthy();
  expect(JSON.parse(m![1]).length).toBe(RECORDS);
  ctrl.abort();
  chat.length = 0;
}, 20_000);

test("live records published during the history flush arrive after it, in order, none lost (follow=1)", async () => {
  const ctrl = new AbortController();
  const r = await fetch(`${base()}/sessions/${SID}/events?last=${RECORDS}&follow=1`, { signal: ctrl.signal });
  expect(r.status).toBe(200);
  // Headers are in: the history is now being flushed. Publish while it streams.
  const a = adapter();
  for (let i = 0; i < 3; i++) a.send(encodeTextEvent(`live-${i}`, { turn: "t2" }), `live:${i}`);
  const reader = r.body!.getReader();
  const dec = new TextDecoder();
  let buf = ""; const lines: string[] = [];
  while (lines.length < RECORDS + 1 + 3) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const parts = buf.split("\n"); buf = parts.pop()!;
    lines.push(...parts.filter(Boolean));
  }
  ctrl.abort();
  const seqs = lines.slice(1).map((l) => JSON.parse(l).record ? JSON.parse(l).seq : -1);
  for (let i = 1; i < seqs.length; i++) expect(seqs[i]).toBe(seqs[i - 1] + 1); // contiguous, ordered
  const texts = lines.slice(-3).map((l) => JSON.parse(l).record.content.data.ev.text);
  expect(texts).toEqual(["live-0", "live-1", "live-2"]);
}, 20_000);

test("one oversized history item never sits in the response buffer whole: pending bytes stay under the cap (#597 residual)", async () => {
  // A single /events `history` frame IS the whole serialized chat (12 MiB
  // here). Written in one res.write() it exceeded the 8 MiB pending-bytes
  // bound before the first drain check (Astra on 4a69e55c). Drive the helper
  // with a real response and a paused client and watch writableLength.
  const item = `event: history\ndata: ${JSON.stringify(Array.from({ length: RECORDS }, (_, i) => ({ id: String(i), role: "assistant", content: RECORD_TEXT, session_id: SID })))}\n\n`;
  expect(Buffer.byteLength(item)).toBeGreaterThan(12 * 1024 * 1024);
  const cap = 8 * 1024 * 1024;
  let peak = 0; let subs = 0; let unsubscribed = 0; let closed = false;
  const srv = http.createServer((_req, res) => {
    const write = res.write.bind(res);
    (res as any).write = (...args: any[]) => { const ok = (write as any)(...args); peak = Math.max(peak, res.writableLength); return ok; };
    res.on("close", () => { closed = true; });
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    void streamHistoryThenFollow({
      res, history: [item, "event: sessions_history\ndata: []\n\n"], label: "test-sse",
      subscribe: () => { subs++; return () => { unsubscribed++; }; },
      drainDeadlineMs: 300, maxBufferedBytes: cap,
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const p = (srv.address() as any).port as number;
  const sock = net.connect(p, "127.0.0.1");
  await new Promise<void>((r) => sock.once("connect", () => r()));
  sock.pause();
  sock.write(`GET /events HTTP/1.1\r\nHost: 127.0.0.1:${p}\r\n\r\n`);
  await sleep(1_200);
  expect(peak).toBeLessThan(cap);
  expect(peak).toBeLessThan(1024 * 1024);           // high-water mark + one 64 KiB chunk, not the whole frame
  expect(closed).toBe(true);                         // dropped at the drain deadline
  expect(subs).toBe(1); expect(unsubscribed).toBeGreaterThanOrEqual(1); // drop() and the close listener both unsubscribe (idempotent)
  sock.destroy();
  srv.closeAllConnections();
  await new Promise<void>((r) => srv.close(() => r()));
}, 20_000);

test("a client that never reads is dropped at the drain deadline instead of parking the history", async () => {
  const sock = net.connect(port, "127.0.0.1");
  await new Promise<void>((r) => sock.once("connect", () => r()));
  sock.pause(); // never read: the kernel buffers fill, then res.write() stalls
  sock.write(`GET /sessions/${SID}/events?last=${RECORDS}&follow=1 HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`);
  let received = 0;
  sock.on("data", (d) => { received += d.length; });
  const closed = new Promise<boolean>((r) => { sock.once("close", () => r(true)); sock.once("error", () => r(true)); setTimeout(() => r(false), 6_000); });
  // Past the 1.5s drain deadline the server has destroyed its side. A paused
  // socket cannot observe that — resume and it must end promptly, having
  // delivered only what the kernel had buffered, NOT the whole history (a
  // follow=1 stream that was never dropped would stay open here forever).
  await sleep(2_500);
  sock.resume();
  expect(await closed).toBe(true);
  expect(received).toBeLessThan(12 * 1024 * 1024);
}, 20_000);
