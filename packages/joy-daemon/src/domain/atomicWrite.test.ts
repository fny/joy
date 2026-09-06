// writeFileAtomic — the shared durable-write primitive (Wave A2). Every test
// injects the failure through vi.spyOn on the default `fs` object, which is
// the object atomicWrite.ts calls into; the assertion in each case is the
// same: the previous complete contents (and the previous backup) survive.
import { test, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeFileAtomic, writeFileAtomicAsync, AtomicWriteError } from "./atomicWrite";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "atomic-write-")); });
afterEach(() => { vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });

const enospc = () => Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
/** No stray temp/staging files may remain beside the destination. */
const leftovers = () => readdirSync(dir).filter((f) => f.startsWith("."));

test("plain replace: new contents land, no temp files remain", () => {
  const p = join(dir, "a.json");
  writeFileAtomic(p, "one");
  writeFileAtomic(p, "two");
  expect(readFileSync(p, "utf8")).toBe("two");
  expect(leftovers()).toEqual([]);
});

test("creates missing parent directories", () => {
  const p = join(dir, "deep", "er", "a.json");
  writeFileAtomic(p, "x");
  expect(readFileSync(p, "utf8")).toBe("x");
});

test("ENOSPC mid-write (writeSync throws): destination keeps its previous complete contents", () => {
  const p = join(dir, "spool.json");
  writeFileSync(p, '["acked-1","acked-2"]');
  vi.spyOn(fs, "writeSync").mockImplementation(() => { throw enospc(); });
  let err: unknown;
  try { writeFileAtomic(p, '["acked-1","acked-2","new-3"]'); } catch (e) { err = e; }
  expect(err).toBeInstanceOf(AtomicWriteError);
  expect((err as AtomicWriteError).phase).toBe("write");
  expect((err as AtomicWriteError).code).toBe("ENOSPC");
  expect(readFileSync(p, "utf8")).toBe('["acked-1","acked-2"]');
  expect(leftovers()).toEqual([]);
});

test("rename failure: destination untouched, temp removed", () => {
  const p = join(dir, "cfg.json");
  writeFileSync(p, "{\"good\":true}");
  vi.spyOn(fs, "renameSync").mockImplementation(() => { throw enospc(); });
  expect(() => writeFileAtomic(p, "{\"new\":true}")).toThrow(/during rename/);
  expect(readFileSync(p, "utf8")).toBe("{\"good\":true}");
  expect(leftovers()).toEqual([]);
});

test("fsync failure is a failure (the durability contract), destination untouched", () => {
  const p = join(dir, "cfg.json");
  writeFileSync(p, "old");
  vi.spyOn(fs, "fsyncSync").mockImplementation(() => { throw Object.assign(new Error("EIO"), { code: "EIO" }); });
  expect(() => writeFileAtomic(p, "new")).toThrow(/during fsync/);
  expect(readFileSync(p, "utf8")).toBe("old");
  expect(leftovers()).toEqual([]);
});

// #527 — the backup is rotated ONLY by a successful replacement. Two failed
// writes in a row must leave both the live file and the backup as they were;
// the old code copied the (possibly truncated) live file over the backup
// BEFORE attempting the write, so the second failure destroyed the only copy.
test("backup mode: a failed write never touches the previous intact backup — even when retried", () => {
  const p = join(dir, "settings.json");
  const bak = p + ".joy-bak";
  writeFileSync(bak, "generation-0");
  writeFileSync(p, "generation-1");
  const spy = vi.spyOn(fs, "writeSync").mockImplementation(() => { throw enospc(); });
  expect(() => writeFileAtomic(p, "generation-2", { backup: true })).toThrow(AtomicWriteError);
  expect(() => writeFileAtomic(p, "generation-2", { backup: true })).toThrow(AtomicWriteError);
  expect(readFileSync(p, "utf8")).toBe("generation-1");
  expect(readFileSync(bak, "utf8")).toBe("generation-0");
  spy.mockRestore();
  // The retry that succeeds rotates: backup = the last live version.
  const r = writeFileAtomic(p, "generation-2", { backup: true });
  expect(r.backupRotated).toBe(true);
  expect(readFileSync(p, "utf8")).toBe("generation-2");
  expect(readFileSync(bak, "utf8")).toBe("generation-1");
  expect(leftovers()).toEqual([]);
});

test("backup mode: explicit backup path; a fresh destination rotates nothing", () => {
  const p = join(dir, "f.toml");
  const bak = join(dir, "f.previous");
  expect(writeFileAtomic(p, "v1", { backup: bak }).backupRotated).toBe(false);
  expect(existsSync(bak)).toBe(false);
  expect(writeFileAtomic(p, "v2", { backup: bak }).backupRotated).toBe(true);
  expect(readFileSync(bak, "utf8")).toBe("v1");
});

test("backup staging failure (link AND copy fail) leaves destination and backup untouched", () => {
  const p = join(dir, "f.json");
  writeFileSync(p, "live");
  writeFileSync(p + ".joy-bak", "bak");
  vi.spyOn(fs, "linkSync").mockImplementation(() => { throw Object.assign(new Error("EPERM"), { code: "EPERM" }); });
  vi.spyOn(fs, "copyFileSync").mockImplementation(() => { throw enospc(); });
  expect(() => writeFileAtomic(p, "next", { backup: true })).toThrow(/during backup/);
  expect(readFileSync(p, "utf8")).toBe("live");
  expect(readFileSync(p + ".joy-bak", "utf8")).toBe("bak");
  expect(leftovers()).toEqual([]);
});

test("preserves the existing file's mode bits across the inode swap", () => {
  const p = join(dir, "run.sh");
  writeFileSync(p, "#!/bin/sh\n");
  chmodSync(p, 0o755);
  writeFileAtomic(p, "#!/bin/sh\necho hi\n");
  expect(statSync(p).mode & 0o777).toBe(0o755);
});

test("async twin: rename failure leaves the previous complete contents (#539 shape)", async () => {
  const p = join(dir, "src.ts");
  writeFileSync(p, "export const a = 1;\n");
  vi.spyOn(fs.promises, "rename").mockRejectedValue(enospc());
  await expect(writeFileAtomicAsync(p, "export const a = 2;\n")).rejects.toBeInstanceOf(AtomicWriteError);
  expect(readFileSync(p, "utf8")).toBe("export const a = 1;\n");
  expect(leftovers()).toEqual([]);
});

test("async twin: success + backup rotation", async () => {
  const p = join(dir, "src.ts");
  writeFileSync(p, "v1");
  const r = await writeFileAtomicAsync(p, Buffer.from("v2"), { backup: true });
  expect(r.backupRotated).toBe(true);
  expect(readFileSync(p, "utf8")).toBe("v2");
  expect(readFileSync(p + ".joy-bak", "utf8")).toBe("v1");
  expect(leftovers()).toEqual([]);
});

// #527 residual (Astra): a symlinked destination must be written THROUGH.
// Renaming over the link replaced it with a regular file, and link(2) on the
// link made the backup a second symlink to the overwritten target.
test("symlinked destination: link survives, real target replaced, backup is a COPY of the old contents (#527)", () => {
  const managed = join(dir, "dotfiles", "settings.json");
  fs.mkdirSync(join(dir, "dotfiles"));
  writeFileSync(managed, '{"gen":1}');
  const link = join(dir, "settings.json");
  fs.symlinkSync(managed, link);

  writeFileAtomic(link, '{"gen":2}', { backup: true });

  expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);           // the link is intact...
  expect(fs.readlinkSync(link)).toBe(managed);                      // ...and still points at the managed file
  expect(readFileSync(managed, "utf8")).toBe('{"gen":2}');          // which holds the new contents
  const bak = link + ".joy-bak";
  expect(fs.lstatSync(bak).isSymbolicLink()).toBe(false);           // the backup is a real file, not a link
  expect(readFileSync(bak, "utf8")).toBe('{"gen":1}');              // with the previous generation
  expect(leftovers()).toEqual([]);
  expect(readdirSync(join(dir, "dotfiles")).filter((f) => f.startsWith("."))).toEqual([]);
});

test("symlinked destination (async twin) and a relative link target", async () => {
  fs.mkdirSync(join(dir, "real"));
  writeFileSync(join(dir, "real", "cfg.toml"), "a = 1\n");
  const link = join(dir, "cfg.toml");
  fs.symlinkSync(join("real", "cfg.toml"), link); // relative link
  await writeFileAtomicAsync(link, "a = 2\n", { backup: true });
  expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
  expect(readFileSync(join(dir, "real", "cfg.toml"), "utf8")).toBe("a = 2\n");
  expect(fs.lstatSync(link + ".joy-bak").isSymbolicLink()).toBe(false);
  expect(readFileSync(link + ".joy-bak", "utf8")).toBe("a = 1\n");
});

test("a DANGLING symlink is resolved to the place it points at; writing there makes the link valid", () => {
  const link = join(dir, "dangling.json");
  fs.symlinkSync(join(dir, "elsewhere", "target.json"), link);
  writeFileAtomic(link, "{}", { backup: true }); // no previous file → nothing to back up
  expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
  expect(readFileSync(link, "utf8")).toBe("{}");
  expect(existsSync(link + ".joy-bak")).toBe(false);
});
