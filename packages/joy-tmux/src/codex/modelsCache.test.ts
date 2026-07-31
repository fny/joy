import { test, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { loadCodexModelsCacheFile } from "./appServerClient";

// Shape captured from a real ~/.codex/models_cache.json (codex 0.144.6).
const CACHE = {
  fetched_at: "2026-07-31T00:53:44Z", etag: "W/\"x\"", client_version: "0.144.6",
  models: [
    { slug: "codex-auto-review", display_name: "Auto Review", visibility: "hide", priority: 43, default_reasoning_level: "medium", supported_reasoning_levels: [{ effort: "medium" }] },
    { slug: "gpt-5.5", display_name: "GPT-5.5", visibility: "list", priority: 7, default_reasoning_level: "medium", supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }] },
    { slug: "gpt-5.6-sol", display_name: "GPT-5.6-Sol", visibility: "list", priority: 1, default_reasoning_level: "low", supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }, { effort: "xhigh" }, { effort: "max" }, { effort: "ultra" }] },
  ],
};

test("loadCodexModelsCacheFile: maps, sorts by priority, flags default + hidden", () => {
  const dir = mkdtempSync(join(tmpdir(), "cxcache-"));
  writeFileSync(join(dir, "models_cache.json"), JSON.stringify(CACHE));
  const models = loadCodexModelsCacheFile(dir)!;
  rmSync(dir, { recursive: true, force: true });
  expect(models.map((m) => m.model)).toEqual(["gpt-5.6-sol", "gpt-5.5", "codex-auto-review"]);
  const sol = models[0];
  expect(sol.isDefault).toBe(true);
  expect(sol.hidden).toBe(false);
  expect(sol.displayName).toBe("GPT-5.6-Sol");
  expect(sol.defaultReasoningEffort).toBe("low");
  expect(sol.supportedReasoningEfforts).toEqual(["low", "medium", "high", "xhigh", "max", "ultra"]);
  expect(models[1].isDefault).toBe(false);
  expect(models[2].hidden).toBe(true); // visibility 'hide' → filtered by the op
});

test("loadCodexModelsCacheFile: missing/empty file → null (fallback path)", () => {
  expect(loadCodexModelsCacheFile("/nonexistent-dir-xyz")).toBeNull();
  const dir = mkdtempSync(join(tmpdir(), "cxcache-"));
  writeFileSync(join(dir, "models_cache.json"), JSON.stringify({ models: [] }));
  expect(loadCodexModelsCacheFile(dir)).toBeNull();
  rmSync(dir, { recursive: true, force: true });
});
