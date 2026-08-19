// deleteFile is the one file op that DESTROYS data, so its guard rails get
// their own coverage: the cwd jail, the directory refusal, and honest
// reporting when the target isn't there.
import { test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { handleDeleteFile } from "./fileOps";

let cwd: string;

beforeEach(() => { cwd = mkdtempSync(join(tmpdir(), "joy-del-")); });
afterEach(() => { rmSync(cwd, { recursive: true, force: true }); });

test("deletes a file inside the session cwd", async () => {
  const f = join(cwd, "notes.txt");
  writeFileSync(f, "bye");
  const res = await handleDeleteFile(cwd, { path: "notes.txt" });
  expect(res.success).toBe(true);
  expect(existsSync(f)).toBe(false);
});

test("refuses to escape the cwd jail", async () => {
  const outside = mkdtempSync(join(tmpdir(), "joy-outside-"));
  const victim = join(outside, "keepme.txt");
  writeFileSync(victim, "important");
  try {
    const res = await handleDeleteFile(cwd, { path: victim });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/outside the working directory/i);
    expect(existsSync(victim)).toBe(true); // untouched
    // traversal form is rejected too
    expect((await handleDeleteFile(cwd, { path: "../../etc/hosts" })).success).toBe(false);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test("refuses directories — no recursive removal via this op", async () => {
  const dir = join(cwd, "src");
  mkdirSync(dir);
  writeFileSync(join(dir, "a.ts"), "x");
  const res = await handleDeleteFile(cwd, { path: "src" });
  expect(res.success).toBe(false);
  expect(res.error).toMatch(/directory/i);
  expect(existsSync(dir)).toBe(true);
});

test("missing file reports failure rather than a silent success", async () => {
  const res = await handleDeleteFile(cwd, { path: "ghost.txt" });
  expect(res.success).toBe(false);
  expect(res.error).toMatch(/does not exist/i);
});
