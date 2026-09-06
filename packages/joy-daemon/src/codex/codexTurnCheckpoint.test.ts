import { test, expect } from "vitest";
import { isTurnDelivered, advanceTurnHighWater } from "./codexTurnCheckpoint";

// UUIDv7-ish ids: monotonically increasing so lexicographic order == time order.
const T = (n: number) => `019f9200-0000-7000-8000-${String(n).padStart(12, "0")}`;

test("high-water: delivering in order advances the mark, no unbounded set", () => {
  let high: string | null = null;
  for (let i = 1; i <= 2000; i++) high = advanceTurnHighWater(high, T(i));
  // The whole 1..2000 prefix is captured by ONE high-water id — NOT a 500-cap
  // set that would evict old ids and replay them (the finding #2 bug).
  expect(high).toBe(T(2000));
  expect(isTurnDelivered(high, T(1))).toBe(true);
  expect(isTurnDelivered(high, T(500))).toBe(true);
  expect(isTurnDelivered(high, T(2000))).toBe(true);
  expect(isTurnDelivered(high, T(2001))).toBe(false);
});

test("the high-water only advances, never regresses", () => {
  let high = advanceTurnHighWater(null, T(5));
  high = advanceTurnHighWater(high, T(3)); // an older id can't pull the mark back
  expect(high).toBe(T(5));
  expect(isTurnDelivered(high, T(3))).toBe(true); // still covered (< high-water)
  expect(isTurnDelivered(high, T(6))).toBe(false);
});

test("empty checkpoint delivers nothing", () => {
  expect(isTurnDelivered(null, T(1))).toBe(false);
  expect(isTurnDelivered(T(1), "")).toBe(false);
  expect(advanceTurnHighWater(null, "")).toBeNull();
});
