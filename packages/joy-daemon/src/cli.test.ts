// CLI helpers that decide WHAT to launch and WHAT to signal. Pure functions
// exported from cli.ts; the module's main() is gated off under vitest.
import { test, expect, describe } from "vitest";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Isolate every path the module computes at import time from the real ~/.joy.
process.env.JOY_HOME_DIR = mkdtempSync(join(tmpdir(), "joy-cli-test-"));
const { resolvePkgDir, looksLikeJoyDaemon, verifyDaemonPid, serverEntryOf } = await import("./cli");

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

  test("recognizes the daemon's command line and nothing else (legacy rule: a joy-daemon/ path segment)", () => {
    expect(looksLikeJoyDaemon(daemonCmd)).toBe(true);
    expect(looksLikeJoyDaemon("node --import tsx /w/joy/packages/joy-daemon/src/server.ts")).toBe(true);
    expect(looksLikeJoyDaemon("/usr/bin/vim notes.txt")).toBe(false);
    expect(looksLikeJoyDaemon("node server.ts")).toBe(false);            // some other server.ts, not ours
    expect(looksLikeJoyDaemon("bash -c 'echo joy-daemon server.tsx'")).toBe(false);
    expect(looksLikeJoyDaemon("")).toBe(false);
    // #495 residual (Astra): "server.ts and tsx" is not Joy. An unrelated tsx
    // app must never be signalled on the strength of a stale daemon.json.
    expect(looksLikeJoyDaemon("node --import tsx /home/u/unrelated/server.ts")).toBe(false);
    expect(looksLikeJoyDaemon("/usr/bin/node /home/u/node_modules/tsx/dist/cli.mjs server.ts")).toBe(false);
    expect(looksLikeJoyDaemon("node --import tsx /home/u/joy-daemon-notes/server.ts")).toBe(false); // segment, not substring
  });

  test("serverEntryOf picks the script operand", () => {
    expect(serverEntryOf(daemonCmd)).toBe("/home/u/.local/share/pnpm/global/5/node_modules/@fny/joy-daemon/src/server.ts");
    expect(serverEntryOf("node --import tsx src/server.ts")).toBe("src/server.ts");
    expect(serverEntryOf("node --import tsx /x/server.tsx")).toBeNull();
    expect(serverEntryOf("vim notes.txt")).toBeNull();
  });

  describe("with the recorded entry (#495 residual)", () => {
    const entry = "/home/u/.local/share/pnpm/global/5/node_modules/@fny/joy-daemon/src/server.ts";
    const t = Date.now();

    test("the exact recorded entry path is required — an unrelated tsx server.ts is stale, even with tsx and a matching start time", () => {
      const v = verifyDaemonPid(4242, { startedAt: t, entry }, { command: "/usr/bin/node --import tsx /home/u/unrelated/server.ts", startedAt: t - 1_000 });
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.reason).toMatch(/not the daemon daemon.json records/);
      // ...and so is a real joy-daemon from ANOTHER install (a different file).
      const other = verifyDaemonPid(4242, { startedAt: t, entry }, { command: "/usr/bin/node --import tsx /opt/joy/packages/joy-daemon/src/server.ts", startedAt: t - 1_000 });
      expect(other.ok).toBe(false);
      // no kernel start time at all (macOS): the entry check alone still refuses
      expect(verifyDaemonPid(4242, { startedAt: t, entry }, { command: "node --import tsx /home/u/unrelated/server.ts" }).ok).toBe(false);
    });

    test("the recorded daemon passes: exact entry, and a relative operand resolved against the process cwd", () => {
      expect(verifyDaemonPid(4242, { startedAt: t, entry }, { command: `/usr/bin/node --import tsx ${entry}`, startedAt: t - 3_000 })).toEqual({ ok: true });
      expect(verifyDaemonPid(4242, { startedAt: t, entry }, { command: `/usr/bin/node --import tsx ${entry}` })).toEqual({ ok: true }); // macOS: no start time
      expect(verifyDaemonPid(4242, { startedAt: t, entry: "/w/joy/packages/joy-daemon/src/server.ts" }, { command: "node --import tsx src/server.ts", cwd: "/w/joy/packages/joy-daemon" })).toEqual({ ok: true });
      // a relative operand with no cwd to resolve it against cannot be confirmed
      expect(verifyDaemonPid(4242, { startedAt: t, entry: "/w/joy/packages/joy-daemon/src/server.ts" }, { command: "node --import tsx src/server.ts" }).ok).toBe(false);
    });

    test("the start-time check still applies on top of the entry match", () => {
      const v = verifyDaemonPid(4242, { startedAt: t - 3_600_000, entry }, { command: `/usr/bin/node --import tsx ${entry}`, startedAt: t });
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.reason).toContain("reused pid");
    });

    test("legacy daemon.json without entry: the joy-daemon/ segment rule, never tsx alone", () => {
      expect(verifyDaemonPid(4242, { startedAt: t }, { command: "node --import tsx /home/u/unrelated/server.ts", startedAt: t }).ok).toBe(false);
      expect(verifyDaemonPid(4242, { startedAt: t }, { command: daemonCmd, startedAt: t })).toEqual({ ok: true });
    });
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
