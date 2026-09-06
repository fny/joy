// Threshold alert gating (#565) and the scheduled limits check never rejecting (#566).
import { describe, it, expect } from "vitest";
import { AlertGate, runLimitsCheck } from "./resourceAlerts";

describe("AlertGate (#565)", () => {
  it("fires only when re-armed AND the 4h cooldown has elapsed — independently", () => {
    const g = new AlertGate();
    const t0 = 1_000_000;
    const h = 3600_000;
    expect(g.check("ram", 95, t0)).toBe(true);               // first crossing
    expect(g.check("ram", 80, t0 + 5 * 60_000)).toBe(false);  // dips → re-arms
    expect(g.check("ram", 95, t0 + 10 * 60_000)).toBe(false); // re-armed, but inside the cooldown
    expect(g.check("ram", 95, t0 + 5 * h)).toBe(true);        // armed AND cooldown elapsed
    expect(g.check("ram", 95, t0 + 10 * h)).toBe(false);      // pinned hot with no dip: no repeat
    expect(g.check("ram", 88, t0 + 11 * h)).toBe(false);      // hysteresis band: neither fires nor re-arms
    expect(g.check("ram", 95, t0 + 12 * h)).toBe(false);
    expect(g.check("disk", 91, t0)).toBe(true);               // keys are independent
    expect(g.check("ram", null, t0)).toBe(false);
  });
});

describe("runLimitsCheck (#566)", () => {
  it("a null quota body is skipped and a throwing reader is contained — the promise never rejects", async () => {
    const fired: string[] = [];
    await expect(runLimitsCheck((key) => { fired.push(key); }, {
      fetchClaudeLimits: async () => ({ ok: true as const, limits: null as unknown as Record<string, never> }),
      readCodexLimits: () => { throw new Error("boom"); },
      host: "h",
    })).resolves.toBeUndefined();
    expect(fired).toEqual([]);
    // a well-formed hot bucket still reaches the gate
    await runLimitsCheck((key) => { fired.push(key); }, {
      fetchClaudeLimits: async () => ({ ok: true as const, limits: { five_hour: { utilization: 95, resets_at: "2026-09-06T00:00:00Z" }, seven_day: null } }),
      readCodexLimits: () => ({ ok: false as const, error: "none" }),
      host: "h",
    });
    expect(fired).toEqual(["claude-5-hour"]);
  });
});
