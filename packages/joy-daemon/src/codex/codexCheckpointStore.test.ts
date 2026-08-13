import { test, expect } from "vitest";
import { isTurnDelivered, markTurnDelivered, type CodexCheckpoint } from "./codexCheckpointStore";

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
