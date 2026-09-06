import { test, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isTurnDelivered, markTurnDelivered, saveCheckpoint, loadCheckpoint, type CodexCheckpoint } from "./codexCheckpointStore";

afterEach(() => vi.restoreAllMocks());

test("saveCheckpoint goes through the atomic writer: a failed save returns false and keeps the previous high-water (Wave B)", () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-cp-"));
  try {
    const cp1: CodexCheckpoint = { threadId: "th", deliveredThroughTurnId: "t-0001" };
    expect(saveCheckpoint("s", cp1, dir)).toBe(true);
    expect(loadCheckpoint("s", dir)).toEqual({ ...cp1, knownClientIds: undefined, seqReceipts: undefined });
    vi.spyOn(fs, "writeSync").mockImplementation(() => { throw Object.assign(new Error("EIO"), { code: "EIO" }); });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(saveCheckpoint("s", { ...cp1, deliveredThroughTurnId: "t-0002" }, dir)).toBe(false);
    vi.restoreAllMocks();
    expect(loadCheckpoint("s", dir).deliveredThroughTurnId).toBe("t-0001");
    expect(readdirSync(dir).filter((f) => f.startsWith(".") || f.endsWith(".tmp"))).toEqual([]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// UUIDv7-ish ids: monotonically increasing so lexicographic order == time order.
const T = (n: number) => `019f9200-0000-7000-8000-${String(n).padStart(12, "0")}`;

function empty(): CodexCheckpoint { return { threadId: "th", deliveredThroughTurnId: null }; }

test("high-water: delivering in order advances the mark, no unbounded set", () => {
  let cp = empty();
  for (let i = 1; i <= 2000; i++) cp = markTurnDelivered(cp, T(i));
  // The whole 1..2000 prefix is captured by ONE high-water id — NOT a 500-cap
  // set that would evict old ids and replay them (the finding #2 bug).
  expect(cp.deliveredThroughTurnId).toBe(T(2000));
  expect(isTurnDelivered(cp, T(1))).toBe(true);
  expect(isTurnDelivered(cp, T(500))).toBe(true);
  expect(isTurnDelivered(cp, T(2000))).toBe(true);
  expect(isTurnDelivered(cp, T(2001))).toBe(false);
});

test("the high-water only advances, never regresses", () => {
  let cp = empty();
  cp = markTurnDelivered(cp, T(5));
  cp = markTurnDelivered(cp, T(3)); // an older id can't pull the mark back
  expect(cp.deliveredThroughTurnId).toBe(T(5));
  expect(isTurnDelivered(cp, T(3))).toBe(true); // still covered (< high-water)
  expect(isTurnDelivered(cp, T(6))).toBe(false);
});

test("empty checkpoint delivers nothing", () => {
  const cp = empty();
  expect(isTurnDelivered(cp, T(1))).toBe(false);
  expect(isTurnDelivered(cp, "")).toBe(false);
});
