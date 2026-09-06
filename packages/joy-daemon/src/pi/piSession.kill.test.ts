// #567 residual — an adapter's kill must PROPAGATE a record deletion that
// could not durably land (unlink AND tombstone refused). PiSession is the
// lightest adapter to construct; the same three lines were changed in the
// claude, codex, opencode and agy sessions. Runs against a throwaway
// JOY_HOME_DIR so no live daemon state is touched.
import { test, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let home: string;
const realHome = process.env.JOY_HOME_DIR;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "joy-pi-kill-")); process.env.JOY_HOME_DIR = home; });
afterEach(() => { vi.restoreAllMocks(); if (realHome === undefined) delete process.env.JOY_HOME_DIR; else process.env.JOY_HOME_DIR = realHome; rmSync(home, { recursive: true, force: true }); });

const eacces = () => Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
const deps = { relayClient: null, broadcast: () => {}, addChatMessage: () => {} };

test("forceKill on a detached pi session: unlink + tombstone both refused → recordTerminated() is false; a repeat kill retries and clears it", async () => {
  const { PiSession } = await import("./piSession");
  const { saveWindowRecord, loadWindowRecord } = await import("../domain/windowRecord");
  const { defaultStateDir } = await import("../domain/receipts");
  const defaultRecordFile = (sid: string) => join(defaultStateDir(), `window-${sid}.json`);
  const id = "p1a2b3c4";
  expect(saveWindowRecord(id, { launchCwd: home, agent: "pi", piSettings: { sessionId: "x" } })).toBe(true);
  const s = new PiSession({ id, cwd: home, status: "ended", startedAt: Date.now() }, deps as never);
  expect(s.recordTerminated()).toBe(true); // nothing has failed yet

  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  vi.spyOn(fs, "rmSync").mockImplementation(() => { throw eacces(); });
  vi.spyOn(fs, "renameSync").mockImplementation(() => { throw eacces(); }); // blocks the tombstone write too
  expect(s.forceKill()).toBe(true);           // the teardown itself proceeds...
  expect(s.endReason).toBe("killed");
  expect(s.recordTerminated()).toBe(false);   // ...but the kill is NOT durably committed
  expect(existsSync(defaultRecordFile(id))).toBe(true);
  expect(loadWindowRecord(id)).toBeNull();    // hidden in this process only

  vi.restoreAllMocks();
  // The state dir works again: a second kill of the same (ended) session
  // retries the delete and the marker lands.
  expect(s.forceKill()).toBe(true);
  expect(s.recordTerminated()).toBe(true);
  expect(existsSync(defaultRecordFile(id))).toBe(false);
});
