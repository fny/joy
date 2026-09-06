// #563 residual — the launch record (launch cwd + the Claude id pinned with
// --session-id) must be on disk BEFORE the launch command is typed into the
// pane. The tmux driver is replaced by a fake that stops the create at the
// launch boundary: it inspects the persisted records the moment the claude
// command arrives, then refuses it so nothing is ever spawned. Runs against a
// throwaway JOY_HOME_DIR.
import { test, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const ok = { ok: true, out: "" };

/** What the fake driver saw at the launch boundary. */
const seen: { launchCmd: string | null; recordsAtLaunch: unknown[] } = { launchCmd: null, recordsAtLaunch: [] };

vi.mock("../tmux/driver", async () => {
  const wr = await import("./windowRecord");
  const fake = {
    runSync: (...args: string[]) => (args[0] === "has-session" ? { ok: false, out: "" } : ok),
    command: async () => ok,
    commandOnce: async () => ok,
    key: async () => ok,
    literal: async (_target: string, text: string) => {
      if (/\bclaude\b/.test(text) && /--session-id|--resume/.test(text)) {
        // The launch boundary: what is on disk RIGHT NOW is what a crash here
        // would leave for recovery.
        seen.launchCmd = text;
        seen.recordsAtLaunch = wr.listWindowRecords();
        return { ok: false, out: "", error: "test: launch refused at the boundary" };
      }
      return ok;
    },
    dispose: () => {},
  };
  return { tmux: fake, tmuxHandleFor: () => fake, disposeTmuxHandle: () => {}, TmuxDriver: class {} };
});

let home: string;
let cwd: string;
const realHome = process.env.JOY_HOME_DIR;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "joy-registry-create-"));
  cwd = join(home, "project"); fs.mkdirSync(cwd);
  process.env.JOY_HOME_DIR = home;
  seen.launchCmd = null; seen.recordsAtLaunch = [];
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});
afterEach(() => { vi.restoreAllMocks(); if (realHome === undefined) delete process.env.JOY_HOME_DIR; else process.env.JOY_HOME_DIR = realHome; rmSync(home, { recursive: true, force: true }); });

test("the record with the pinned Claude id exists BEFORE the launch command is issued (#563)", async () => {
  const { SessionRegistry } = await import("./registry");
  const { listWindowRecords } = await import("./windowRecord");
  const reg = new SessionRegistry({ tmuxSession: "joy-test", relayClient: null });
  await expect(reg.create({ cwd })).rejects.toThrow(/session create failed: launch-claude/);

  expect(seen.launchCmd).not.toBeNull();
  const pinned = /--session-id ([0-9a-f-]{36})/.exec(seen.launchCmd!)?.[1];
  expect(pinned).toBeTruthy();
  // At the moment the launch was typed, exactly one record existed, carrying
  // the same id the command pins and the launch cwd.
  expect(seen.recordsAtLaunch).toHaveLength(1);
  expect(seen.recordsAtLaunch[0]).toMatchObject({ launchCwd: cwd, claudeSessionId: pinned, claudePermissionMode: "bypassPermissions" });
  // The refused launch left no record behind to be recovered as a session.
  expect(listWindowRecords()).toEqual([]);
}, 20_000);

test("a launch record that cannot be persisted refuses the launch — nothing is typed into the pane", async () => {
  const { SessionRegistry } = await import("./registry");
  const reg = new SessionRegistry({ tmuxSession: "joy-test", relayClient: null });
  // The state dir refuses the record write (rename is the atomic writer's
  // landing step). Everything the create needs before that point (hook
  // settings) was written by the previous test in this file.
  // Only the launch RECORD's rename fails: other atomic writes on the create
  // path (the options prompt, since #473) must succeed so the assertion is
  // about the record, not the first writer that happens to run.
  const realRename = fs.renameSync;
  const rename = vi.spyOn(fs, "renameSync").mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
    if (String(to).includes("window-")) throw Object.assign(new Error("EROFS: read-only file system"), { code: "EROFS" });
    return realRename(from, to);
  }) as typeof fs.renameSync);
  await expect(reg.create({ cwd })).rejects.toThrow(/could not persist the launch record/);
  rename.mockRestore();
  expect(seen.launchCmd).toBeNull();
}, 20_000);

test("a launch binding a transcript a teleport import is replacing is refused before anything is spawned; the import's own launch adopts the claim (#550 residual)", async () => {
  const { SessionRegistry } = await import("./registry");
  const { claimTranscript, transcriptClaims, resetTranscriptClaims } = await import("./transcriptClaims");
  const { cwdToTranscriptDir } = await import("../claude/transcript");
  const { listWindowRecords } = await import("./windowRecord");
  resetTranscriptClaims();
  const dir = cwdToTranscriptDir(cwd); fs.mkdirSync(dir, { recursive: true });
  const sid = "abc-5507-0000"; const target = join(dir, `${sid}.jsonl`); fs.writeFileSync(target, "{}\n");
  try {
    const reg = new SessionRegistry({ tmuxSession: "joy-test", relayClient: null });
    const importing = claimTranscript(target, "teleport-import:abc-5507", "replace")!;
    await expect(reg.create({ cwd, resume_id: sid, forkSession: true, forceNew: true })).rejects.toThrow(/being replaced by a teleport import/);
    expect(seen.launchCmd).toBeNull();                 // refused before the tmux setup, never typed
    expect(listWindowRecords()).toEqual([]);           // and before the launch record
    // The import's own launch carries the claim: it reaches the launch boundary,
    // and its abort releases only the registry's OWN bind claims — never the
    // import's, which the import releases when it returns.
    await expect(reg.create({ cwd, resume_id: sid, forkSession: true, forceNew: true, transcriptClaim: importing })).rejects.toThrow(/session create failed: launch-claude/);
    expect(seen.launchCmd).toMatch(/--resume abc-5507-0000 --fork-session/);
    expect(importing.held()).toBe(true);
    expect(transcriptClaims(target)).toEqual([importing]);
    importing.release();
    // Released: a fork of the conversation binds again, and its bind claim goes with the aborted create.
    seen.launchCmd = null;
    await expect(reg.create({ cwd, resume_id: sid, forkSession: true, forceNew: true })).rejects.toThrow(/session create failed: launch-claude/);
    expect(seen.launchCmd).toMatch(/--resume abc-5507-0000/);
    expect(transcriptClaims(target)).toEqual([]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}, 20_000);
