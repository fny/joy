import { test, expect, vi } from "vitest";
import fs, { mkdtempSync, mkdirSync, writeFileSync, rmSync, truncateSync, utimesSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { clearCodexRolloutTitleCache, codexRolloutTitle, findLatestCodexThreadForCwd, listCodexThreadsForCwd, parseCodexConfigArgs } from "./codexThreads";

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

// #521 (Astra partial on 81386fd0): a read may return fewer bytes than asked
// without being at EOF. One short read of a valid header used to be taken as
// the whole (newline-less) head → every matching thread skipped → null.
test("findLatestCodexThreadForCwd: short reads are continued until the newline (#521)", () => {
  const home = mkdtempSync(join(tmpdir(), "cxh-short-"));
  const day = join(home, "sessions", "2026", "09", "06");
  mkdirSync(day, { recursive: true });
  const meta = (id: string, cwd: string) => JSON.stringify({ type: "session_meta", payload: { id, cwd } }) + "\n";
  writeFileSync(join(day, "rollout-short.jsonl"), meta("thread-short", "/proj/short") + '{"type":"response_item","payload":{"text":"' + "y".repeat(4096) + '"}}\n');
  // A one-line file with no trailing newline must still be read to EOF.
  writeFileSync(join(day, "rollout-noeol.jsonl"), meta("thread-noeol", "/proj/noeol").trimEnd());
  const real = fs.readSync;
  const spy = vi.spyOn(fs, "readSync").mockImplementation(((fd: number, buf: NodeJS.ArrayBufferView, off: number, len: number, pos: number | bigint | null) =>
    real(fd, buf, off, Math.min(len, 16), pos)) as typeof fs.readSync);
  try {
    expect(findLatestCodexThreadForCwd("/proj/short", home)).toBe("thread-short");
    expect(findLatestCodexThreadForCwd("/proj/noeol", home)).toBe("thread-noeol");
    expect(spy.mock.calls.length).toBeGreaterThan(2); // the loop really continued past the first short read
  } finally {
    spy.mockRestore();
    rmSync(home, { recursive: true, force: true });
  }
});

test("listCodexThreadsForCwd: every rollout of the cwd, newest first, titled by the first real prompt", () => {
  const home = mkdtempSync(join(tmpdir(), "cxh-list-"));
  const day = join(home, "sessions", "2026", "09", "09");
  mkdirSync(day, { recursive: true });
  const env = JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>\n<cwd>/proj/a</cwd>\n</environment_context>" }] } });
  const prompt = (t: string) => JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: t }] } });
  const meta = (id: string, cwd: string) => JSON.stringify({ type: "session_meta", payload: { id, cwd } });
  const a = join(day, "rollout-a.jsonl"); writeFileSync(a, [meta("t-old", "/proj/a"), env, prompt("Refactor the pairing flow")].join("\n") + "\n");
  const b = join(day, "rollout-b.jsonl"); writeFileSync(b, [meta("t-other", "/proj/b"), env].join("\n") + "\n");
  const c = join(day, "rollout-c.jsonl"); writeFileSync(c, [meta("t-new", "/proj/a"), env, JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "Ship it" } })].join("\n") + "\n");
  const t = Date.now();
  utimesSync(c, new Date(t), new Date(t));
  utimesSync(a, new Date(t - 60_000), new Date(t - 60_000));
  const rows = listCodexThreadsForCwd("/proj/a", home);
  expect(rows.map((r) => [r.id, r.title])).toEqual([["t-new", "Ship it"], ["t-old", "Refactor the pairing flow"]]);
  expect(rows[0].sizeBytes).toBeGreaterThan(0);
  expect(listCodexThreadsForCwd("/proj/none", home)).toEqual([]);
  rmSync(home, { recursive: true, force: true });
});

// A joy-driven thread's first user message is three preamble parts
// (recommended plugins, AGENTS.md, environment_context), and the next line
// is a `world_state` record carrying the whole AGENTS.md — tens of KB before
// the real prompt. A single 16KB head read titled none of them.
test("codexRolloutTitle: reads past a large preamble and skips wrapper parts, and caches by size+mtime", () => {
  clearCodexRolloutTitleCache();
  const home = mkdtempSync(join(tmpdir(), "cxh-title-"));
  const file = join(home, "rollout-big.jsonl");
  const msg = (parts: string[]) => JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: parts.map((text) => ({ type: "input_text", text })) } });
  const preamble = msg(["<recommended_plugins>\n- Airtable\n</recommended_plugins>", "# AGENTS.md instructions\n\n<INSTRUCTIONS>rules</INSTRUCTIONS>", "<environment_context>\n<cwd>/proj</cwd>\n</environment_context>"]);
  const worldState = JSON.stringify({ type: "world_state", payload: { full: true, state: { agents_md: { text: "x".repeat(40 * 1024) } } } });
  writeFileSync(file, [JSON.stringify({ type: "session_meta", payload: { id: "t1", cwd: "/proj" } }), preamble, worldState, msg(["You are picking up work from Claude Code. Its handoff note is below."]), msg(["Show me the image"])].join("\n") + "\n");
  expect(codexRolloutTitle(file)).toBe("You are picking up work from Claude Code. Its handoff note…");
  // Capped read: the prompt beyond the cap is not found, and nothing is misread.
  clearCodexRolloutTitleCache();
  expect(codexRolloutTitle(file, 8 * 1024)).toBeNull();
  // Cached: a rewrite with the same size+mtime is not re-read; a newer file is.
  clearCodexRolloutTitleCache();
  expect(codexRolloutTitle(file)).toContain("picking up work");
  writeFileSync(file, [JSON.stringify({ type: "session_meta", payload: { id: "t1", cwd: "/proj" } }), msg(["Different prompt"])].join("\n") + "\n");
  utimesSync(file, new Date(Date.now() + 5000), new Date(Date.now() + 5000));
  expect(codexRolloutTitle(file)).toBe("Different prompt");
  rmSync(home, { recursive: true, force: true });
});
