// deleteFile is the one file op that DESTROYS data, so its guard rails get
// their own coverage: the cwd jail, the directory refusal, and honest
// reporting when the target isn't there.
import { test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, symlinkSync, lstatSync, readFileSync } from "fs";
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

test("deleting an in-jail symlink removes the LINK, not its target", async () => {
  writeFileSync(join(cwd, "important.txt"), "keep me");
  symlinkSync(join(cwd, "important.txt"), join(cwd, "alias"));
  const r = await handleDeleteFile(cwd, { path: "alias" });
  expect(r.success).toBe(true);
  // The link is gone; the real file survives with its contents.
  expect(existsSync(join(cwd, "alias"))).toBe(false);
  expect(readFileSync(join(cwd, "important.txt"), "utf8")).toBe("keep me");
});

test("refuses to delete a symlink whose target escapes the jail", async () => {
  const outside = mkdtempSync(join(tmpdir(), "joy-del-out-"));
  try {
    writeFileSync(join(outside, "secret.txt"), "s");
    symlinkSync(outside, join(cwd, "escape"));
    const r = await handleDeleteFile(cwd, { path: "escape/secret.txt" });
    expect(r.success).toBe(false);
    expect(existsSync(join(outside, "secret.txt"))).toBe(true);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});
