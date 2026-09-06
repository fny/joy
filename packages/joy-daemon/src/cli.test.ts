// CLI helpers that decide WHAT to launch and WHAT to signal. Pure functions
// exported from cli.ts; the module's main() is gated off under vitest.
import { test, expect, describe } from "vitest";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Isolate every path the module computes at import time from the real ~/.joy.
process.env.JOY_HOME_DIR = mkdtempSync(join(tmpdir(), "joy-cli-test-"));
const { resolvePkgDir, looksLikeJoyDaemon, verifyDaemonPid } = await import("./cli");

describe("resolvePkgDir (#503)", () => {
  const store = "/home/user/.local/share/pnpm/global/5/node_modules/.pnpm/@fny+joy-daemon@1.0.15/node_modules/@fny/joy-daemon/src";
  const stable = "/home/user/.local/share/pnpm/global/5/node_modules/@fny/joy-daemon/src";

  test("collapses the pnpm virtual store to the stable top-level symlink — ONE node_modules", () => {
    const seen: string[] = [];
    const exists = (p: string) => { seen.push(p); return p === join(stable, "server.ts"); };
    expect(resolvePkgDir(store, exists)).toBe(stable);
    // the exact doubled path from the issue is never produced
    expect(seen.some((p) => p.includes("node_modules/node_modules"))).toBe(false);
  });

  test("a peer-suffixed store dir collapses the same way", () => {
    const peers = store.replace("@fny+joy-daemon@1.0.15", "@fny+joy-daemon@1.11.3_typescript@5.6.0");
    expect(resolvePkgDir(peers, (p) => p === join(stable, "server.ts"))).toBe(stable);
  });

  test("falls back to the real store path when the collapsed one has no server.ts", () => {
    expect(resolvePkgDir(store, () => false)).toBe(store);
  });

  test("source checkouts and npm globals are untouched", () => {
    const src = "/home/claude/Workspace/joy/packages/joy-daemon/src";
    expect(resolvePkgDir(src, () => true)).toBe(src);
    const npm = "/usr/local/lib/node_modules/@fny/joy-daemon/src";
    expect(resolvePkgDir(npm, () => true)).toBe(npm);
  });
});

describe("verifyDaemonPid (#495)", () => {
  const daemonCmd = "/usr/bin/node --import tsx /home/u/.local/share/pnpm/global/5/node_modules/@fny/joy-daemon/src/server.ts";

  test("recognizes the daemon's command line and nothing else", () => {
    expect(looksLikeJoyDaemon(daemonCmd)).toBe(true);
    expect(looksLikeJoyDaemon("node --import tsx /w/joy/packages/joy-daemon/src/server.ts")).toBe(true);
    expect(looksLikeJoyDaemon("/usr/bin/vim notes.txt")).toBe(false);
    expect(looksLikeJoyDaemon("node server.ts")).toBe(false);            // some other server.ts, not ours
    expect(looksLikeJoyDaemon("bash -c 'echo joy-daemon server.tsx'")).toBe(false);
    expect(looksLikeJoyDaemon("")).toBe(false);
  });

  test("a reused pid running something else is stale — never signalled", () => {
    const v = verifyDaemonPid(4242, { startedAt: Date.now() }, { command: "/usr/bin/vim notes.txt" });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toContain("not a joy-daemon");
  });

  test("a pid that no longer exists is stale", () => {
    const v = verifyDaemonPid(4242, { startedAt: Date.now() }, null);
    expect(v.ok).toBe(false);
  });

  test("the daemon daemon.json describes: same command, start time within skew", () => {
    const t = Date.now();
    expect(verifyDaemonPid(4242, { startedAt: t }, { command: daemonCmd, startedAt: t - 3_000 })).toEqual({ ok: true });
    // no kernel start time available (macOS ps): the command line decides
    expect(verifyDaemonPid(4242, { startedAt: t }, { command: daemonCmd })).toEqual({ ok: true });
    // legacy daemon.json without startedAt: the command line decides
    expect(verifyDaemonPid(4242, {}, { command: daemonCmd, startedAt: t })).toEqual({ ok: true });
  });

  test("another joy daemon that inherited the pid later is NOT the recorded one", () => {
    const t = Date.now();
    const v = verifyDaemonPid(4242, { startedAt: t - 3_600_000 }, { command: daemonCmd, startedAt: t });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toContain("reused pid");
  });
});
