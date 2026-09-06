// #560 — the forwarded-transcript-uuid set is bounded.
//
// One `transcript_uuid` receipt is written per transcript entry the daemon
// forwards. Age-based retention never bounded that: a long-running agent
// emitting a distinct entry a second writes ~86k a day and each one is inside
// the 7-day window. The set now has a per-session cap, and what recovery
// still needs — everything at or after the session's COMMITTED transcript
// cursor — is kept regardless of the cap.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger, DEFAULT_PRUNE_POLICY } from "./ledger";

let dir: string;
let now = 1_700_000_000_000;
let ledger: Ledger;
const policy = (keep: number) => ({ ...DEFAULT_PRUNE_POLICY, transcriptReceiptsPerSession: keep });
const count = (sessionId: string) => ledger.listReceipts(sessionId, "transcript_uuid").length;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "joy-ledger-receipts-"));
  now = 1_700_000_000_000;
  ledger = Ledger.open(dir, { now: () => now });
});
afterEach(() => { ledger.close(); rmSync(dir, { recursive: true, force: true }); });

/** n forwarded transcript entries, one per simulated second. Written in one
 *  transaction (the per-row `at` is what matters here, not the commit shape). */
function forward(sessionId: string, n: number, from = 0): void {
  const rows = [];
  for (let i = from; i < from + n; i++) rows.push({ kind: "transcript_uuid", ref: `u${i}`, at: (now += 1_000) });
  ledger.addReceipts(sessionId, rows);
}

describe("transcript-uuid receipts are bounded (#560)", () => {
  it("caps a long-running session's set at the retained count", () => {
    forward("s1", 20_000);
    expect(count("s1")).toBe(20_000); // every one is inside the 7-day window
    const r = ledger.prune(policy(2_000));
    expect(r.receipts).toBe(18_000);
    expect(count("s1")).toBe(2_000);
    // The NEWEST survive — those are the ones a replay can still reach.
    expect(ledger.hasReceipt("s1", "transcript_uuid", "u19999")).toBe(true);
    expect(ledger.hasReceipt("s1", "transcript_uuid", "u18000")).toBe(true);
    expect(ledger.hasReceipt("s1", "transcript_uuid", "u17999")).toBe(false);
  });

  it("stays bounded as the session keeps running", () => {
    for (let round = 0; round < 5; round++) {
      forward("s1", 5_000, round * 5_000);
      ledger.prune(policy(1_000));
      expect(count("s1")).toBeLessThanOrEqual(1_000);
    }
  });

  it("keeps everything at or after a COMMITTED transcript cursor, cap or not", () => {
    forward("s1", 3_000);
    // Cursor committed here: recovery replays from this point forward.
    now += 1_000;
    ledger.setCheckpoint("s1", "claude_transcript", "/t.jsonl", 4096);
    forward("s1", 3_000, 3_000);
    ledger.prune(policy(100));
    // The 3,000 written after the cursor are all retained even though the cap
    // is 100; the ones before it are gone.
    expect(count("s1")).toBe(3_000);
    expect(ledger.hasReceipt("s1", "transcript_uuid", "u3000")).toBe(true);
    expect(ledger.hasReceipt("s1", "transcript_uuid", "u2999")).toBe(false);
  });

  it("a cursor still held pending behind unacked output protects nothing beyond the cap", () => {
    // A pending checkpoint's timestamp is the WRITE attempt, not a committed
    // cursor, so it must not be read as one; the count cap is the bound.
    ledger.enqueueOutbound([{ sessionId: "s1", kind: "output", runtimeEventId: "e1", sealed: false, body: {} }]);
    forward("s1", 500);
    expect(ledger.setCheckpoint("s1", "claude_transcript", "/t.jsonl", 10, { throughSeq: "latest" }).committed).toBe(false);
    ledger.prune(policy(100));
    expect(count("s1")).toBe(100);
  });

  it("does not touch other sessions' or other kinds' receipts", () => {
    forward("s1", 500);
    forward("s2", 10, 0);
    ledger.addReceipts("s1", Array.from({ length: 300 }, (_, i) => ({ kind: "seq", ref: String(i) })));
    ledger.prune(policy(100));
    expect(count("s1")).toBe(100);
    expect(count("s2")).toBe(10);
    expect(ledger.listReceipts("s1", "seq").length).toBe(300); // the seq dedupe set is untouched
  });

  it("forgetting a session takes its receipts with it", () => {
    forward("s1", 50);
    ledger.addReceipt("s1", { kind: "seq", ref: "1" });
    ledger.forgetSession("s1");
    expect(ledger.listReceipts("s1").length).toBe(0);
  });
});
