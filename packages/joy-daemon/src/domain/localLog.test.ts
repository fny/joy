import { describe, it, expect, beforeEach } from "vitest";
import { appendFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendLocalRecord, lastLocalRecords, localHeadSeq, pageLocalRecords, subscribeLocalLog, _resetLocalLog } from "./localLog";
import { isLocalOnly, markLocalOnly, _resetLocalOnly } from "./localOnly";
import { saveWindowRecord } from "./windowRecord";
import { joySessionDir } from "../paths";

beforeEach(() => {
  process.env.JOY_HOME_DIR = mkdtempSync(join(tmpdir(), "joy-locallog-"));
  _resetLocalLog(); _resetLocalOnly();
});

describe("local event log", () => {
  it("numbers records from 1 without gaps and pages them like the relay log", () => {
    for (let i = 1; i <= 5; i++) appendLocalRecord("s1", { n: i }, 1000 + i);
    expect(localHeadSeq("s1")).toBe(5);
    expect(pageLocalRecords("s1", { after: 3 }).map((r) => r.seq)).toEqual([4, 5]);
    expect(pageLocalRecords("s1", { before: 4, limit: 2 }).map((r) => r.seq)).toEqual([2, 3]);
    expect(pageLocalRecords("s1", { limit: 2 }).map((r) => r.seq)).toEqual([1, 2]);
    expect(lastLocalRecords("s1", 2).map((r) => r.seq)).toEqual([4, 5]);
    expect(pageLocalRecords("s1", { after: 4 })[0]).toEqual({ seq: 5, at: 1005, record: { n: 5 } });
  });

  it("survives a restart (read back from disk) and skips a torn last line", () => {
    appendLocalRecord("s2", { a: 1 });
    appendLocalRecord("s2", { a: 2 });
    appendFileSync(join(joySessionDir("s2"), "records.jsonl"), '{"seq":3,"at":1,"rec'); // crash mid-write
    _resetLocalLog();
    expect(localHeadSeq("s2")).toBe(2);
    expect(appendLocalRecord("s2", { a: 3 })).toBe(3);
  });

  it("tells subscribers about each append, until they unsubscribe", () => {
    const seen: number[] = [];
    const off = subscribeLocalLog("s3", (r) => seen.push(r.seq));
    appendLocalRecord("s3", {}); appendLocalRecord("s3", {});
    off();
    appendLocalRecord("s3", {});
    expect(seen).toEqual([1, 2]);
  });
});

describe("local-only flag", () => {
  it("is known from the mark before the session has a record, and from the record after a restart", () => {
    expect(isLocalOnly("x1")).toBe(false);
    markLocalOnly("x2");
    expect(isLocalOnly("x2")).toBe(true);
    saveWindowRecord("x3", { launchCwd: "/tmp", localOnly: true });
    _resetLocalOnly();
    expect(isLocalOnly("x3")).toBe(true);
  });
});
