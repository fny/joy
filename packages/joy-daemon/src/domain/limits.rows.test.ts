import { test, expect } from "vitest";
import { claudeLimitRows } from "./limits";

// Shape captured from api/oauth/usage on 2026-09-03: two unscoped buckets,
// a pile of codenamed experiment buckets, and a structured `limits` array
// carrying the one MODEL-scoped window (Fable) the app had never shown.
const raw = {
  five_hour: { utilization: 27, resets_at: "2026-09-03T21:00:00Z" },
  seven_day: { utilization: 48, resets_at: "2026-09-08T01:00:00Z" },
  seven_day_opus: null,
  seven_day_sonnet: null,
  nimbus_quill: { utilization: 0, resets_at: null },
  tangelo: null,
  extra_usage: { utilization: null },
  limits: [
    { kind: "session", group: "session", percent: 27, resets_at: "2026-09-03T21:00:00Z", scope: null },
    { kind: "weekly_all", group: "weekly", percent: 48, resets_at: "2026-09-08T01:00:00Z", scope: null },
    { kind: "weekly_scoped", group: "weekly", percent: 68, resets_at: "2026-09-08T01:00:00Z", scope: { model: { id: null, display_name: "Fable" }, surface: null } },
  ],
};

test("claudeLimitRows: known buckets + scoped windows, codenamed experiments excluded", () => {
  const rows = claudeLimitRows(raw);
  expect(rows.map((r) => r.id)).toEqual(["five_hour", "seven_day", "weekly_scoped:fable"]);
  const fable = rows.find((r) => r.id === "weekly_scoped:fable")!;
  expect(fable.usedPercent).toBe(68);
  expect(fable.scope).toBe("Fable");
  expect(fable.resetsAt).toBe("2026-09-08T01:00:00Z");
  // nimbus_quill (0%) and extra_usage (null) never become bars.
  expect(rows.some((r) => r.id === "nimbus_quill" || r.id === "extra_usage")).toBe(false);
});

test("claudeLimitRows: unscoped structured entries do not duplicate the buckets", () => {
  const rows = claudeLimitRows(raw);
  expect(rows.filter((r) => r.usedPercent === 27)).toHaveLength(1);
  expect(rows.filter((r) => r.usedPercent === 48)).toHaveLength(1);
});

test("claudeLimitRows: opus/sonnet buckets carry a model scope; garbage input yields no rows", () => {
  const rows = claudeLimitRows({ seven_day_opus: { utilization: 12, resets_at: null } });
  expect(rows).toEqual([{ id: "seven_day_opus", kind: "window", usedPercent: 12, resetsAt: null, scope: "Opus", unit: "percent" }]);
  expect(claudeLimitRows(null)).toEqual([]);
  expect(claudeLimitRows("nope")).toEqual([]);
});
