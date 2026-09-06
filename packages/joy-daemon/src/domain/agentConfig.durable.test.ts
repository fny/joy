// #527 — retrying a failed config write must not destroy the only intact
// backup. Reproduces the reported sequence: two saves that both fail with
// ENOSPC (injected at the fs layer the atomic writer uses), then a save that
// succeeds. Live file and .joy-bak must be untouched after the failures.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { applyAgentConfigAssignments, writeAgentConfigRaw } from "./agentConfig";

describe("agent config writes survive ENOSPC (#527)", () => {
  let home: string;
  const realHome = process.env.HOME;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), "joy-agentconfig-enospc-")); process.env.HOME = home; });
  afterEach(() => { vi.restoreAllMocks(); process.env.HOME = realHome; rmSync(home, { recursive: true, force: true }); });

  const enospc = () => Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });

  it("two failed raw saves in a row leave config AND backup intact; the retry that succeeds rotates", () => {
    const dir = join(home, ".claude");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "settings.json");
    writeFileSync(file + ".joy-bak", JSON.stringify({ model: "gen0" }));
    writeFileSync(file, JSON.stringify({ model: "gen1" }));

    const spy = vi.spyOn(fs, "writeSync").mockImplementation(() => { throw enospc(); });
    const r1 = writeAgentConfigRaw("claude", JSON.stringify({ model: "gen2" }));
    const r2 = writeAgentConfigRaw("claude", JSON.stringify({ model: "gen2" }));
    expect(r1.ok).toBe(false);
    expect(r2.ok).toBe(false);
    expect((r1 as { error: string }).error).toMatch(/write failed/);
    // Both generations survive: the live file was never truncated, the
    // backup was never overwritten by a partial live file.
    expect(JSON.parse(readFileSync(file, "utf-8"))).toEqual({ model: "gen1" });
    expect(JSON.parse(readFileSync(file + ".joy-bak", "utf-8"))).toEqual({ model: "gen0" });
    expect(readdirSync(dir).filter((f) => f.startsWith("."))).toEqual([]); // no temp leftovers
    spy.mockRestore();

    const r3 = writeAgentConfigRaw("claude", JSON.stringify({ model: "gen2" }));
    expect(r3.ok).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf-8"))).toEqual({ model: "gen2" });
    expect(JSON.parse(readFileSync(file + ".joy-bak", "utf-8"))).toEqual({ model: "gen1" });
  });

  it("a failed path-assignment save leaves the existing file untouched", () => {
    const dir = join(home, ".codex");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "config.toml");
    writeFileSync(file, 'model = "gpt-6"\n');
    vi.spyOn(fs, "renameSync").mockImplementation(() => { throw enospc(); });
    const r = applyAgentConfigAssignments("codex", ['model = "other"']);
    expect(r.ok).toBe(false);
    expect(readFileSync(file, "utf-8")).toBe('model = "gpt-6"\n');
  });
});
