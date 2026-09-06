// The CODEX_HOME family at its sites (#524 #541 #546): with the variable
// pointing at a custom home, config editing, rollout lookup/fork and the quota
// lookup all use THAT home; with it unset they use ~/.codex.
import { test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { agentConfigSpec } from "../domain/agentConfig";
import { findCodexRollout, forkCodexThread } from "../domain/forkHarness";
import { readCodexLimits } from "../domain/limits";
import { loadCodexModelsCacheFile } from "./appServerClient";
import { codexSessionsDir } from "./codexThreads";

let home: string;
const saved = { CODEX_HOME: process.env.CODEX_HOME, HOME: process.env.HOME };
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "codex-home-"));
  // A HOME with NO ~/.codex, so a site that ignores CODEX_HOME visibly fails.
  process.env.HOME = join(home, "user-home");
  mkdirSync(process.env.HOME, { recursive: true });
  process.env.CODEX_HOME = join(home, "custom-codex");
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmSync(home, { recursive: true, force: true });
});

test("agentConfigSpec('codex') edits $CODEX_HOME/config.toml (#524)", () => {
  expect(agentConfigSpec("codex")!.path).toBe(join(home, "custom-codex", "config.toml"));
});

test("findCodexRollout / forkCodexThread search and write under $CODEX_HOME (#541)", () => {
  const threadId = "0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee";
  const day = join(process.env.CODEX_HOME!, "sessions", "2026", "09", "06");
  mkdirSync(day, { recursive: true });
  const rollout = join(day, `rollout-2026-09-06T00-00-00-${threadId}.jsonl`);
  writeFileSync(rollout, [
    JSON.stringify({ type: "session_meta", payload: { id: threadId, session_id: threadId, cwd: "/w", timestamp: "2026-09-06T00:00:00Z" } }),
    JSON.stringify({ type: "response_item", payload: { role: "user", content: "hi" } }),
  ].join("\n") + "\n");

  expect(findCodexRollout(threadId)).toBe(rollout);

  const forkId = forkCodexThread(threadId);
  const forked = findCodexRollout(forkId);
  expect(forked).not.toBeNull();
  expect(forked!.startsWith(join(process.env.CODEX_HOME!, "sessions"))).toBe(true);
  // Nothing was written into the ignored default home.
  expect(existsSync(join(process.env.HOME!, ".codex"))).toBe(false);
});

test("readCodexLimits() defaults to $CODEX_HOME/sessions (#546)", () => {
  const day = join(process.env.CODEX_HOME!, "sessions", "2026", "09", "06");
  mkdirSync(day, { recursive: true });
  writeFileSync(join(day, "rollout-2026-09-06T01-00-00-x.jsonl"), [
    JSON.stringify({ type: "session_meta", payload: { id: "x" } }),
    JSON.stringify({ type: "event_msg", timestamp: "2026-09-06T01:02:03Z", payload: { type: "token_count", rate_limits: { primary: { used_percent: 25, window_minutes: 300 } } } }),
  ].join("\n") + "\n");
  const r = readCodexLimits();
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.limits.primary?.used_percent).toBe(25);
});

test("the pre-existing honouring sites still resolve through the shared helper", () => {
  expect(codexSessionsDir()).toBe(join(home, "custom-codex", "sessions"));
  expect(codexSessionsDir("/explicit")).toBe("/explicit/sessions");
  mkdirSync(process.env.CODEX_HOME!, { recursive: true });
  writeFileSync(join(process.env.CODEX_HOME!, "models_cache.json"), JSON.stringify({ models: [{ slug: "gpt-x", display_name: "X", visibility: "list", priority: 1 }] }));
  expect(loadCodexModelsCacheFile()?.length).toBe(1);
});

test("unset CODEX_HOME → ~/.codex for every site", () => {
  delete process.env.CODEX_HOME;
  const dflt = join(process.env.HOME!, ".codex");
  expect(agentConfigSpec("codex")!.path).toBe(join(dflt, "config.toml"));
  expect(codexSessionsDir()).toBe(join(dflt, "sessions"));
  const r = readCodexLimits();
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toContain(join(dflt, "sessions"));
  expect(readdirSync(process.env.HOME!)).toEqual([]); // nothing created as a side effect
});
