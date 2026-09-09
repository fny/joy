import { describe, expect, it } from "vitest";
import { HARNESSES, HARNESS_CAPABILITIES, effortLevelsFor, isHarness, permissionModesFor } from "./harnessCapabilities";

describe("HARNESS_CAPABILITIES", () => {
  it("names every harness, once, under its own key", () => {
    for (const h of HARNESSES) expect(HARNESS_CAPABILITIES[h].harness).toBe(h);
    expect(Object.keys(HARNESS_CAPABILITIES).sort()).toEqual([...HARNESSES].sort());
  });

  it("a default permission mode is always one of the listed modes", () => {
    for (const h of HARNESSES) {
      const p = HARNESS_CAPABILITIES[h].permissions;
      if (!p) continue;
      expect(p.modes.map((m) => m.key)).toContain(p.default);
      // keys are wire values: no spaces, no case games
      for (const m of p.modes) expect(m.key).toMatch(/^[a-zA-Z-]+$/);
    }
  });

  it("a default effort is one of the fixed levels, and per-model efforts list none", () => {
    for (const h of HARNESSES) {
      const e = HARNESS_CAPABILITIES[h].effort;
      if (!e) continue;
      if (e.default !== null) expect(e.levels).toContain(e.default);
      if (e.perModel && h === "opencode") expect(e.levels).toEqual([]);
    }
  });

  it("the helpers mirror the table", () => {
    expect(permissionModesFor("pi")).toEqual(new Set(["default", "plan"]));
    expect(effortLevelsFor("agy")).toEqual(new Set(["low", "medium", "high"]));
    expect(effortLevelsFor("opencode")).toEqual(new Set());
    expect(isHarness("codex")).toBe(true);
    expect(isHarness("gemini")).toBe(false);
  });

  it("a fixed catalog only for claude; every other harness is live", () => {
    expect(HARNESS_CAPABILITIES.claude.models.source).toBe("static");
    for (const h of HARNESSES) if (h !== "claude") expect(HARNESS_CAPABILITIES[h].models.source).toBe("live");
  });
});
