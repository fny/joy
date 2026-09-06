// Registry recover / restart / create contracts (Wave F): a restart carries
// the CURRENT effort (#51), a per-session server is stamped with the owning
// daemon (#55), a recovered non-Claude session's card carries its flavor
// (#562), and a non-canonical cwd is canonicalised before the launch record
// and transcript path are built (#564). The tmux driver is a fake that stops
// every create at the launch boundary (nothing is ever spawned); the relay
// module's createRelaySession is a recording stub. Throwaway JOY_HOME_DIR.
import { test, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

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
  vi.restoreAllMocks();
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
