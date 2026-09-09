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

// The ai-title dedupe used to live only in memory, so every restart replayed
// Claude's endlessly-repeated stale title, saw it as new, and stomped the
// agent's <joy-title> back to a title from days ago.
test("lastAiTitle survives a restart and merges without clobbering the lock", () => {
  saveWindowRecord("ttl00001", { launchCwd: "/w", titleLockedByUser: false }, dir);
  saveWindowRecord("ttl00001", { lastAiTitle: "Disable suggestions" }, dir);
  const rec = loadWindowRecord("ttl00001", dir);
  expect(rec?.lastAiTitle).toBe("Disable suggestions");
  expect(rec?.launchCwd).toBe("/w");

  saveWindowRecord("ttl00001", { titleLockedByUser: true }, dir);
  expect(loadWindowRecord("ttl00001", dir)?.lastAiTitle).toBe("Disable suggestions");
});

// saveWindowRecord assembles its output field by field, so a key added to the
// patch TYPE but not to that object typechecks and is silently dropped —
// which is how the mute first shipped: the op answered {ok:true} and the flag
// was gone by the next read (caught live, not by a test).
test("notificationsMuted round-trips, and an unmute is recorded rather than forgotten", () => {
  saveWindowRecord("aa11bb22", { launchCwd: "/w" }, dir);
  saveWindowRecord("aa11bb22", { notificationsMuted: true }, dir);
  expect(loadWindowRecord("aa11bb22", dir)?.notificationsMuted).toBe(true);

  // An unrelated patch must not drop it.
  saveWindowRecord("aa11bb22", { claudeSessionId: "c1" }, dir);
  expect(loadWindowRecord("aa11bb22", dir)?.notificationsMuted).toBe(true);

  // false is a value, not an absence: the unmute has to stick.
  saveWindowRecord("aa11bb22", { notificationsMuted: false }, dir);
  expect(loadWindowRecord("aa11bb22", dir)?.notificationsMuted).toBe(false);
  saveWindowRecord("aa11bb22", { claudeSessionId: "c2" }, dir);
  expect(loadWindowRecord("aa11bb22", dir)?.notificationsMuted).toBe(false);
});
