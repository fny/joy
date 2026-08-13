import { test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { loadWindowRecord, saveWindowRecord } from "./windowRecord";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "winrec-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

test("missing record → null", () => {
  expect(loadWindowRecord("nope", dir)).toBeNull();
});

test("save launchCwd then merge claudeSessionId (round-trips, no clobber)", () => {
  saveWindowRecord("ab12cd34", { launchCwd: "/home/u/proj" }, dir);
  let rec = loadWindowRecord("ab12cd34", dir);
  expect(rec?.launchCwd).toBe("/home/u/proj");
  expect(rec?.claudeSessionId).toBeUndefined();

  // Learning the conversation id later must NOT wipe the launch cwd.
  saveWindowRecord("ab12cd34", { claudeSessionId: "uuid-1" }, dir);
  rec = loadWindowRecord("ab12cd34", dir);
  expect(rec?.launchCwd).toBe("/home/u/proj");
  expect(rec?.claudeSessionId).toBe("uuid-1");
});

test("no launchCwd ever → nothing persisted", () => {
  saveWindowRecord("zz", { claudeSessionId: "uuid-only" }, dir);
  expect(loadWindowRecord("zz", dir)).toBeNull();
});
