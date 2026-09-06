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

/** What the fake driver saw at the launch boundary; `atLaunch` runs there
 *  (a test's probe of the state a concurrent import would find). */
const seen: { launchCmd: string | null; recordsAtLaunch: unknown[]; atLaunch: (() => void | Promise<void>) | null } = { launchCmd: null, recordsAtLaunch: [], atLaunch: null };

vi.mock("../tmux/driver", async () => {
  const wr = await import("./windowRecord");
  const fake = {
    runSync: (...args: string[]) => (args[0] === "has-session" ? { ok: false, out: "" } : ok),
    command: async () => ok,
    commandOnce: async () => ok,
    key: async () => ok,
    literal: async (_target: string, text: string) => {
      if (/\bclaude\b/.test(text) && /--session-id|--resume|--continue/.test(text)) {
        // The launch boundary: what is on disk RIGHT NOW is what a crash here
        // would leave for recovery.
        seen.launchCmd = text;
        seen.recordsAtLaunch = wr.listWindowRecords();
        await seen.atLaunch?.();
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
  seen.launchCmd = null; seen.recordsAtLaunch = []; seen.atLaunch = null;
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

test("a --continue launch whose newest project transcript a teleport import is replacing is refused before anything is spawned (#550 residual)", async () => {
  const { SessionRegistry } = await import("./registry");
  const { claimTranscript, transcriptClaims, resetTranscriptClaims } = await import("./transcriptClaims");
  const { cwdToTranscriptDir } = await import("../claude/transcript");
  const { listWindowRecords } = await import("./windowRecord");
  resetTranscriptClaims();
  const dir = cwdToTranscriptDir(cwd); fs.mkdirSync(dir, { recursive: true });
  // The only transcript in the project: what `claude --continue` would pick up.
  const target = join(dir, "abc-5508-0000.jsonl"); fs.writeFileSync(target, "{}\n");
  try {
    const reg = new SessionRegistry({ tmuxSession: "joy-test", relayClient: null });
    const importing = claimTranscript(target, "teleport-import:abc-5508", "replace")!;
    // Old code: no resume id → no pin → no claim → `claude --continue` reached the pane under the import's exclusive claim.
    await expect(reg.create({ cwd, continue: true, forceNew: true })).rejects.toThrow(/being replaced by a teleport import/);
    expect(seen.launchCmd).toBeNull();                 // refused before the tmux setup, never typed
    expect(listWindowRecords()).toEqual([]);           // and before the launch record
    expect(transcriptClaims(target)).toEqual([importing]);
    importing.release();
    // Released: the continuation launches, holding the selected transcript at the
    // launch boundary so an import of it is refused meanwhile; the aborted launch
    // takes its reservation with it.
    let importAtLaunch: unknown = "unset";
    seen.atLaunch = () => { importAtLaunch = claimTranscript(target, "teleport-import:abc-5508", "replace"); };
    await expect(reg.create({ cwd, continue: true, forceNew: true })).rejects.toThrow(/session create failed: launch-claude/);
    // Pinned to the reserved file by name, not left to Claude's own selection.
    expect(seen.launchCmd).toMatch(/--resume abc-5508-0000/);
    expect(seen.launchCmd).not.toContain("--continue");
    expect(importAtLaunch).toBeNull();
    expect(transcriptClaims(target)).toEqual([]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}, 20_000);

test("a --continue launch with nothing to select reserves the whole project dir for the launch window; an import of any transcript there is refused until it settles (#550 residual)", async () => {
  const { SessionRegistry } = await import("./registry");
  const { claimTranscript, transcriptClaims, resetTranscriptClaims } = await import("./transcriptClaims");
  const { cwdToTranscriptDir } = await import("../claude/transcript");
  resetTranscriptClaims();
  const dir = cwdToTranscriptDir(cwd); fs.mkdirSync(dir, { recursive: true }); // no transcripts yet
  const incoming = join(dir, "abc-5509-0000.jsonl");
  try {
    const reg = new SessionRegistry({ tmuxSession: "joy-test", relayClient: null });
    // An import already replacing a transcript in the dir refuses the continuation outright.
    const importing = claimTranscript(incoming, "teleport-import:abc-5509", "replace")!;
    await expect(reg.create({ cwd, continue: true, forceNew: true })).rejects.toThrow(/being replaced by a teleport import/);
    expect(seen.launchCmd).toBeNull();
    importing.release();
    // With none in flight the continuation launches; at the launch boundary the
    // project dir is reserved, so an import landing ANY transcript there is refused.
    let importAtLaunch: unknown = "unset";
    seen.atLaunch = () => {
      importAtLaunch = claimTranscript(incoming, "teleport-import:abc-5509", "replace");
      expect(transcriptClaims(incoming).map((c) => [c.path, c.mode])).toEqual([[dir, "bind"]]);
    };
    await expect(reg.create({ cwd, continue: true, forceNew: true })).rejects.toThrow(/session create failed: launch-claude/);
    expect(seen.launchCmd).toMatch(/--continue/);
    expect(importAtLaunch).toBeNull();
    // The aborted launch released the project reservation: the import proceeds.
    expect(transcriptClaims(incoming)).toEqual([]);
    expect(claimTranscript(incoming, "teleport-import:abc-5509", "replace")).not.toBeNull();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}, 20_000);

test("a plain --continue create with no import in flight still launches (#550 residual)", async () => {
  const { SessionRegistry } = await import("./registry");
  const { transcriptClaims, resetTranscriptClaims } = await import("./transcriptClaims");
  const { cwdToTranscriptDir } = await import("../claude/transcript");
  resetTranscriptClaims();
  const dir = cwdToTranscriptDir(cwd); fs.mkdirSync(dir, { recursive: true });
  const target = join(dir, "abc-5510-0000.jsonl"); fs.writeFileSync(target, "{}\n");
  try {
    const reg = new SessionRegistry({ tmuxSession: "joy-test", relayClient: null });
    seen.atLaunch = () => { expect(transcriptClaims(target).map((c) => c.mode)).toEqual(["bind"]); };
    await expect(reg.create({ cwd, continue: true, forceNew: true })).rejects.toThrow(/session create failed: launch-claude/);
    expect(seen.launchCmd).toMatch(/claude .*--resume abc-5510-0000/);
    expect(transcriptClaims(target)).toEqual([]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}, 20_000);

// ── #550: the reservation must survive the import's OWN ownership check, and
// the launch must continue exactly the file that was reserved. Both cases run
// the real import handler at the launch boundary of a real --continue create
// (only the import's launch is stubbed — it must never be reached).
async function importAtBoundary(reg: import("./registry").SessionRegistry, cwd: string, sid: string): Promise<Record<string, unknown>> {
  const { machineOps } = await import("./operations");
  const op = machineOps.find((o) => o.rpcName === "joy-teleport-import")!;
  return (await op.handler(reg, { cwd, claudeSessionId: sid, transcriptBase64: Buffer.from("IMPORTED UNDER A LIVE CONTINUATION\n").toString("base64") }, { via: "rpc" })) as Record<string, unknown>;
}

test("#550: a real teleport import at the launch boundary of a --continue create is refused — list() does not settle the in-flight reservation, the selected transcript keeps its bytes", async () => {
  const { SessionRegistry } = await import("./registry");
  const { transcriptClaims, resetTranscriptClaims } = await import("./transcriptClaims");
  const { cwdToTranscriptDir } = await import("../claude/transcript");
  resetTranscriptClaims();
  const dir = cwdToTranscriptDir(cwd); fs.mkdirSync(dir, { recursive: true });
  const sid = "abc-5511-0000"; const target = join(dir, `${sid}.jsonl`);
  fs.writeFileSync(target, "CONTINUED BY THE FIRST LAUNCH\n");
  try {
    const reg = new SessionRegistry({ tmuxSession: "joy-test", relayClient: null });
    const originalCreate = reg.create.bind(reg);
    // The import's launch is the only stub — and it must never run.
    const importLaunch = vi.spyOn(reg, "create").mockResolvedValue({ id: "fa005511", toJSON: () => ({}) } as never);
    const got: { result: Record<string, unknown> | null } = { result: null };
    seen.atLaunch = async () => {
      expect(transcriptClaims(target).map((c) => c.mode)).toEqual(["bind"]);
      got.result = await importAtBoundary(reg, cwd, sid);
      // Old code: registry.list() inside owned() released the reservation (no Session yet), ok:true, bytes replaced.
      expect(transcriptClaims(target).map((c) => c.mode)).toEqual(["bind"]);
      expect(fs.readFileSync(target, "utf8")).toBe("CONTINUED BY THE FIRST LAUNCH\n");
    };
    await expect(originalCreate({ cwd, continue: true, forceNew: true })).rejects.toThrow(/session create failed: launch-claude/);
    expect(got.result).not.toBeNull();
    expect(got.result!.error).toMatch(/belongs to a session whose transcript is/);
    expect(importLaunch).not.toHaveBeenCalled();
    expect(seen.launchCmd).toMatch(/--resume abc-5511-0000/);
    expect(fs.readFileSync(target, "utf8")).toBe("CONTINUED BY THE FIRST LAUNCH\n");
    expect(fs.readdirSync(dir).filter((f) => f.includes("joy-import"))).toEqual([]);
    // The aborted create released it through its own finally — the only place an absent Session means "aborted".
    expect(transcriptClaims(target)).toEqual([]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}, 20_000);

test("#550: the same import at the launch boundary of a --continue create in an EMPTY project is refused — the project reservation survives list(), nothing lands in the dir", async () => {
  const { SessionRegistry } = await import("./registry");
  const { transcriptClaims, resetTranscriptClaims } = await import("./transcriptClaims");
  const { cwdToTranscriptDir } = await import("../claude/transcript");
  resetTranscriptClaims();
  const dir = cwdToTranscriptDir(cwd); fs.mkdirSync(dir, { recursive: true }); // no transcripts
  const sid = "abc-5512-0000"; const incoming = join(dir, `${sid}.jsonl`);
  try {
    const reg = new SessionRegistry({ tmuxSession: "joy-test", relayClient: null });
    const originalCreate = reg.create.bind(reg);
    const importLaunch = vi.spyOn(reg, "create").mockResolvedValue({ id: "fa005512", toJSON: () => ({}) } as never);
    const got: { result: Record<string, unknown> | null } = { result: null };
    seen.atLaunch = async () => {
      expect(transcriptClaims(incoming).map((c) => [c.path, c.mode])).toEqual([[dir, "bind"]]);
      got.result = await importAtBoundary(reg, cwd, sid);
      expect(transcriptClaims(incoming).map((c) => [c.path, c.mode])).toEqual([[dir, "bind"]]);
      expect(fs.existsSync(incoming)).toBe(false);
    };
    await expect(originalCreate({ cwd, continue: true, forceNew: true })).rejects.toThrow(/session create failed: launch-claude/);
    expect(got.result!.error).toMatch(/belongs to a session whose transcript is/);
    expect(importLaunch).not.toHaveBeenCalled();
    expect(seen.launchCmd).toMatch(/--continue/); // nothing to pin: Claude's selection, under the project reservation
    expect(fs.readdirSync(dir)).toEqual([]);
    expect(transcriptClaims(incoming)).toEqual([]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}, 20_000);

test("#550: a replace claim taken on ANOTHER file after selection does not change what the launch continues — the command resumes the reserved transcript by id", async () => {
  const { SessionRegistry } = await import("./registry");
  const { claimTranscript, transcriptClaims, resetTranscriptClaims } = await import("./transcriptClaims");
  const { cwdToTranscriptDir, findLatestTranscript } = await import("../claude/transcript");
  resetTranscriptClaims();
  const dir = cwdToTranscriptDir(cwd); fs.mkdirSync(dir, { recursive: true });
  const oldSid = "b1930000-0000-4000-8000-000000000001", newSid = "b1930000-0000-4000-8000-000000000002";
  const reserved = join(dir, `${oldSid}.jsonl`), incoming = join(dir, `${newSid}.jsonl`);
  fs.writeFileSync(reserved, "{}\n"); fs.utimesSync(reserved, new Date(1000), new Date(1000));
  const other: { claim: ReturnType<typeof claimTranscript> } = { claim: null };
  try {
    const reg = new SessionRegistry({ tmuxSession: "joy-test", relayClient: null });
    seen.atLaunch = () => {
      expect(transcriptClaims(reserved).map((c) => c.mode)).toEqual(["bind"]);
      // An import of a DIFFERENT conversation lands a newer file in the project before the Enter.
      other.claim = claimTranscript(incoming, "teleport-import:other-file", "replace");
      expect(other.claim).not.toBeNull();
      fs.writeFileSync(incoming, "{}\n");
      expect(findLatestTranscript(dir, 0)).toBe(incoming);
      // Old code: `--continue` — Claude would have picked the import-owned file.
      expect(seen.launchCmd).toMatch(new RegExp(`--resume ${oldSid}`));
      expect(seen.launchCmd).not.toContain("--continue");
    };
    await expect(reg.create({ cwd, continue: true, forceNew: true })).rejects.toThrow(/session create failed: launch-claude/);
    expect(seen.launchCmd).toMatch(new RegExp(`--resume ${oldSid}`));
    expect(transcriptClaims(reserved)).toEqual([]);
  } finally { other.claim?.release(); fs.rmSync(dir, { recursive: true, force: true }); }
}, 20_000);
