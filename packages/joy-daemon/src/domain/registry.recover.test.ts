// Registry recover / restart / create contracts (Wave F): a restart carries
// the CURRENT effort (#51), a per-session server is stamped with the owning
// daemon (#55), a recovered non-Claude session's card carries its flavor
// (#562), and a non-canonical cwd is canonicalised before the launch record
// and transcript path are built (#564). The tmux driver is a fake that stops
// every create at the launch boundary (nothing is ever spawned); the relay
// module's createRelaySession is a recording stub. Throwaway JOY_HOME_DIR.
import { test, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { syncBuiltinESMExports } from "node:module";

const ok = { ok: true, out: "" };
const seen: { launchCmd: string | null; recordsAtLaunch: unknown[]; runSync: string[][]; windows: string[] } = { launchCmd: null, recordsAtLaunch: [], runSync: [], windows: [] };

vi.mock("../tmux/driver", async () => {
  const wr = await import("./windowRecord");
  const fake = {
    runSync: (...args: string[]) => {
      seen.runSync.push(args);
      if (args[0] === "has-session") return { ok: false, out: "" };
      if (args[0] === "list-windows") return { ok: true, out: seen.windows.join("\n") };
      return ok;
    },
    command: async () => ok,
    commandOnce: async () => ok,
    key: async () => ok,
    literal: async (_target: string, text: string) => {
      if (/\bclaude\b/.test(text) && /--session-id|--resume|--continue/.test(text)) {
        seen.launchCmd = text;
        seen.recordsAtLaunch = wr.listWindowRecords();
        return { ok: false, out: "", error: "test: launch refused at the boundary" };
      }
      return ok;
    },
    captureCached: () => ({ ok: false, out: "" }),
    captureFresh: async () => ({ ok: false, out: "" }),
    track() {}, untrack() {},
    dispose: () => {},
  };
  return { tmux: fake, tmuxHandleFor: () => fake, disposeTmuxHandle: () => {}, TmuxDriver: class {} };
});

const relayCards: Array<Record<string, unknown>> = [];
vi.mock("../relay/relay.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("../relay/relay.ts")>();
  const stub = () => new Proxy({}, { get: (_t, k) => (k === "relaySessionId" ? "rs-stub" : k === "metadataSnapshot" ? null : k === "then" ? undefined : async () => {}) });
  return { ...real, createRelaySession: (_c: unknown, opts: Record<string, unknown>) => { relayCards.push(opts); return stub(); } };
});

let home: string;
let cwd: string;
const realHome = process.env.JOY_HOME_DIR;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "joy-registry-recover-"));
  cwd = join(home, "project"); fs.mkdirSync(cwd);
  process.env.JOY_HOME_DIR = home;
  seen.launchCmd = null; seen.recordsAtLaunch = []; seen.runSync = []; seen.windows = []; relayCards.length = 0;
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});
afterEach(async () => {
  const { closeAllLedgers } = await import("./ledger");
  const { resetCoordinators } = await import("./coordinator");
  resetCoordinators(); closeAllLedgers();
  vi.restoreAllMocks(); syncBuiltinESMExports(); // a homedir spy reaches paths.ts's ESM binding; undo it there too
  if (realHome === undefined) delete process.env.JOY_HOME_DIR; else process.env.JOY_HOME_DIR = realHome;
  rmSync(home, { recursive: true, force: true });
});

// ── #51 ─────────────────────────────────────────────────────────────────────

test("#51 restart relaunches with the CURRENT effort, not the launch-time one", async () => {
  const { SessionRegistry } = await import("./registry");
  const { saveWindowRecord } = await import("./windowRecord");
  const id = "c1a00051";
  saveWindowRecord(id, { launchCwd: cwd });
  seen.windows = [`j-${id}`];
  const reg = new SessionRegistry({ tmuxSession: "joy-test", relayClient: null });
  await reg.recover();
  const existing = reg.get(id)!;
  expect(existing).toBeTruthy();
  // A mid-session /effort: the adapters track it beside the launch value.
  (existing as unknown as { effort?: string }).effort = "low";
  (existing as unknown as { currentEffort?: string }).currentEffort = "high";
  await expect(reg.restart({ id })).rejects.toThrow(/session create failed: launch-claude/);
  expect(seen.launchCmd).toContain("CLAUDE_EFFORT=high");   // old code: CLAUDE_EFFORT=low
  expect(seen.launchCmd).not.toContain("CLAUDE_EFFORT=low");
}, 20_000);

// ── #55 ─────────────────────────────────────────────────────────────────────

test("#55 a fresh per-session server is stamped with this daemon's state dir before the record is written", async () => {
  const { SessionRegistry } = await import("./registry");
  const { TMUX_OWNER_VAR, tmuxOwnerStamp } = await import("./orphanSweep");
  const reg = new SessionRegistry({ tmuxSession: "joy-test", relayClient: null });
  await expect(reg.create({ cwd })).rejects.toThrow(/launch-claude/);
  const stamp = seen.runSync.find((a) => a[0] === "set-environment");
  expect(stamp).toEqual(["set-environment", "-g", TMUX_OWNER_VAR, tmuxOwnerStamp()]);
  expect(tmuxOwnerStamp().startsWith(home)).toBe(true);
}, 20_000);

// ── #562 ────────────────────────────────────────────────────────────────────

test("#562 a recovered non-Claude session's relay card carries its agent flavor", async () => {
  const { SessionRegistry } = await import("./registry");
  const { saveWindowRecord } = await import("./windowRecord");
  const id = "a9e00562";
  saveWindowRecord(id, { launchCwd: cwd, agent: "agy", agySettings: { model: "gemini", conversationId: "conv-1" } });
  const reg = new SessionRegistry({ tmuxSession: "joy-test", relayClient: { creds: { machineId: "m" } } as never });
  await reg.recover();
  const s = reg.get(id)!;
  expect(s.agentFlavor).toBe("agy");
  const card = relayCards.find((c) => c.id === id);
  expect(card).toBeTruthy();
  expect(card!.flavor).toBe("agy");                      // old code: undefined → the app rendered it as Claude
  s.end("killed");
}, 20_000);

// ── #564 ────────────────────────────────────────────────────────────────────

test("#564 a non-canonical cwd (`/.`, `..`, a symlink) is canonicalised before the launch record is written", async () => {
  const { SessionRegistry } = await import("./registry");
  const reg = new SessionRegistry({ tmuxSession: "joy-test", relayClient: null });
  const real = realpathSync.native(cwd);
  await expect(reg.create({ cwd: join(cwd, ".") })).rejects.toThrow(/launch-claude/);
  expect((seen.recordsAtLaunch[0] as { launchCwd: string }).launchCwd).toBe(real);   // old code: ".../project/."
  const link = join(home, "link"); fs.symlinkSync(cwd, link);
  seen.recordsAtLaunch = [];
  await expect(reg.create({ cwd: `${link}/sub/..` })).rejects.toThrow(/launch-claude/);
  expect((seen.recordsAtLaunch[0] as { launchCwd: string }).launchCwd).toBe(real);
}, 20_000);

test("#564 residual: a record-only recovery (agy/pi/opencode) canonicalises the record's symlink spelling before the existence check, the session and the record", async () => {
  const { SessionRegistry } = await import("./registry");
  const { saveWindowRecord, loadWindowRecord } = await import("./windowRecord");
  const { AgySession } = await import("../agy/agySession");
  const { PiSession } = await import("../pi/piSession");
  vi.spyOn(AgySession.prototype, "beginWatching").mockImplementation(() => {});
  vi.spyOn(PiSession.prototype, "beginWatching").mockImplementation(() => {});
  const physical = realpathSync.native(cwd);
  const nested = join(cwd, "nested"); fs.mkdirSync(nested);
  const link = join(home, "project-link"); fs.symlinkSync(nested, link);
  // agy: a symlink spelling; pi: a symlink followed by `..` (its target's parent, NOT the link's)
  saveWindowRecord("af005641", { launchCwd: link, agent: "agy", agySettings: { conversationId: "recovery-link" } });
  saveWindowRecord("af005642", { launchCwd: `${link}/..`, agent: "pi", piSettings: { sessionId: "pi-1" } });
  const reg = new SessionRegistry({ tmuxSession: "joy-test", relayClient: { creds: { machineId: "m" } } as never });
  await reg.recover();
  const agy = reg.get("af005641")!; const pi = reg.get("af005642")!;
  expect(agy.cwd).toBe(join(physical, "nested"));                     // old code: the link spelling
  expect(pi.cwd).toBe(physical);                                       // old code: the link spelling + `/..`
  expect(loadWindowRecord("af005641")?.launchCwd).toBe(join(physical, "nested"));
  expect(loadWindowRecord("af005642")?.launchCwd).toBe(physical);
  expect(relayCards.find((c) => c.id === "af005641")?.cwd ?? agy.toJSON().cwd).toBe(join(physical, "nested"));
  agy.end("killed"); pi.end("killed");
});

/** shortcut -> physical/nested, so `shortcut/..` IS physical: the three
 *  spellings the app and a legacy record can carry. `homedir()` is spied on
 *  the builtin (and synced to its ESM binding) so `~` names this test's
 *  throwaway home; `process.cwd()` likewise so a relative spelling starts
 *  there. Both are undone by afterEach's restoreAllMocks + sync. */
function symlinkSpellings(): { physical: string; spellings: Record<"absolute" | "relative" | "tilde", string> } {
  const physical = realpathSync.native(cwd);
  const nested = join(cwd, "nested"); fs.mkdirSync(nested);
  const link = join(home, "shortcut"); fs.symlinkSync(nested, link);
  expect(realpathSync.native(`${link}/..`)).toBe(physical);
  const physHome = realpathSync.native(home);
  vi.spyOn(os, "homedir").mockReturnValue(physHome); syncBuiltinESMExports();
  vi.spyOn(process, "cwd").mockReturnValue(physHome);
  return { physical, spellings: { absolute: `${link}/..`, relative: `${relative(physHome, link)}/..`, tilde: "~/shortcut/.." } };
}

test("#564 residual: `shortcut/..` spelled absolute, relative and with `~` all launch in the link target's parent", async () => {
  const { SessionRegistry } = await import("./registry");
  const { physical, spellings } = symlinkSpellings();
  expect(spellings.relative).toBe("shortcut/..");
  const reg = new SessionRegistry({ tmuxSession: "joy-test", relayClient: null });
  for (const [spelling, raw] of Object.entries(spellings)) {
    seen.recordsAtLaunch = [];
    await expect(reg.create({ cwd: raw })).rejects.toThrow(/launch-claude/);
    // old code: relative → `home` (the link's parent); tilde → the home directory
    expect((seen.recordsAtLaunch[0] as { launchCwd: string }).launchCwd, spelling).toBe(physical);
  }
}, 30_000);

test("#564 residual: a record-only recovery canonicalises `shortcut/..` spelled absolute, relative and with `~` to the link target's parent", async () => {
  const { SessionRegistry } = await import("./registry");
  const { saveWindowRecord, loadWindowRecord } = await import("./windowRecord");
  const { AgySession } = await import("../agy/agySession");
  vi.spyOn(AgySession.prototype, "beginWatching").mockImplementation(() => {});
  const { physical, spellings } = symlinkSpellings();
  const ids = { absolute: "af005643", relative: "af005644", tilde: "af005645" } as const;
  for (const [spelling, raw] of Object.entries(spellings)) saveWindowRecord(ids[spelling as keyof typeof ids], { launchCwd: raw, agent: "agy", agySettings: { conversationId: `recovery-${spelling}` } });
  const reg = new SessionRegistry({ tmuxSession: "joy-test", relayClient: { creds: { machineId: "m" } } as never });
  await reg.recover();
  for (const [spelling, id] of Object.entries(ids)) {
    const s = reg.get(id)!;
    expect(s, spelling).toBeTruthy();
    expect(s.cwd, spelling).toBe(physical);
    expect(loadWindowRecord(id)?.launchCwd, spelling).toBe(physical);
    expect(relayCards.find((c) => c.id === id)?.cwd ?? s.toJSON().cwd, spelling).toBe(physical);
    s.end("killed");
  }
});
