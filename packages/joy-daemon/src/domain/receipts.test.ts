import { test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  initDeliveryState,
  loadReceipts,
  saveReceipts,
  matchPendingForUserEntry,
  recordInboundReceipt,
  recordOutboundReceipt,
  recordReceived,
  consumeReceived,
  receiptPath,
  configureReceiptSaves,
  flushReceipts,
  type DeliveryState,
  type ReceiptLog,
} from "./receipts";
import { vi } from "vitest";

let dir: string;
const RID = "cmpv8r9pg9ikpyc0uk2sw917r";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "receipts-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ── Received-text resilience backstop ────────────────────────────────────────

test("consumeReceived matches a recorded text once, then misses", () => {
  const state = initDeliveryState(RID, dir);
  recordReceived(state, RID, "hello world", 1000, dir);
  expect(consumeReceived(state, RID, "hello world", 1500, dir)).toBe(true);
  // consumed — a second echo of the same text is not suppressed
  expect(consumeReceived(state, RID, "hello world", 1500, dir)).toBe(false);
  expect(consumeReceived(state, RID, "never sent", 1500, dir)).toBe(false);
});

test("received backstop survives a reload (restart) — the duplicate fix", () => {
  const a = initDeliveryState(RID, dir);
  recordReceived(a, RID, "can you read that file", 1000, dir);
  // Simulate a daemon restart: fresh state loaded from disk, pending empty.
  const b = initDeliveryState(RID, dir);
  expect(b.pending.length).toBe(0);
  expect(consumeReceived(b, RID, "can you read that file", 1200, dir)).toBe(true);
});

test("consumeReceived ignores entries older than the window", () => {
  const state = initDeliveryState(RID, dir);
  recordReceived(state, RID, "stale", 0, dir);
  // 16 minutes later — outside the 15-minute window.
  expect(consumeReceived(state, RID, "stale", 16 * 60 * 1000, dir)).toBe(false);
});

// ── Persistence ──────────────────────────────────────────────────────────────

test("loadReceipts returns empty log when no file exists", () => {
  const log = loadReceipts(RID, dir);
  expect(log).toEqual({ inbound: [], outbound: [], received: [] });
});

test("loadReceipts tolerates corrupt JSON and returns empty", () => {
  // Pre-write a bad file at the expected path
  receiptPath(RID, dir); // ensures dir exists
  writeFileSync(join(dir, `${RID}.receipts.json`), "{not json");
  const log = loadReceipts(RID, dir);
  expect(log).toEqual({ inbound: [], outbound: [], received: [] });
});

test("loadReceipts tolerates partial structure", () => {
  writeFileSync(join(dir, `${RID}.receipts.json`), JSON.stringify({ inbound: "nope" }));
  const log = loadReceipts(RID, dir);
  expect(log).toEqual({ inbound: [], outbound: [], received: [] });
});

test("saveReceipts writes atomically via temp + rename", () => {
  const log: ReceiptLog = {
    inbound: [{ seq: 5, uuid: "u-1", text: "hi", source: "relay", at: 1 }],
    outbound: [{ uuid: "u-2", turn: "t-1", at: 2 }],
    received: [],
  };
  saveReceipts(RID, log, dir);

  const p = join(dir, `${RID}.receipts.json`);
  expect(existsSync(p)).toBe(true);
  // Tmp file should be gone after rename
  expect(existsSync(p + ".tmp")).toBe(false);
  expect(JSON.parse(readFileSync(p, "utf-8"))).toEqual(log);
});

test("loadReceipts round-trips saveReceipts", () => {
  const log: ReceiptLog = {
    inbound: [
      { seq: 1, uuid: "u-1", text: "one", source: "relay", at: 100 },
      { uuid: "u-2", text: "two", source: "web", at: 200 },
      { seq: 3, uuid: "u-3", text: "three", source: "rpc", at: 300 },
    ],
    outbound: [
      { uuid: "u-4", turn: "t-1", at: 400 },
      { uuid: "u-5", turn: "", at: 500 },
    ],
    received: [
      { text: "hi there", at: 600 },
      { text: "again", at: 700 },
    ],
  };
  saveReceipts(RID, log, dir);
  expect(loadReceipts(RID, dir)).toEqual(log);
});

// ── State initialization ─────────────────────────────────────────────────────

test("initDeliveryState builds forwardedUuids from outbound", () => {
  saveReceipts(
    RID,
    {
      inbound: [],
      outbound: [
        { uuid: "u-a", turn: "t-1", at: 1 },
        { uuid: "u-b", turn: "t-2", at: 2 },
      ],
      received: [],
    },
    dir,
  );
  const st = initDeliveryState(RID, dir);
  expect(st.forwardedUuids.has("u-a")).toBe(true);
  expect(st.forwardedUuids.has("u-b")).toBe(true);
  expect(st.forwardedUuids.has("u-c")).toBe(false);
  expect(st.pending).toEqual([]);
});

test("initDeliveryState with no prior data has empty everything", () => {
  const st = initDeliveryState(RID, dir);
  expect(st.pending).toEqual([]);
  expect(st.forwardedUuids.size).toBe(0);
  expect(st.receipts.inbound).toEqual([]);
  expect(st.receipts.outbound).toEqual([]);
});

// ── Sequential matching (the key invariant) ──────────────────────────────────

test("matchPendingForUserEntry pops front when text matches", () => {
  const st = initDeliveryState(RID, dir);
  st.pending.push({ seq: 1, text: "hello", source: "relay", at: 1 });
  st.pending.push({ seq: 2, text: "world", source: "relay", at: 2 });

  const m = matchPendingForUserEntry(st, "hello");
  expect(m).toEqual({ seq: 1, text: "hello", source: "relay", at: 1 });
  expect(st.pending.length).toBe(1);
  expect(st.pending[0].text).toBe("world");
});

test("matchPendingForUserEntry returns null when front doesn't match", () => {
  const st = initDeliveryState(RID, dir);
  st.pending.push({ seq: 1, text: "hello", source: "relay", at: 1 });
  // Direct typing produces "goodbye" — should not match "hello" at front
  const m = matchPendingForUserEntry(st, "goodbye");
  expect(m).toBeNull();
  expect(st.pending.length).toBe(1); // not popped
});

test("matchPendingForUserEntry returns null on empty queue", () => {
  const st = initDeliveryState(RID, dir);
  expect(matchPendingForUserEntry(st, "anything")).toBeNull();
});

test("identical messages are matched sequentially in FIFO order", () => {
  // The key invariant: two "yes" sends pair with the next two "yes" transcript entries.
  const st = initDeliveryState(RID, dir);
  st.pending.push({ seq: 10, text: "yes", source: "relay", at: 1 });
  st.pending.push({ seq: 12, text: "yes", source: "web", at: 2 });
  st.pending.push({ seq: 14, text: "no", source: "rpc", at: 3 });

  // Transcript shows three user entries: "yes", "yes", "no"
  const m1 = matchPendingForUserEntry(st, "yes");
  expect(m1?.seq).toBe(10);
  expect(m1?.source).toBe("relay");

  const m2 = matchPendingForUserEntry(st, "yes");
  expect(m2?.seq).toBe(12);
  expect(m2?.source).toBe("web");

  const m3 = matchPendingForUserEntry(st, "no");
  expect(m3?.seq).toBe(14);
  expect(m3?.source).toBe("rpc");

  expect(st.pending.length).toBe(0);
});

test("direct typing interleaved with sends keeps queue accurate", () => {
  const st = initDeliveryState(RID, dir);
  st.pending.push({ seq: 10, text: "send-1", source: "relay", at: 1 });

  // User types "typed-1" directly — doesn't match "send-1" front
  expect(matchPendingForUserEntry(st, "typed-1")).toBeNull();
  expect(st.pending.length).toBe(1);
  expect(st.pending[0].text).toBe("send-1");

  // Now the queued send appears in transcript
  expect(matchPendingForUserEntry(st, "send-1")?.seq).toBe(10);
  expect(st.pending.length).toBe(0);
});

// ── Receipt recording ────────────────────────────────────────────────────────

test("recordInboundReceipt appends and persists", () => {
  const st = initDeliveryState(RID, dir);
  recordInboundReceipt(
    st,
    RID,
    { seq: 5, uuid: "u-1", text: "hello", source: "relay", at: 100 },
    dir,
  );
  expect(st.receipts.inbound.length).toBe(1);

  // Reload from disk to verify persistence
  const reloaded = loadReceipts(RID, dir);
  expect(reloaded.inbound).toEqual([
    { seq: 5, uuid: "u-1", text: "hello", source: "relay", at: 100 },
  ]);
});

test("recordInboundReceipt is idempotent on uuid", () => {
  const st = initDeliveryState(RID, dir);
  recordInboundReceipt(
    st,
    RID,
    { seq: 5, uuid: "u-1", text: "hello", source: "relay", at: 100 },
    dir,
  );
  // Duplicate call — same uuid
  recordInboundReceipt(
    st,
    RID,
    { seq: 5, uuid: "u-1", text: "hello-again", source: "relay", at: 200 },
    dir,
  );
  expect(st.receipts.inbound.length).toBe(1);
  expect(st.receipts.inbound[0].text).toBe("hello"); // first one wins
});

test("recordOutboundReceipt adds to forwardedUuids and persists", () => {
  const st = initDeliveryState(RID, dir);
  recordOutboundReceipt(st, RID, { uuid: "u-1", turn: "t-1", at: 100 }, dir);
  expect(st.forwardedUuids.has("u-1")).toBe(true);
  expect(st.receipts.outbound.length).toBe(1);

  const reloaded = loadReceipts(RID, dir);
  expect(reloaded.outbound).toEqual([{ uuid: "u-1", turn: "t-1", at: 100 }]);
});

test("recordOutboundReceipt is idempotent on uuid", () => {
  const st = initDeliveryState(RID, dir);
  recordOutboundReceipt(st, RID, { uuid: "u-1", turn: "t-1", at: 100 }, dir);
  recordOutboundReceipt(st, RID, { uuid: "u-1", turn: "t-2", at: 200 }, dir);
  expect(st.receipts.outbound.length).toBe(1);
  expect(st.receipts.outbound[0].turn).toBe("t-1"); // first one wins
  expect(st.forwardedUuids.size).toBe(1);
});

// ── Recovery scenario ────────────────────────────────────────────────────────

test("recovery: forwardedUuids prevents re-forwarding old assistant entries", () => {
  // Simulate: joy-daemon ran before, forwarded uuids u-a and u-b.
  saveReceipts(
    RID,
    {
      inbound: [],
      outbound: [
        { uuid: "u-a", turn: "t-1", at: 1 },
        { uuid: "u-b", turn: "t-2", at: 2 },
      ],
      received: [],
    },
    dir,
  );

  // joy-daemon restarts and loads state
  const st = initDeliveryState(RID, dir);

  // Recovery scans the transcript. The watcher would see u-a, u-b, u-c (new).
  // The code path checks st.forwardedUuids before forwarding.
  expect(st.forwardedUuids.has("u-a")).toBe(true);  // skip
  expect(st.forwardedUuids.has("u-b")).toBe(true);  // skip
  expect(st.forwardedUuids.has("u-c")).toBe(false); // forward this one
});

test("recovery: direct typing during downtime is detected as not-yet-forwarded", () => {
  // joy-daemon was running, forwarded u-1 (assistant) earlier
  saveReceipts(RID, { inbound: [], outbound: [{ uuid: "u-1", turn: "t-1", at: 1 }], received: [] }, dir);

  // joy-daemon was down. User typed directly. Transcript now has a user entry u-2.
  const st = initDeliveryState(RID, dir);

  // u-2 is not in forwardedUuids — would trigger the forward-to-relay path
  expect(st.forwardedUuids.has("u-2")).toBe(false);

  // Simulate the forward
  recordOutboundReceipt(st, RID, { uuid: "u-2", turn: "", at: Date.now() }, dir);
  expect(st.forwardedUuids.has("u-2")).toBe(true);

  // On next restart, this would be skipped
  const next = initDeliveryState(RID, dir);
  expect(next.forwardedUuids.has("u-2")).toBe(true);
});

// ── Optional seq field (web/rpc don't have one) ──────────────────────────────

test("inbound receipt with no seq (web/rpc source) is allowed", () => {
  const st = initDeliveryState(RID, dir);
  recordInboundReceipt(
    st,
    RID,
    { uuid: "u-1", text: "hi", source: "web", at: 100 },
    dir,
  );
  const reloaded = loadReceipts(RID, dir);
  expect(reloaded.inbound[0].seq).toBeUndefined();
  expect(reloaded.inbound[0].source).toBe("web");
});

// ── #558: oldest unexpired receipt is consumed first ─────────────────────────

test("identical sends 14 minutes apart both suppress their late echoes (#558)", () => {
  const MIN = 60_000;
  const state = initDeliveryState(RID, dir);
  recordReceived(state, RID, "yes", 0 * MIN, dir);
  recordReceived(state, RID, "yes", 14 * MIN, dir);
  // First echo at 14:10 must take the minute-0 entry (about to expire)...
  expect(consumeReceived(state, RID, "yes", 14 * MIN + 10_000, dir)).toBe(true);
  expect(state.receipts.received).toEqual([{ text: "yes", at: 14 * MIN }]);
  // ...so the second echo at 15:10 still finds the minute-14 entry.
  expect(consumeReceived(state, RID, "yes", 15 * MIN + 10_000, dir)).toBe(true);
  expect(state.receipts.received).toEqual([]);
});

// ── #560: forwardedUuids is bounded like the log it mirrors ──────────────────

test("pruning the outbound log also prunes forwardedUuids; inbound uuids survive (#560)", () => {
  // Debounced mode: 2600 synchronous fsync'd rewrites would take seconds.
  configureReceiptSaves({ immediate: false });
  const state = initDeliveryState(RID, dir);
  try {
    recordInboundReceipt(state, RID, { uuid: "in-keep", text: "hi", source: "relay", at: 1 }, dir);
    for (let i = 0; i < 2600; i++) recordOutboundReceipt(state, RID, { uuid: `o-${i}`, turn: "t", at: i }, dir);
  } finally {
    configureReceiptSaves({ immediate: true });
    flushReceipts();
  }
  expect(state.receipts.outbound.length).toBeLessThanOrEqual(2000);
  // 2600 seen; at most 2000 outbound + 1 inbound remembered — never all 2600.
  expect(state.forwardedUuids.size).toBeLessThanOrEqual(2001);
  expect(state.forwardedUuids.has("o-2599")).toBe(true);
  expect(state.forwardedUuids.has("o-0")).toBe(false);
  expect(state.forwardedUuids.has("in-keep")).toBe(true);
  // The set matches the log exactly.
  const fromLog = new Set([...state.receipts.outbound.map((r) => r.uuid), ...state.receipts.inbound.map((r) => r.uuid)]);
  expect([...state.forwardedUuids].sort()).toEqual([...fromLog].sort());
});

// ── #556: sustained activity cannot postpone persistence indefinitely ────────

test("a receipt every 200ms still reaches disk within the max delay (#556)", () => {
  vi.useFakeTimers();
  configureReceiptSaves({ immediate: false, debounceMs: 300, maxDelayMs: 1000 });
  try {
    const state = initDeliveryState(RID, dir);
    const p = receiptPath(RID, dir);
    let i = 0;
    const tick = () => recordOutboundReceipt(state, RID, { uuid: `u-${i++}`, turn: "t", at: Date.now() }, dir);
    tick();
    // 200ms cadence: each save used to re-arm the 300ms debounce, so nothing was written.
    for (let t = 200; t <= 800; t += 200) { vi.advanceTimersByTime(200); tick(); } // saves at 0,200,…,800
    expect(existsSync(p)).toBe(false); // 800ms in: still inside the 1000ms max delay window
    vi.advanceTimersByTime(200);       // 1000ms since the first dirty change: the clamp fires
    expect(existsSync(p)).toBe(true);
    const written = loadReceipts(RID, dir).outbound.length;
    expect(written).toBeGreaterThanOrEqual(5);
    // Quiet period after the stream: the trailing debounce lands the rest.
    tick();
    vi.advanceTimersByTime(350);
    expect(loadReceipts(RID, dir).outbound.length).toBe(i);
  } finally {
    configureReceiptSaves({ immediate: true, debounceMs: 300, maxDelayMs: 2000 });
    flushReceipts();
    vi.useRealTimers();
  }
});
