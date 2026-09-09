import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listAgyPastSessions, listPiPastSessions, parseAgyTime, piCwdKey, promptTitle } from "./pastSessions";

const root = mkdtempSync(join(tmpdir(), "joy-past-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("promptTitle", () => {
  it("unwraps a joy peer message, skips tool wrappers, clips", () => {
    expect(promptTitle('<joy-message from="cli">\nRemember the word zebra. Reply OK.\n</joy-message>')).toBe("Remember the word zebra. Reply OK.");
    expect(promptTitle("<environment_context>x</environment_context>")).toBeNull();
    expect(promptTitle("   ")).toBeNull();
    expect(promptTitle("a".repeat(100))!.length).toBe(60);
    expect(promptTitle("fix   the\nflaky test")).toBe("fix the flaky test");
  });
});

describe("pi past sessions", () => {
  it("derives pi's cwd key and lists the directory's session files, newest first, titled by the first prompt", () => {
    expect(piCwdKey("/tmp/joy-smoke")).toBe("--tmp-joy-smoke--");
    expect(piCwdKey("/home/claude/Vibe/hotbot/workspace")).toBe("--home-claude-Vibe-hotbot-workspace--");
    const cwd = "/proj/pi";
    const dir = join(root, "pi", piCwdKey(cwd));
    mkdirSync(dir, { recursive: true });
    const session = (id: string, c: string) => JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-09-05T19:14:36.886Z", cwd: c });
    const user = (text: string) => JSON.stringify({ type: "message", id: "m1", parentId: null, message: { role: "user", content: [{ type: "text", text }] } });
    const older = join(dir, "2026-09-01T00-00-00-000Z_aaaa.jsonl");
    const newer = join(dir, "2026-09-05T00-00-00-000Z_bbbb.jsonl");
    writeFileSync(older, session("aaaa", cwd) + "\n" + JSON.stringify({ type: "model_change", modelId: "x" }) + "\n" + user("Make me a markdown file") + "\n");
    writeFileSync(newer, session("bbbb", cwd) + "\n" + user('<joy-message from="cli">\nReply with PI-OK\n</joy-message>') + "\n");
    // A key collision: header cwd disagrees → not listed.
    writeFileSync(join(dir, "2026-09-06T00-00-00-000Z_cccc.jsonl"), session("cccc", "/proj/pi-other") + "\n");
    const t = Date.now();
    utimesSync(older, new Date(t - 60_000), new Date(t - 60_000));
    utimesSync(newer, new Date(t), new Date(t));
    const rows = listPiPastSessions(cwd, join(root, "pi"));
    expect(rows.map((r) => [r.id, r.title])).toEqual([["bbbb", "Reply with PI-OK"], ["aaaa", "Make me a markdown file"]]);
    expect(rows[0].sizeBytes).toBeGreaterThan(0);
    expect(listPiPastSessions("/proj/none", join(root, "pi"))).toEqual([]);
  });
});

describe("agy past sessions", () => {
  it("reads conversation_summaries.db, matched on the exact workspace uri, title falling back to preview", () => {
    const dir = join(root, "agy");
    mkdirSync(join(dir, "conversations"), { recursive: true });
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as { DatabaseSync: new (p: string) => { exec(sql: string): void; prepare(sql: string): { run(...a: unknown[]): unknown }; close(): void } };
    const db = new DatabaseSync(join(dir, "conversation_summaries.db"));
    db.exec("create table conversation_summaries (conversation_id text primary key, title text not null default '', preview text not null default '', last_modified_time datetime not null, workspace_uris text not null)");
    const ins = db.prepare("insert into conversation_summaries values (?, ?, ?, ?, ?)");
    ins.run("c-new", "", "Reviewing Project Code Quality", "2026-06-26 00:57:24.674405115+00:00", '["file:///w/joy"]');
    ins.run("c-old", "Fix the relay", "ignored", "2026-06-20 10:00:00+00:00", '["file:///w/joy","file:///w/other"]');
    ins.run("c-child", "", "child dir", "2026-06-27 00:00:00+00:00", '["file:///w/joy/sub"]');
    db.close();
    writeFileSync(join(dir, "conversations", "c-new.db"), "x".repeat(10));
    const rows = listAgyPastSessions("/w/joy", dir);
    expect(rows.map((r) => [r.id, r.title, r.sizeBytes])).toEqual([["c-new", "Reviewing Project Code Quality", 10], ["c-old", "Fix the relay", null]]);
    expect(rows[0].updatedAt).toBe(Date.parse("2026-06-26T00:57:24.674Z"));
    expect(listAgyPastSessions("/w/joy", join(root, "nowhere"))).toEqual([]);
  });

  it("parses agy's timestamp with a nine-digit fraction", () => {
    expect(parseAgyTime("2026-06-26 00:57:24.674405115+00:00")).toBe(Date.parse("2026-06-26T00:57:24.674Z"));
    expect(parseAgyTime("2026-06-26 00:57:24+02:00")).toBe(Date.parse("2026-06-26T00:57:24.000+02:00"));
    expect(parseAgyTime("garbage")).toBe(0);
  });
});
