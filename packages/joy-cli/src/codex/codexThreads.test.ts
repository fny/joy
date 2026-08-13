import { test, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { findLatestCodexThreadForCwd, parseCodexConfigArgs } from "./codexThreads";

test("findLatestCodexThreadForCwd: newest rollout for the cwd wins; others ignored", () => {
  const home = mkdtempSync(join(tmpdir(), "cxh-"));
  const day = join(home, "sessions", "2026", "07", "31");
  mkdirSync(day, { recursive: true });
  const meta = (id: string, cwd: string) => JSON.stringify({ type: "session_meta", payload: { id, cwd } }) + "\n";
  writeFileSync(join(day, "rollout-a.jsonl"), meta("thread-old", "/proj/a"));
  writeFileSync(join(day, "rollout-b.jsonl"), meta("thread-other", "/proj/b"));
  const newer = join(day, "rollout-c.jsonl");
  writeFileSync(newer, meta("thread-new", "/proj/a"));
  const fs = require("fs"); const t = Date.now();
  fs.utimesSync(newer, new Date(t), new Date(t));
  fs.utimesSync(join(day, "rollout-a.jsonl"), new Date(t - 60000), new Date(t - 60000));
  expect(findLatestCodexThreadForCwd("/proj/a", home)).toBe("thread-new");
  expect(findLatestCodexThreadForCwd("/proj/b", home)).toBe("thread-other");
  expect(findLatestCodexThreadForCwd("/proj/none", home)).toBeNull();
  rmSync(home, { recursive: true, force: true });
});

test("parseCodexConfigArgs: k=v pairs, quotes, junk ignored", () => {
  expect(parseCodexConfigArgs('model_reasoning_summary=none sandbox_permissions="disk-full-read-access"'))
    .toEqual({ model_reasoning_summary: "none", sandbox_permissions: "disk-full-read-access" });
  expect(parseCodexConfigArgs("a.b=1 c='two words' notapair"))
    .toEqual({ "a.b": "1", c: "two words" });
  expect(parseCodexConfigArgs("")).toEqual({});
});
