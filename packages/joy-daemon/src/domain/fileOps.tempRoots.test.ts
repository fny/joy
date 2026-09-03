import { test, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { validatePath, readRoots, TEMP_ROOTS, handleReadFile, handleWriteFile, handleDeleteFile } from "./fileOps";

// /tmp is readable from the app in every session (agents hand out <joy-file>
// links to files they wrote there), but ONLY readable: write and delete stay
// jailed to the session cwd.

const cwd = mkdtempSync(join(tmpdir(), "joy-cwd-"));
const outside = mkdtempSync(join(tmpdir(), "joy-tmpfile-"));
const file = join(outside, "report.txt");
writeFileSync(file, "hello from /tmp");

test("TEMP_ROOTS lists /tmp and the platform tmpdir, once each", () => {
  expect(TEMP_ROOTS).toContain("/tmp");
  expect(TEMP_ROOTS).toContain(tmpdir());
  expect(new Set(TEMP_ROOTS).size).toBe(TEMP_ROOTS.length);
});

test("a temp file is outside the cwd jail without extra roots, inside it with readRoots()", () => {
  expect(validatePath(file, cwd).valid).toBe(false);
  const ok = validatePath(file, cwd, readRoots());
  expect(ok.valid).toBe(true);
  expect(ok.resolvedPath).toBe(realpathSync(file));
});

test("readRoots keeps the caller's per-session roots ahead of the temp dirs", () => {
  const roots = readRoots(["/some/session/dir"]);
  expect(roots[0]).toBe("/some/session/dir");
  for (const t of TEMP_ROOTS) expect(roots).toContain(t);
});

test("read works through the temp root; write and delete there are still refused", async () => {
  const read = await handleReadFile(cwd, { path: file } as any, readRoots());
  expect(read.success).toBe(true);

  const write = await handleWriteFile(cwd, { path: join(outside, "new.txt"), content: "x" } as any);
  expect(write.success).toBe(false);
  expect(String(write.error)).toMatch(/outside the working directory/);

  const del = await handleDeleteFile(cwd, { path: file } as any);
  expect(del.success).toBe(false);
  expect(String(del.error)).toMatch(/outside the working directory/);
});

test.sequential("cleanup", () => {
  rmSync(cwd, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});
