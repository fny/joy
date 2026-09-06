// #567 — a failed record deletion must not silently resurrect a session the
// user killed on purpose. The unlink is made to fail (EACCES injected on
// fs.rmSync); the record must then be invisible to load/list, survive a late
// non-launch patch as dead, and be swept when the delete works again.
import { test, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadWindowRecord, saveWindowRecord, deleteWindowRecord, listWindowRecords } from "./windowRecord";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "winrec-delete-")); });
afterEach(() => { vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });

const eacces = () => Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
const ID = "dead0001";
const file = () => join(dir, `window-${ID}.json`);

test("successful delete returns true and removes the file", () => {
  saveWindowRecord(ID, { launchCwd: "/w", agent: "opencode" }, dir);
  expect(deleteWindowRecord(ID, dir)).toBe(true);
  expect(existsSync(file())).toBe(false);
});

test("failed delete: reported, tombstoned, hidden from recovery (#567)", () => {
  saveWindowRecord(ID, { launchCwd: "/w", agent: "agy" }, dir);
  saveWindowRecord("0be00002", { launchCwd: "/other", agent: "codex" }, dir);
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const rm = vi.spyOn(fs, "rmSync").mockImplementation(() => { throw eacces(); });
  expect(deleteWindowRecord(ID, dir)).toBe(false);
  expect(String(stderr.mock.calls[0]?.[0])).toMatch(/delete failed/);
  // Still on disk (the unlink failed) but tombstoned...
  expect(existsSync(file())).toBe(true);
  expect(JSON.parse(readFileSync(file(), "utf-8")).killed).toBe(true);
  // ...and invisible to every recovery path. The live sibling is unaffected.
  expect(loadWindowRecord(ID, dir)).toBeNull();
  expect(listWindowRecords(dir).map((r) => r.id)).toEqual(["0be00002"]);
  rm.mockRestore();
  // The next scan retries the delete and it succeeds now.
  expect(listWindowRecords(dir).map((r) => r.id)).toEqual(["0be00002"]);
  expect(existsSync(file())).toBe(false);
});

test("a late non-launch patch (checkpoint timer) does not revive a tombstone; a real launch does", () => {
  saveWindowRecord(ID, { launchCwd: "/w", agent: "agy" }, dir);
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const rm = vi.spyOn(fs, "rmSync").mockImplementation(() => { throw eacces(); });
  deleteWindowRecord(ID, dir);
  rm.mockRestore();
  // The dying session's checkpoint timer fires after the kill.
  saveWindowRecord(ID, { transcriptCheckpoint: { path: "/t.jsonl", offset: 10 } }, dir);
  expect(loadWindowRecord(ID, dir)).toBeNull();
  expect(JSON.parse(readFileSync(file(), "utf-8")).killed).toBe(true);
  // A new launch under the same id (restart) is a live session again.
  saveWindowRecord(ID, { launchCwd: "/w2", agent: "agy" }, dir);
  const rec = loadWindowRecord(ID, dir);
  expect(rec?.launchCwd).toBe("/w2");
  expect(rec?.killed).toBeUndefined();
  expect(listWindowRecords(dir).map((r) => r.id)).toEqual([ID]);
});

test("delete AND tombstone both failing (read-only dir): still hidden in this process", () => {
  saveWindowRecord(ID, { launchCwd: "/w", agent: "opencode" }, dir);
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  vi.spyOn(fs, "rmSync").mockImplementation(() => { throw eacces(); });
  vi.spyOn(fs, "renameSync").mockImplementation(() => { throw eacces(); }); // blocks the tombstone write too
  expect(deleteWindowRecord(ID, dir)).toBe(false);
  expect(JSON.parse(readFileSync(file(), "utf-8")).killed).toBeUndefined(); // tombstone did not land
  expect(loadWindowRecord(ID, dir)).toBeNull();
  expect(listWindowRecords(dir)).toEqual([]);
});
