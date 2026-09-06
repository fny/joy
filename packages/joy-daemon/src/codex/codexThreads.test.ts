import { test, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, truncateSync, utimesSync } from "fs";
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

// #521: the newest rollout is HUGE (past Node's 2 GiB readFileSync limit —
// a sparse file, so the test costs no disk) but its first line is a small,
// valid session_meta. Reading only a bounded head must still find it; the
// old whole-file read threw and silently fell back to the OLDER thread.
test("findLatestCodexThreadForCwd: a rollout too large to read whole still yields its thread id (#521)", () => {
  const home = mkdtempSync(join(tmpdir(), "cxh-big-"));
  const day = join(home, "sessions", "2026", "09", "05");
  mkdirSync(day, { recursive: true });
  const meta = (id: string, cwd: string) => JSON.stringify({ type: "session_meta", payload: { id, cwd } }) + "\n";
  const t = Date.now();
  const older = join(day, "rollout-old.jsonl");
  writeFileSync(older, meta("thread-old", "/proj/big"));
  utimesSync(older, new Date(t - 60_000), new Date(t - 60_000));
  const huge = join(day, "rollout-huge.jsonl");
  writeFileSync(huge, meta("thread-huge", "/proj/big") + '{"type":"response_item"}\n');
  truncateSync(huge, 3 * 1024 * 1024 * 1024); // 3 GiB sparse tail
  utimesSync(huge, new Date(t), new Date(t));
  expect(findLatestCodexThreadForCwd("/proj/big", home)).toBe("thread-huge");
  // A head with no newline inside the bound is not a session_meta line: skipped, not a crash.
  const junk = join(day, "rollout-junk.jsonl");
  writeFileSync(junk, "x".repeat(70 * 1024));
  utimesSync(junk, new Date(t + 1000), new Date(t + 1000));
  expect(findLatestCodexThreadForCwd("/proj/big", home)).toBe("thread-huge");
  rmSync(home, { recursive: true, force: true });
});
