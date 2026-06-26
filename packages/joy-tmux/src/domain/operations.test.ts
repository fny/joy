import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, writeFileSync, rmSync, utimesSync } from "fs";
import { join } from "path";
import { machineOps } from "./operations";
import { cwdToTranscriptDir } from "../claude/transcript";

// A throwaway cwd whose encoded transcript dir is unique to this test.
const TEST_CWD = "/tmp/joy-logs-optest";
const dir = cwdToTranscriptDir(TEST_CWD);

const listLogs = machineOps.find((o) => o.rpcName === "joy-list-logs")!;
const readLog = machineOps.find((o) => o.rpcName === "joy-read-log")!;
const reg = {} as never; // these ops don't touch the registry

function jsonl(lines: object[]): string {
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}

beforeAll(() => {
  mkdirSync(dir, { recursive: true });
  // Two logs with distinct mtimes so ordering is deterministic.
  writeFileSync(join(dir, "older.jsonl"), jsonl([
    { type: "user", timestamp: "2026-01-01T00:00:00.000Z", message: { content: "hello" } },
  ]));
  writeFileSync(join(dir, "newer.jsonl"), jsonl([
    { type: "user", timestamp: "2026-01-02T00:00:00.000Z", message: { content: "first prompt" } },
    { type: "assistant", timestamp: "2026-01-02T00:00:01.000Z", message: { content: [{ type: "text", text: "first reply" }] } },
    // noise that must be skipped:
    { type: "user", isMeta: true, message: { content: "meta line" } },
    { type: "user", timestamp: "2026-01-02T00:00:02.000Z", message: { content: "<tool_result>stuff</tool_result>" } },
    { type: "summary", message: { content: "ignored" } },
    { type: "assistant", timestamp: "2026-01-02T00:00:03.000Z", message: { content: [{ type: "tool_use", name: "Bash" }] } },
    { type: "user", timestamp: "2026-01-02T00:00:04.000Z", message: { content: "second prompt" } },
  ]));
  const t1 = new Date("2026-01-01T00:00:00Z").getTime() / 1000;
  const t2 = new Date("2026-01-02T00:00:00Z").getTime() / 1000;
  utimesSync(join(dir, "older.jsonl"), t1, t1);
  utimesSync(join(dir, "newer.jsonl"), t2, t2);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("joy-list-logs", () => {
  it("lists transcripts newest-first with size + mtime", async () => {
    const r = (await listLogs.handler(reg, { directory: TEST_CWD }, { via: "rpc" })) as any;
    expect(r.ok).toBe(true);
    expect(r.logs.map((l: any) => l.sessionId)).toEqual(["newer", "older"]);
    expect(r.logs[0].sizeBytes).toBeGreaterThan(0);
    expect(r.logs[0].mtimeMs).toBeGreaterThan(r.logs[1].mtimeMs);
  });

  it("requires a directory and tolerates a missing dir", async () => {
    expect((await listLogs.handler(reg, {}, { via: "rpc" })) as any).toMatchObject({ ok: false });
    const r = (await listLogs.handler(reg, { directory: "/no/such/dir" }, { via: "rpc" })) as any;
    expect(r).toEqual({ ok: true, directory: "/no/such/dir", logs: [] });
  });
});

describe("joy-read-log", () => {
  it("returns only real user prompts + assistant text, newest last", async () => {
    const r = (await readLog.handler(reg, { directory: TEST_CWD, sessionId: "newer", limit: 10 }, { via: "rpc" })) as any;
    expect(r.ok).toBe(true);
    expect(r.messages).toEqual([
      { role: "user", text: "first prompt", ts: Date.parse("2026-01-02T00:00:00.000Z") },
      { role: "assistant", text: "first reply", ts: Date.parse("2026-01-02T00:00:01.000Z") },
      { role: "user", text: "second prompt", ts: Date.parse("2026-01-02T00:00:04.000Z") },
    ]);
  });

  it("honors the limit (keeps the newest)", async () => {
    const r = (await readLog.handler(reg, { directory: TEST_CWD, sessionId: "newer", limit: 1 }, { via: "rpc" })) as any;
    expect(r.messages).toHaveLength(1);
    expect(r.messages[0].text).toBe("second prompt");
  });

  it("blocks path traversal and missing files", async () => {
    expect((await readLog.handler(reg, { directory: TEST_CWD, sessionId: "../escape" }, { via: "rpc" })) as any).toMatchObject({ ok: false, error: "invalid sessionId" });
    expect((await readLog.handler(reg, { directory: TEST_CWD, sessionId: "ghost" }, { via: "rpc" })) as any).toMatchObject({ ok: false, error: "log not found" });
    expect((await readLog.handler(reg, { directory: TEST_CWD }, { via: "rpc" })) as any).toMatchObject({ ok: false });
  });
});
