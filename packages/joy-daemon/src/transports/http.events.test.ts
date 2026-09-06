// The daemon's local HTTP surface, driven by real clients:
//  - #596: /docs authenticated by header/bearer must render — the spec is
//    embedded in the page instead of fetched with a (missing) query token;
//  - #597 Wave B: the opening history of /sessions/:id/events and /events is
//    streamed with backpressure. A READING client receives a legitimate
//    12 MiB history (192 × 64 KiB records) in full; a NON-READING client is
//    dropped at the drain deadline; live records published during the flush
//    are delivered after it, in order, none lost.
//  - #597 Wave C: the history is PAGED from its store in bounded batches and
//    framed one record at a time — the serialized history never exists as
//    one string, the next batch is read only after the previous one drained,
//    and the bytes on the wire equal the whole-array frame exactly.
import { test, expect, beforeAll, afterAll, vi } from "vitest";
import * as net from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
process.env.JOY_HOME_DIR = mkdtempSync(join(tmpdir(), "joy-http-test-"));
import { startHttpServer, streamHistoryThenFollow, sseJsonArrayEvent, sseJsonArrayFraming, arrayHistory } from "./http";
import * as http from "node:http";
import { EventEmitter } from "node:events";
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
  while (!tail().includes("event: sessions_history\ndata: []\n\n")) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const got = Buffer.concat(chunks);
  // Byte-identical to the whole-array frame the pre-Wave-C implementation
  // wrote: the paged, per-record framing changes nothing on the wire.
  const expected = Buffer.from(`event: history\ndata: ${JSON.stringify(chat)}\n\nevent: sessions_history\ndata: []\n\n`);
  expect(got.length).toBe(expected.length);
  expect(got.equals(expected)).toBe(true);
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

test("a 12 MiB history to a paused client: pending bytes stay under the cap, no write retains more than one chunk, no frame string exceeds one record, and the store is paged only between drains (#597 residual)", async () => {
  // The /events `history` frame IS the whole serialized chat (12 MiB here).
  // Written in one res.write() it exceeded the 8 MiB pending-bytes bound
  // before the first drain check (Astra on 4a69e55c); cut into owned 64 KiB
  // chunks it was still built — and retained — as one string until the
  // response closed (Astra on 6c737d7b). Drive the helper with a real
  // response and a paused client: watch writableLength, what each write
  // retains, the largest string ever framed, and when the store is read.
  const rows = Array.from({ length: RECORDS }, (_, i) => ({ id: String(i), role: "assistant", content: RECORD_TEXT, session_id: SID }));
  const cap = 8 * 1024 * 1024;
  let peak = 0; let subs = 0; let unsubscribed = 0; let closed = false;
  let peakWrite = 0; let peakBacking = 0; let peakFrame = 0;
  const reads: Array<{ cursor: number; limit: number; needDrain: boolean; pending: number }> = [];
  const srv = http.createServer((_req, res) => {
    const write = res.write.bind(res);
    (res as any).write = (...args: any[]) => {
      const buf = args[0] as Buffer;
      peakWrite = Math.max(peakWrite, buf.length);
      // The residual (Astra on b2aa492d): each 64 KiB slice used to be a view
      // over the whole 12 MiB frame's ArrayBuffer, retained per pending write.
      peakBacking = Math.max(peakBacking, buf.buffer.byteLength);
      const ok = (write as any)(...args); peak = Math.max(peak, res.writableLength); return ok;
    };
    res.on("close", () => { closed = true; });
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const framing = sseJsonArrayFraming("history");
    const paged = arrayHistory(rows);
    void streamHistoryThenFollow({
      res, label: "test-sse",
      history: {
        ...framing, ...paged,
        read: (cursor, limit) => {
          reads.push({ cursor, limit, needDrain: res.writableNeedDrain, pending: res.writableLength });
          return paged.read(cursor, limit);
        },
        frame: (row, index) => { const s = framing.frame(row, index); peakFrame = Math.max(peakFrame, s.length); return s; },
        close: framing.close + "event: sessions_history\ndata: []\n\n",
      },
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
  expect(peakWrite).toBeLessThanOrEqual(64 * 1024);
  expect(peakBacking).toBeLessThanOrEqual(64 * 1024); // a chunk owns its allocation: no whole-frame buffer behind it
  expect(peakFrame).toBeLessThan(RECORD_TEXT.length + 256); // the largest string ever built is ONE framed record
  // The store was paged — never asked for everything — and every read
  // happened with the previous batch already taken by the socket: at no
  // read was a drain pending. The stalled client got no batch read on its
  // behalf once its socket stopped taking bytes.
  expect(reads.length).toBeGreaterThan(1);
  expect(reads.length).toBeLessThan(RECORDS);
  expect(reads[0]).toMatchObject({ cursor: 0, needDrain: false });
  for (const r of reads) { expect(r.needDrain).toBe(false); expect(r.limit).toBeLessThanOrEqual(256); }
  for (let i = 1; i < reads.length; i++) expect(reads[i].cursor).toBeGreaterThan(reads[i - 1].cursor); // continues from the last record written
  expect(closed).toBe(true);                         // dropped at the drain deadline
  expect(subs).toBe(1); expect(unsubscribed).toBeGreaterThanOrEqual(1); // drop() and the close listener both unsubscribe (idempotent)
  sock.destroy();
  srv.closeAllConnections();
  await new Promise<void>((r) => srv.close(() => r()));
}, 20_000);

test("the next history batch is read only after the previous one drained; a byte cap closes a batch early; the bytes equal the whole-array frame (#597 residual, Wave C)", async () => {
  // A scripted response — writes are taken until a high-water mark, then
  // refused until the test drains — pins the pacing exactly: while a drain
  // is pending the store is not read; once 'drain' fires, one more batch.
  class ScriptedRes extends EventEmitter {
    destroyed = false; ended = false; writableNeedDrain = false;
    pending = 0; readonly out: Buffer[] = [];
    constructor(readonly hwm: number) { super(); }
    get writableLength() { return this.pending; }
    write(buf: Buffer): boolean {
      this.out.push(Buffer.from(buf)); this.pending += buf.length;
      if (this.pending >= this.hwm) { this.writableNeedDrain = true; return false; }
      return true;
    }
    drain(): void { this.pending = 0; this.writableNeedDrain = false; this.emit("drain"); }
    end(): void { this.ended = true; }
    destroy(): void { this.destroyed = true; this.emit("close"); }
  }
  const settle = () => new Promise<void>((r) => setTimeout(r, 20));
  const rows = Array.from({ length: RECORDS }, (_, i) => ({ id: String(i), role: "assistant", content: RECORD_TEXT, session_id: SID }));
  const expected = Buffer.from(`event: history\ndata: ${JSON.stringify(rows)}\n\nevent: sessions_history\ndata: []\n\n`);
  expect(expected.length).toBeGreaterThan(12 * 1024 * 1024);
  const run = async (batch: { historyBatchRecords?: number; historyBatchBytes?: number }) => {
    const res = new ScriptedRes(256 * 1024);
    const reads: Array<{ cursor: number; needDrain: boolean; pendingAtRead: number }> = [];
    const framing = sseJsonArrayFraming("history");
    const paged = arrayHistory(rows);
    const done = streamHistoryThenFollow({
      res: res as any, label: "scripted", subscribe: null, drainDeadlineMs: 5_000, ...batch,
      history: {
        ...framing, ...paged,
        read: (cursor, limit) => { reads.push({ cursor, needDrain: res.writableNeedDrain, pendingAtRead: res.pending }); return paged.read(cursor, limit); },
        close: framing.close + "event: sessions_history\ndata: []\n\n",
      },
    });
    let stalls = 0;
    while (!res.ended) {
      await settle();
      if (!res.writableNeedDrain) continue;
      // Stalled: nothing more may be read from the store until we drain.
      const before = reads.length;
      await settle(); await settle();
      expect(reads.length).toBe(before);
      stalls++;
      res.drain();
    }
    await done;
    expect(stalls).toBeGreaterThan(10);                       // 12 MiB through a 256 KiB high-water mark
    for (const r of reads) expect(r.needDrain).toBe(false);   // every read: the previous batch already taken
    for (let i = 1; i < reads.length; i++) expect(reads[i].cursor).toBeGreaterThan(reads[i - 1].cursor);
    const got = Buffer.concat(res.out);
    expect(got.length).toBe(expected.length);
    expect(got.equals(expected)).toBe(true);                  // byte-identical to the pre-Wave-C whole-array frame
    expect(Math.max(...res.out.map((b) => b.length))).toBeLessThanOrEqual(64 * 1024);
    return reads;
  };
  // 16 records per batch, no byte cap: 12 full batches, then the empty read
  // that says "exhausted" — the cursor is the position after the last record.
  const byCount = await run({ historyBatchRecords: 16, historyBatchBytes: 1 << 30 });
  expect(byCount.map((r) => r.cursor)).toEqual(Array.from({ length: RECORDS / 16 + 1 }, (_, i) => i * 16));
  // 256 per batch under a 1 MiB byte cap: each 64 KiB record pushes a batch
  // past the cap after 16, so the batch closes early and the next read
  // continues from the last record written, not from the end of the page.
  const byBytes = await run({ historyBatchRecords: 256, historyBatchBytes: 1024 * 1024 });
  expect(byBytes.map((r) => r.cursor)).toEqual(Array.from({ length: RECORDS / 16 + 1 }, (_, i) => i * 16));
}, 30_000);

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

test("history chunks never split a multi-byte character or a surrogate pair; the frame arrives byte-identical (#597 residual)", async () => {
  // Chunks of 5 bytes against 2-, 3- and 4-byte sequences: every boundary
  // falls inside some character unless the encoder stops at whole ones.
  const text = "aé€🙂é🙂€aa€🙂🙂éé€a".repeat(200);
  const rows = Array.from({ length: 50 }, (_, i) => ({ id: String(i), role: "assistant", content: text, session_id: SID }));
  const expected = `event: history\ndata: ${JSON.stringify(rows)}\n\n` + "hello 🙂\n";
  // Tiny batches (7 records, ~10 KiB) so batch boundaries — partial-chunk
  // flushes — fall inside characters too.
  const framing = sseJsonArrayFraming("history");
  const writes: number[] = [];
  const srv = http.createServer((_req, res) => {
    const write = res.write.bind(res);
    (res as any).write = (...args: any[]) => { writes.push((args[0] as Buffer).length); return (write as any)(...args); };
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    void streamHistoryThenFollow({
      res, label: "test-utf8", subscribe: null, historyChunkBytes: 5, historyBatchRecords: 7, historyBatchBytes: 10 * 1024,
      history: { ...framing, ...arrayHistory(rows), close: framing.close + "hello 🙂\n" },
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const p = (srv.address() as any).port as number;
  const r = await fetch(`http://127.0.0.1:${p}/events`);
  const got = Buffer.from(await r.arrayBuffer());
  expect(got.toString("utf8")).toBe(expected);
  expect(got.length).toBe(Buffer.byteLength(expected));
  expect(Math.max(...writes)).toBeLessThanOrEqual(5);
  expect(writes.length).toBeGreaterThan(got.length / 5 - 1);   // chunked, not one write per item
  await new Promise<void>((r) => srv.close(() => r()));
}, 20_000);

test("sseJsonArrayEvent frames exactly like JSON.stringify of the whole array, without building it", () => {
  const rows = [{ a: 1 }, { b: "x\ny" }, { c: [1, 2] }];
  expect([...sseJsonArrayEvent("history", rows)].join("")).toBe(`event: history\ndata: ${JSON.stringify(rows)}\n\n`);
  expect([...sseJsonArrayEvent("history", [])].join("")).toBe("event: history\ndata: []\n\n");
  // Elements JSON cannot represent become null, as in the array form.
  expect([...sseJsonArrayEvent("x", [undefined, 1])].join("")).toBe(`event: x\ndata: ${JSON.stringify([undefined, 1])}\n\n`);
});
