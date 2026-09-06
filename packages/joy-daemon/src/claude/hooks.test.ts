// ensureHookSettings repair path (#471). The stamp file is the "both files
// complete" marker; the failure family here is a repair that dies halfway and
// a later call trusting the still-current stamp. Failures are injected through
// the default `fs` object (what atomicWrite.ts calls), never through the
// shell. Each test re-imports hooks.ts so its in-module settings-path cache
// starts empty — the way a fresh daemon start sees the state dir.
import { test, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let home: string;
const savedHome = process.env.JOY_HOME_DIR;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "hooks-test-"));
  process.env.JOY_HOME_DIR = home;
  vi.resetModules();
});
afterEach(() => {
  vi.restoreAllMocks();
  if (savedHome === undefined) delete process.env.JOY_HOME_DIR; else process.env.JOY_HOME_DIR = savedHome;
  rmSync(home, { recursive: true, force: true });
});

async function fresh() {
  vi.resetModules();
  const { ensureHookSettings } = await import("./hooks");
  const { joyStateDir } = await import("../paths");
  const dir = joyStateDir();
  return {
    ensureHookSettings,
    dir,
    hookPath: join(dir, "joy-hook.mjs"),
    settingsPath: join(dir, "claude-settings.json"),
    stampPath: join(dir, "joy-hooks.version"),
  };
}

const enospc = () => Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
const parses = (p: string) => { JSON.parse(readFileSync(p, "utf8")); return true; };

test("a current stamp does not vouch for a truncated settings file — it is repaired, not returned (#471)", async () => {
  const first = await fresh();
  expect(first.ensureHookSettings()).toBe(first.settingsPath);
  const good = readFileSync(first.settingsPath, "utf8");

  // The on-disk aftermath of a repair that died mid-write under the old code:
  // stamp current, script present, settings JSON cut short.
  writeFileSync(first.settingsPath, good.slice(0, good.length / 2));

  const again = await fresh();
  const p = again.ensureHookSettings();
  expect(p).toBe(again.settingsPath);
  expect(parses(p)).toBe(true);
  expect(readFileSync(p, "utf8")).toBe(good);
});

test("a repair that fails on the settings file leaves no current stamp and the previous complete settings; the retry completes it (#471)", async () => {
  const first = await fresh();
  expect(first.ensureHookSettings()).toBe(first.settingsPath);
  const good = readFileSync(first.settingsPath, "utf8");
  const stamp = readFileSync(first.stampPath, "utf8");

  // The issue's scenario: the script is missing (stamp + settings intact), and
  // the disk fills after the script is rewritten, before the settings land.
  rmSync(first.hookPath);
  const realOpen = fs.openSync;
  vi.spyOn(fs, "openSync").mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => {
    if (String(p).includes("claude-settings.json")) throw enospc();
    return (realOpen as (...a: unknown[]) => number)(p, ...rest);
  }) as typeof fs.openSync);

  const failing = await fresh();
  expect(failing.ensureHookSettings()).toBe("");
  expect(existsSync(failing.hookPath)).toBe(true); // the script did land
  expect(readFileSync(failing.settingsPath, "utf8")).toBe(good); // never truncated
  expect(existsSync(failing.stampPath)).toBe(false); // nothing vouches for a half-done repair
  expect(readdirSync(failing.dir).filter((f) => f.startsWith("."))).toEqual([]); // no temp files left

  // Space is back: the retry must redo the repair and restore the stamp.
  vi.restoreAllMocks();
  const retry = await fresh();
  expect(retry.ensureHookSettings()).toBe(retry.settingsPath);
  expect(parses(retry.settingsPath)).toBe(true);
  expect(readFileSync(retry.stampPath, "utf8")).toBe(stamp);
  expect(existsSync(retry.hookPath)).toBe(true);
});
