// #560 — the forwarded-transcript-uuid set is bounded, and never below the
// committed replay cursor.
//
// One `transcript_uuid` receipt is written per transcript entry the daemon
// forwards. Age-based retention never bounded that: a long-running agent
// emitting a distinct entry a second writes ~86k a day and each one is inside
// the 7-day window. The set has a per-session cap, applied as receipts are
// written and again by the daily sweep — but a receipt goes ONLY when the
// session's COMMITTED transcript cursor covers it POSITIONALLY: the receipt
// recorded where its entry starts (transcript path + byte offset) and that
// start lies below the committed offset in the same file, so a replay from
// the cursor never reaches the entry. Wall time proves nothing (review
// 0133a2fb); neither does insertion order (review 939c279a: a receipt from a
// previous run can name an entry beyond the offset a partial recovery
// commits). A newer cursor still pending behind unacked output is not the
// replay origin and protects nothing; a receipt with no recorded position is
// retained until a later observation places it; a session with no committed
// cursor keeps everything — a replayed entry has no stable occurrence id the
// relay could dedupe, so a dropped receipt is a re-emitted answer.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Ledger, DEFAULT_PRUNE_POLICY } from "./ledger";

let dir: string;
let now = 1_700_000_000_000;
let ledger: Ledger;
const FILE = "/t.jsonl";
const policy = (keep: number) => ({ ...DEFAULT_PRUNE_POLICY, transcriptReceiptsPerSession: keep });
const count = (sessionId: string) => ledger.listReceipts(sessionId, "transcript_uuid").length;
const has = (sessionId: string, ref: string) => ledger.hasReceipt(sessionId, "transcript_uuid", ref);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "joy-ledger-receipts-"));
  now = 1_700_000_000_000;
  ledger = Ledger.open(dir, { now: () => now });
});
afterEach(() => { vi.restoreAllMocks(); ledger.close(); rmSync(dir, { recursive: true, force: true }); });

/** n forwarded transcript entries `u<from>..`, one per simulated second, each
 *  observed in FILE one byte apart: entry `u<i>` starts at byte `i` unless an
 *  `offsetBase` says otherwise. Written in one transaction (the per-row
 *  position is what matters, not the commit shape). */
function forward(sessionId: string, n: number, from = 0, at?: () => number, offsetBase = from, path = FILE): void {
  const rows = [];
  for (let i = from; i < from + n; i++) rows.push({ kind: "transcript_uuid", ref: `u${i}`, at: at ? at() : (now += 1_000), transcriptPath: path, byteOffset: offsetBase + (i - from) });
  ledger.addReceipts(sessionId, rows);
}
/** Receipts whose entry position was never observed (a previous run before
 *  the position columns existed, the legacy import, an ack the tailer never
 *  saw the entry for). */
function forwardUnplaced(sessionId: string, n: number, from = 0): void {
  const rows = [];
  for (let i = from; i < from + n; i++) rows.push({ kind: "transcript_uuid", ref: `u${i}`, at: (now += 1_000) });
  ledger.addReceipts(sessionId, rows);
}
/** Commit the session's transcript cursor here: recovery replays FILE from this byte forward. */
function commitCursor(sessionId: string, offset: number, path = FILE): void {
  now += 1_000;
  expect(ledger.setCheckpoint(sessionId, "claude_transcript", path, offset).committed).toBe(true);
}

describe("transcript-uuid receipts are bounded (#560)", () => {
  it("caps a long-running session's set at the retained count below its committed cursor", () => {
    forward("s1", 20_000);
    commitCursor("s1", 20_000);
    expect(count("s1")).toBe(20_000); // every one is inside the 7-day window
    const r = ledger.prune(policy(2_000));
    expect(r.receipts).toBe(18_000);
    expect(count("s1")).toBe(2_000);
    // The NEWEST survive — those are the ones a replay can still reach.
    expect(has("s1", "u19999")).toBe(true);
    expect(has("s1", "u18000")).toBe(true);
    expect(has("s1", "u17999")).toBe(false);
  });

  it("stays bounded as the session keeps running and committing", () => {
    for (let round = 0; round < 5; round++) {
      forward("s1", 5_000, round * 5_000);
      commitCursor("s1", (round + 1) * 5_000);
      ledger.prune(policy(1_000));
      expect(count("s1")).toBe(1_000);
    }
  });

  it("keeps everything at or after a COMMITTED transcript cursor, cap or not", () => {
    forward("s1", 3_000);
    commitCursor("s1", 3_000);
    forward("s1", 3_000, 3_000);
    ledger.prune(policy(100));
    // The 3,000 beyond the cursor are all retained even though the cap is
    // 100; the ones below it are gone.
    expect(count("s1")).toBe(3_000);
    expect(has("s1", "u3000")).toBe(true);
    expect(has("s1", "u2999")).toBe(false);
  });

  it("a session with no committed cursor keeps every receipt: the cap never reaches a replay from nothing", () => {
    forward("s1", 500);
    ledger.prune(policy(100));
    expect(count("s1")).toBe(500);
    // A cursor written but still held pending behind unacked output is not a
    // committed one either.
    ledger.enqueueOutbound([{ sessionId: "s1", kind: "output", runtimeEventId: "e1", sealed: false, body: {} }]);
    expect(ledger.setCheckpoint("s1", "claude_transcript", FILE, 10, { throughSeq: "latest" }).committed).toBe(false);
    ledger.prune(policy(100));
    expect(count("s1")).toBe(500);
  });

  it("a NEWER cursor pending behind unacked output never lets the cap reach past the committed one (review 0133a2fb)", () => {
    // The reviewer's shape: an answer forwarded after the committed cursor,
    // thousands of newer receipts, a newer cursor written but not committed.
    commitCursor("s1", 100);
    ledger.addReceipt("s1", { kind: "transcript_uuid", ref: "already-forwarded", at: (now += 1_000), transcriptPath: FILE, byteOffset: 100 });
    forward("s1", 5_001, 0, undefined, 101);
    ledger.enqueueOutbound([{ sessionId: "s1", kind: "output", runtimeEventId: "held", sealed: false, body: {} }]);
    now += 1_000;
    expect(ledger.setCheckpoint("s1", "claude_transcript", FILE, 999, { throughSeq: "latest" }).committed).toBe(false);
    ledger.prune(DEFAULT_PRUNE_POLICY);
    expect(ledger.getCheckpoint("s1", "claude_transcript")?.offset).toBe(100); // still the replay origin
    // A replay from offset 100 re-reads the answer: its receipt must be there.
    expect(has("s1", "already-forwarded")).toBe(true);
    expect(count("s1")).toBe(5_002);
    // Once the output is acked the newer cursor commits and covers the two
    // oldest (bytes 100 and 101 lie below 999).
    ledger.ackOutbound(ledger.lastOutboundSeq("s1"));
    expect(ledger.getCheckpoint("s1", "claude_transcript")?.offset).toBe(999);
    ledger.prune(DEFAULT_PRUNE_POLICY);
    expect(count("s1")).toBe(5_000);
    expect(has("s1", "already-forwarded")).toBe(false);
  });

  it("a promoted cursor covers by position: entries beyond its offset survive though written before the promotion", () => {
    commitCursor("s1", 100);
    forward("s1", 2, 0, undefined, 100);                     // u0 u1 at bytes 100, 101
    ledger.enqueueOutbound([{ sessionId: "s1", kind: "output", runtimeEventId: "held", sealed: false, body: {} }]);
    now += 1_000;
    expect(ledger.setCheckpoint("s1", "claude_transcript", FILE, 999, { throughSeq: "latest" }).committed).toBe(false);
    forward("s1", 2, 2, undefined, 999);                     // u2 u3 at bytes 999, 1000 — beyond offset 999
    ledger.ackOutbound(ledger.lastOutboundSeq("s1"));        // promotes
    expect(ledger.getCheckpoint("s1", "claude_transcript")?.offset).toBe(999);
    ledger.prune(policy(1));
    expect(has("s1", "u0")).toBe(false);
    expect(has("s1", "u1")).toBe(false);
    expect(has("s1", "u2")).toBe(true);
    expect(has("s1", "u3")).toBe(true);
  });

  it("insertion order proves nothing: an older receipt for an entry beyond the committed offset survives a partial recovery's cursor (review 939c279a)", () => {
    // Previous run: the answer at byte 79 was forwarded (receipt ord 1),
    // then thousands of newer receipts. Recovery re-reads from 0, a short
    // read + transient EIO stops it at byte 79, and the 5-second checkpoint
    // commits offset 79 — the ordinal current at that moment is far past the
    // answer's, yet the answer is still beyond the committed cursor.
    ledger.addReceipt("s1", { kind: "transcript_uuid", ref: "answer", transcriptPath: FILE, byteOffset: 79 });
    forward("s1", 5_001, 0, undefined, 80);
    commitCursor("s1", 79);
    expect(ledger.getCheckpoint("s1", "claude_transcript")?.receiptOrd).toBeGreaterThanOrEqual(5_002);
    ledger.prune(DEFAULT_PRUNE_POLICY);
    expect(has("s1", "answer")).toBe(true);                  // 79 < 79 is false: not covered
    expect(count("s1")).toBe(5_002);
    // Once the recovery reaches the end and commits past everything, the two
    // oldest (the answer and u0) go.
    commitCursor("s1", 5_081);
    ledger.prune(DEFAULT_PRUNE_POLICY);
    expect(has("s1", "answer")).toBe(false);
    expect(count("s1")).toBe(5_000);
  });

  it("a receipt observed in ANOTHER transcript file is not covered by this file's cursor", () => {
    forward("s1", 10, 0, undefined, 0, "/other.jsonl");      // u0..u9 in a different file, bytes 0..9
    forward("s1", 10, 10, undefined, 0, FILE);               // u10..u19 in FILE, bytes 0..9
    commitCursor("s1", 4096, FILE);
    ledger.prune(policy(1));
    expect(count("s1")).toBe(11);                            // FILE's ten but the newest went; the other file's stay
    expect(has("s1", "u0")).toBe(true);
    expect(has("s1", "u10")).toBe(false);
    expect(has("s1", "u19")).toBe(true);                     // the newest is kept regardless
  });

  it("a receipt with no recorded position is never pruned by ordinal alone; a later observation places it", () => {
    forwardUnplaced("s1", 50);                               // u0..u49, position unknown
    commitCursor("s1", 4096);
    ledger.prune(policy(1));
    expect(count("s1")).toBe(50);                            // covered by ordinal? irrelevant — never by that
    // The replay re-observes u0..u9 in FILE below the cursor: re-writing the
    // receipt with a position places it, and only THEN is it coverable.
    for (let i = 0; i < 10; i++) ledger.addReceipt("s1", { kind: "transcript_uuid", ref: `u${i}`, transcriptPath: FILE, byteOffset: i });
    expect(ledger.getReceipt("s1", "transcript_uuid", "u0")).toMatchObject({ transcriptPath: FILE, byteOffset: 0 });
    expect(ledger.getReceipt("s1", "transcript_uuid", "u10")).toMatchObject({ transcriptPath: null, byteOffset: null });
    ledger.prune(policy(1));
    expect(count("s1")).toBe(40);
    expect(has("s1", "u0")).toBe(false);
    expect(has("s1", "u10")).toBe(true);
    // Re-observed BEYOND the cursor: the position moves and the receipt stays.
    ledger.addReceipt("s1", { kind: "transcript_uuid", ref: "u10", transcriptPath: FILE, byteOffset: 5_000 });
    ledger.prune(policy(1));
    expect(has("s1", "u10")).toBe(true);
    // A write without a position never erases a known one.
    ledger.addReceipt("s1", { kind: "transcript_uuid", ref: "u10" });
    expect(ledger.getReceipt("s1", "transcript_uuid", "u10")).toMatchObject({ transcriptPath: FILE, byteOffset: 5_000 });
  });

  it("over the cap with nothing positionally covered: keeps all and warns once", () => {
    const warn = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    ledger.close();
    ledger = Ledger.open(dir, { now: () => now, transcriptReceiptsPerSession: 10 });
    commitCursor("s1", 4096);
    forwardUnplaced("s1", 30);                               // all unplaced: coverable by nothing
    expect(count("s1")).toBe(30);
    forward("s1", 5, 30, undefined, 5_000);                  // beyond the cursor: not covered either
    expect(count("s1")).toBe(35);
    ledger.prune(policy(10));
    expect(count("s1")).toBe(35);
    const warned = warn.mock.calls.map((c) => String(c[0])).filter((s) => s.includes("none of the excess positionally covered"));
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain("s1");
    // Placing ten of them below the cursor makes exactly those prunable.
    for (let i = 0; i < 10; i++) ledger.addReceipt("s1", { kind: "transcript_uuid", ref: `u${i}`, transcriptPath: FILE, byteOffset: i });
    ledger.prune(policy(10));
    expect(count("s1")).toBe(25);
  });

  it("the cap is enforced as receipts are written, under the same rule", () => {
    ledger.close();
    ledger = Ledger.open(dir, { now: () => now, transcriptReceiptsPerSession: 10 });
    forward("s1", 50);                                       // u0..u49 at bytes 0..49
    expect(count("s1")).toBe(50);                            // no cursor: nothing prunable, cap or not
    commitCursor("s1", 50);                                  // covers bytes 0..49
    ledger.addReceipt("s1", { kind: "transcript_uuid", ref: "u50", at: (now += 1_000), transcriptPath: FILE, byteOffset: 50 });
    expect(count("s1")).toBe(10);                            // over the cap → pruned at the write
    expect(has("s1", "u50")).toBe(true);
    expect(has("s1", "u41")).toBe(true);
    expect(has("s1", "u40")).toBe(false);
    forward("s1", 20, 51);                                   // bytes 51..70: beyond the cursor
    // 30 written; the 9 the cursor still covered (u41..u49) went one per
    // insert as they fell out of the newest-10 window, and the 21 beyond
    // the cursor (u50..u70) stay even though they exceed the cap.
    expect(count("s1")).toBe(21);
    expect(has("s1", "u50")).toBe(true);
    expect(has("s1", "u49")).toBe(false);
  });

  it("age retires a transcript receipt only when the committed cursor covers it; other kinds keep the 7-day rule", () => {
    const old = () => now - 30 * 24 * 3_600_000;
    forward("s1", 5, 0, old);                                // u0..u4 at bytes 0..4, long past the cut, below the cursor
    commitCursor("s1", 5);
    forward("s1", 5, 5, old);                                // u5..u9 at bytes 5..9, long past the cut, BEYOND the cursor
    ledger.addReceipt("s1", { kind: "seq", ref: "1", at: old() });
    ledger.prune(policy(1_000));                             // the cap is not the reason anything goes
    expect(has("s1", "u4")).toBe(false);
    expect(has("s1", "u5")).toBe(true);
    expect(count("s1")).toBe(5);
    expect(ledger.hasReceipt("s1", "seq", "1")).toBe(false);
  });

  it("does not touch other sessions' or other kinds' receipts", () => {
    forward("s1", 500);
    commitCursor("s1", 4096);
    forward("s2", 10, 0);
    commitCursor("s2", 4096);
    ledger.addReceipts("s1", Array.from({ length: 300 }, (_, i) => ({ kind: "seq", ref: String(i) })));
    ledger.prune(policy(100));
    expect(count("s1")).toBe(100);
    expect(count("s2")).toBe(10);
    expect(ledger.listReceipts("s1", "seq").length).toBe(300); // the seq dedupe set is untouched
  });

  it("a cursor installed with coversReceipts:false (the legacy import) covers nothing: imported receipts carry no position", () => {
    forwardUnplaced("s1", 50);
    expect(ledger.setCheckpoint("s1", "claude_transcript", FILE, 4096, { coversReceipts: false }).committed).toBe(true);
    expect(ledger.getCheckpoint("s1", "claude_transcript")?.receiptOrd).toBeNull();
    ledger.prune(policy(1));
    expect(count("s1")).toBe(50);
    // A real commit changes nothing on its own; the replay's re-observation
    // of each entry (position now known) is what lets the cursor cover it.
    commitCursor("s1", 8192);
    ledger.prune(policy(1));
    expect(count("s1")).toBe(50);
    forward("s1", 49);                                       // u0..u48 re-observed at bytes 0..48
    ledger.prune(policy(1));
    expect(count("s1")).toBe(1);
    expect(has("s1", "u49")).toBe(true);
  });

  it("forgetting a session takes its receipts with it", () => {
    forward("s1", 50);
    ledger.addReceipt("s1", { kind: "seq", ref: "1" });
    ledger.forgetSession("s1");
    expect(ledger.listReceipts("s1").length).toBe(0);
  });

  it("opens a ledger from before the ordinal and position columns: receipts backfilled in order, none prunable until re-observed", () => {
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
    dir = mkdtempSync(join(tmpdir(), "joy-ledger-receipts-old-"));
    const db = new DatabaseSync(join(dir, "ledger.sqlite"));
    db.exec(`
      CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO schema_meta(key,value) VALUES('version','1');
      CREATE TABLE receipts (
        session_id TEXT NOT NULL, kind TEXT NOT NULL, ref TEXT NOT NULL,
        command_id TEXT, attempt_id TEXT, at INTEGER NOT NULL,
        PRIMARY KEY (session_id, kind, ref));
      CREATE TABLE checkpoints (
        session_id TEXT NOT NULL, kind TEXT NOT NULL, ref TEXT NOT NULL, offset INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL, pending_ref TEXT, pending_offset INTEGER, pending_through_seq INTEGER,
        PRIMARY KEY (session_id, kind));
      INSERT INTO checkpoints VALUES('s1','claude_transcript','${FILE}',100,1,NULL,NULL,NULL);`);
    for (let i = 0; i < 30; i++) db.prepare("INSERT INTO receipts VALUES('s1','transcript_uuid',?,NULL,NULL,?)").run(`u${i}`, i);
    db.close();
    ledger = Ledger.open(dir, { now: () => now });
    expect(ledger.listReceipts("s1", "transcript_uuid").map((r) => r.ord)).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
    expect(ledger.listReceipts("s1", "transcript_uuid").every((r) => r.transcriptPath === null && r.byteOffset === null)).toBe(true);
    expect(ledger.getCheckpoint("s1", "claude_transcript")).toMatchObject({ offset: 100, receiptOrd: null });
    ledger.prune(policy(1));
    expect(count("s1")).toBe(30);                            // unknown positions: nothing is proven covered
    ledger.addReceipt("s1", { kind: "transcript_uuid", ref: "u30", transcriptPath: FILE, byteOffset: 4_000 });
    expect(ledger.getReceipt("s1", "transcript_uuid", "u30")?.ord).toBe(31); // the counter continues past the backfill
    commitCursor("s1", 4096);
    ledger.prune(policy(1));
    expect(count("s1")).toBe(31);                            // the old rows still have no position; u30 is the newest
    forward("s1", 30);                                       // the replay re-observes u0..u29 at bytes 0..29
    ledger.prune(policy(1));
    expect(count("s1")).toBe(1);
    expect(has("s1", "u30")).toBe(true);
  });
});
