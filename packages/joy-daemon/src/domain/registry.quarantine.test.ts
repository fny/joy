// Boot quarantine (review 95c4781e): a session whose legacy source failed to
// import (ledgerImport.ts) is neither recovered nor created/restarted until
// the import completes on a later boot. The tmux driver and every process
// spawn are faked: recover() must not touch this machine's real servers.
import { test, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const ok = { ok: true, out: "" };
/** Every tmux driver call recover() made. */
const calls: string[][] = [];

vi.mock("../tmux/driver", () => {
  const fake = {
    runSync: (...args: string[]) => {
      calls.push(args);
      if (args[0] === "list-windows") return { ok: true, out: "j-aaaa0001\nj-bbbb0002\n" };
      if (args[0] === "has-session") return { ok: false, out: "" };
      return ok; // display-message → "" (no pane cwd, no pane pid)
    },
    command: async () => ok, commandOnce: async () => ok, key: async () => ok, literal: async () => ok, dispose: () => {},
  };
  return { tmux: fake, tmuxHandleFor: () => fake, disposeTmuxHandle: () => {}, TmuxDriver: class {} };
});
// No real process may be spawned (the orphan-server sweep, pid probes).
vi.mock("../tmux/shell", () => ({ run: () => ({ ok: false, out: "" }), tmuxArgv: () => ["tmux"], SYNC_RUN_TIMEOUT_MS: 8000 }));

let home: string;
let cwd: string;
let stderr: string[] = [];
const realHome = process.env.JOY_HOME_DIR;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "joy-registry-quarantine-"));
  cwd = join(home, "project"); fs.mkdirSync(cwd);
  process.env.JOY_HOME_DIR = home;
  calls.length = 0; stderr = [];
  vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => { stderr.push(String(chunk)); return true; }) as typeof process.stderr.write);
});
afterEach(() => { vi.restoreAllMocks(); if (realHome === undefined) delete process.env.JOY_HOME_DIR; else process.env.JOY_HOME_DIR = realHome; rmSync(home, { recursive: true, force: true }); });

test("a quarantined id is skipped by recover() (logged once), refused by create({ id }) and restart({ id }); other windows are still examined", async () => {
  const { SessionRegistry } = await import("./registry");
  const { saveWindowRecord, loadWindowRecord } = await import("./windowRecord");
  // Only the quarantined id has a record (a launch cwd): an unquarantined
  // window with one would be adopted for real, which needs a runtime.
  saveWindowRecord("aaaa0001", { launchCwd: cwd });
  const reg = new SessionRegistry({ tmuxSession: "joy-test", relayClient: null });
  reg.quarantine(["aaaa0001"], "legacy import failed");
  expect(reg.isQuarantined("aaaa0001")).toBe(true);
  expect(reg.isQuarantined("bbbb0002")).toBe(false);

  await reg.recover();
  await reg.recover(); // a second pass logs nothing new
  expect(reg.get("aaaa0001")).toBeUndefined();
  const probed = calls.filter((c) => c[0] === "display-message").map((c) => c[c.indexOf("-t") + 1]);
  expect(probed).not.toContain("joy-test:j-aaaa0001"); // never even looked at
  expect(probed).toContain("joy-test:j-bbbb0002"); // the gate is per id, not a recovery stop
  expect(stderr.filter((l) => l.includes("aaaa0001") && l.includes("quarantined"))).toHaveLength(1);

  await expect(reg.create({ id: "aaaa0001", cwd })).rejects.toThrow(/quarantined/);
  await expect(reg.restart({ id: "aaaa0001" })).rejects.toThrow(/quarantined/);
  // The refusal is a refusal, not a retirement: the record (the session's
  // identity, waiting for its import) is still there.
  expect(loadWindowRecord("aaaa0001")?.launchCwd).toBe(cwd);
  expect(reg.get("aaaa0001")).toBeUndefined();
});
