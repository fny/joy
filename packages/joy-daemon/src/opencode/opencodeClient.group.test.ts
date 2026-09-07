// #628 (Wave F14) — every opencode server this daemon starts is killed
// through the ownership proof captured when it was SPAWNED, and a server pid
// read back from a previous daemon run is verified before it is signalled.
//
// The two sites the sweep found: the picker's short-lived server (spawned and
// killed inside listOpencodeSessionsForCwd, with no marker on either side) and
// the recorded-server reap on recovery, which had no saved spawn identity at
// all and so signalled whatever now owned the number.
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, copyFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

vi.mock("../domain/bounded", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../domain/bounded")>();
  return { ...actual, killProcessGroup: vi.fn(actual.killProcessGroup), newProcessGroupMarker: () => "tok-picker" };
});

import { killProcessGroup, pidAlive, processProbe, PGROUP_MARKER_ENV } from "../domain/bounded";
import { listOpencodeSessionsForCwd, reapRecordedOpencodeServer } from "./opencodeClient";

const killGroup = vi.mocked(killProcessGroup);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitGone(pid: number, ms = 5_000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until && pidAlive(pid)) await sleep(50);
  return !pidAlive(pid);
}

let dir: string;
const savedHome = process.env.JOY_HOME_DIR;
const savedBin = process.env.JOY_OPENCODE_BIN;
const strays: number[] = [];

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "oc-group-"));
  process.env.JOY_HOME_DIR = join(dir, "joy-home"); // the spawn writes a clean npmrc under the state dir
});
afterAll(() => {
  if (savedHome === undefined) delete process.env.JOY_HOME_DIR; else process.env.JOY_HOME_DIR = savedHome;
  if (savedBin === undefined) delete process.env.JOY_OPENCODE_BIN; else process.env.JOY_OPENCODE_BIN = savedBin;
  rmSync(dir, { recursive: true, force: true });
});
afterEach(() => {
  killGroup.mockClear();
  for (const p of strays.splice(0)) { try { process.kill(p, "SIGKILL"); } catch { /* gone */ } }
});

describe("the picker's server is killed through its spawn identity (#628)", () => {
  it("hands the kill the JOY_PGROUP marker and the launcher's start time, and reaps the whole group", async () => {
    if (!existsSync("/proc/self/environ")) return;
    // A launcher that leaves a TERM-resistant child in its group and then
    // dies on the first signal — the shape that outlived the picker's kill.
    const bin = join(dir, "fake-opencode-picker");
    const pidFile = join(dir, "grandchild.pid");
    writeFileSync(bin, `#!/bin/sh
sh -c 'trap "" TERM; exec sleep 30' &
echo $! > ${pidFile}
echo "opencode server listening on http://127.0.0.1:1"
exec sleep 30
`);
    chmodSync(bin, 0o755);
    process.env.JOY_OPENCODE_BIN = bin;

    // Port 1 has nothing on it: the listing fails, and the finally-block kill
    // is what this test is about.
    await expect(listOpencodeSessionsForCwd(dir)).rejects.toThrow();
    expect(killGroup).toHaveBeenCalledTimes(1);
    const [pid, opts] = killGroup.mock.calls[0]!;
    strays.push(pid);
    expect(opts).toMatchObject({ marker: "tok-picker" });
    expect(typeof opts!.spawnStart).toBe("string"); // the launcher's start time, read at spawn
    const grandchild = Number(readFileSync(pidFile, "utf8").trim());
    strays.push(grandchild);

    await expect(killGroup.mock.results[0]!.value).resolves.toBe(true);
    expect(await waitGone(pid)).toBe(true);
    expect(await waitGone(grandchild)).toBe(true); // only the marker/capture could reach it
  }, 30_000);
});

describe("recorded-server recovery verifies the pid before signalling it (#628)", () => {
  /** A process that passes isOpencodeServerPid: comm `opencode.exe`, and
   *  `serve` in its argv. It ignores SIGTERM, like the real server. */
  function fakeRecordedServer(): { pid: number; start: string } {
    const exe = join(dir, "opencode.exe");
    if (!existsSync(exe)) { copyFileSync("/bin/sh", exe); chmodSync(exe, 0o755); }
    const proc = spawn(exe, ["-c", "trap '' TERM; sleep 30", "serve"], {
      detached: true, stdio: "ignore", env: { ...process.env, [PGROUP_MARKER_ENV]: "tok-recorded" },
    });
    proc.unref();
    const pid = proc.pid!;
    strays.push(pid);
    return { pid, start: processProbe.identityOf(pid)!.start };
  }

  it("refuses a pid whose start time no longer matches the recorded spawn: nothing is signalled", async () => {
    const { pid } = fakeRecordedServer();
    await sleep(100);
    const outcome = await reapRecordedOpencodeServer(pid, { start: "9999999999", marker: "tok-recorded" });
    expect(outcome).toBe("unowned");
    expect(killGroup).not.toHaveBeenCalled();
    expect(pidAlive(pid)).toBe(true); // a stranger that inherited the number is left alone
  }, 20_000);

  it("reaps the recorded server when the identity does match", async () => {
    const { pid, start } = fakeRecordedServer();
    await sleep(100);
    const outcome = await reapRecordedOpencodeServer(pid, { start, marker: "tok-recorded" });
    expect(outcome).toBe("gone");
    expect(killGroup).toHaveBeenCalledTimes(1);
    expect(killGroup.mock.calls[0]![1]).toMatchObject({ marker: "tok-recorded", spawnStart: start });
    expect(await waitGone(pid)).toBe(true);
  }, 20_000);

  it("reaps the marker-proven server a recorded launcher left behind before freeing the record", async () => {
    if (!existsSync("/proc/self/environ")) return;
    // The real shape (#628 F21): `opencode` is a LAUNCHER — it starts the
    // actual `opencode.exe serve` and exits. At recovery the recorded pid is
    // free while the server it left behind is still listening, and treating
    // "the leader has exited" as "the record is free" left that server running
    // and let a second one open the same conversation.
    const exe = join(dir, "opencode.exe");
    if (!existsSync(exe)) { copyFileSync("/bin/sh", exe); chmodSync(exe, 0o755); }
    const pidFile = join(dir, "left-behind.pid");
    const launcher = spawn("/bin/sh", ["-c", `"${exe}" -c 'trap "" TERM; sleep 30' serve </dev/null >/dev/null 2>&1 & echo $! > "${pidFile}"; exit 0`], {
      detached: true, stdio: "ignore", env: { ...process.env, [PGROUP_MARKER_ENV]: "tok-left-behind" },
    });
    const pid = launcher.pid!;
    const start = processProbe.identityOf(pid)!.start;
    await new Promise<void>((r) => launcher.on("exit", () => r()));
    await sleep(100);
    const child = Number(readFileSync(pidFile, "utf8").trim());
    strays.push(child);
    expect(pidAlive(pid)).toBe(false); // the recorded launcher is gone…
    expect(pidAlive(child)).toBe(true); // …its marked server is not

    expect(await reapRecordedOpencodeServer(pid, { start, marker: "tok-left-behind" })).toBe("gone");
    expect(killGroup).toHaveBeenCalledTimes(1);
    expect(await waitGone(child)).toBe(true);

    // Only once nothing marker-proven survives is the record actually free.
    killGroup.mockClear();
    expect(await reapRecordedOpencodeServer(pid, { start, marker: "tok-left-behind" })).toBe("unowned");
    expect(killGroup).not.toHaveBeenCalled();
  }, 30_000);

  it("treats a free pid as unowned rather than starting a kill", async () => {
    const done = spawn("true", [], { stdio: "ignore" });
    for (let i = 0; i < 100 && done.exitCode === null && done.signalCode === null; i++) await sleep(20);
    expect(await reapRecordedOpencodeServer(done.pid!, { start: "whatever", marker: "tok-recorded" })).toBe("unowned");
    expect(killGroup).not.toHaveBeenCalled();
  }, 20_000);
});

// #628 (Wave F29) — recovery must PROVE the recorded server's group is gone
// before it lets a replacement start. Two ways it could not: a launcher pid
// that had been recycled skipped the descendant search altogether, and a
// search that could not run at all ("no process listing on this platform")
// was reported as "nothing there".
describe("recovery proves absence before allowing a replacement (#628 F29)", () => {
  const original = { ...processProbe };
  afterEach(() => { Object.assign(processProbe, original); });

  it("searches a REUSED launcher pid for the descendants it left, and reaps them", async () => {
    const launcher = 993001;
    const child = 993002;
    let childLive = true;
    // The launcher's number now belongs to a stranger (different start time,
    // and it does not carry our marker); the server it spawned is still there
    // and still proves itself through its own JOY_PGROUP.
    processProbe.identityOf = (p) => {
      if (p === launcher) return { start: "a-strangers-incarnation", zombie: false };
      if (p === child) return childLive ? { start: "child-start", zombie: false } : null;
      return original.identityOf(p);
    };
    processProbe.membersOf = (g) => (g === launcher ? (childLive ? [{ pid: child, start: "child-start", zombie: false }] : []) : original.membersOf(g));
    processProbe.hasMarker = (p, m) => (m === "tok-f29-reused" ? p === child && childLive : original.hasMarker(p, m));
    const signals: Array<[number, string | number | undefined]> = [];
    const kill = vi.spyOn(process, "kill").mockImplementation(((p: number, s: NodeJS.Signals) => {
      signals.push([p, s]);
      if (p === child || p === -child) childLive = false;
      return true;
    }) as typeof process.kill);
    try {
      await expect(reapRecordedOpencodeServer(launcher, { start: "our-launcher-incarnation", marker: "tok-f29-reused" })).resolves.toBe("gone");
      expect(signals).toEqual([[child, "SIGTERM"]]); // the marked child, and only it
      expect(signals.some(([p]) => p === launcher || p === -launcher)).toBe(false); // the stranger is untouched
    } finally { kill.mockRestore(); }
  }, 20_000);

  it("reports 'unknown' — never 'unowned' — when the group could not be listed at all", async () => {
    const launcher = 993003;
    // The recorded launcher is gone and this platform lists no processes: what
    // it left behind can be neither found nor ruled out.
    processProbe.identityOf = (p) => (p === launcher ? null : original.identityOf(p));
    processProbe.membersOf = (g) => (g === launcher ? null : original.membersOf(g));
    processProbe.hasMarker = (p, m) => (m === "tok-f29-dead" ? null : original.hasMarker(p, m));
    const kill = vi.spyOn(process, "kill").mockImplementation((() => true) as typeof process.kill);
    try {
      // "unowned" here is what let a SECOND server open the same conversation
      // on top of descendants nobody had proven were gone (#71).
      await expect(reapRecordedOpencodeServer(launcher, { start: "recorded", marker: "tok-f29-dead" })).resolves.toBe("unknown");
      expect(killGroup).not.toHaveBeenCalled();
      expect(kill).not.toHaveBeenCalled();
    } finally { kill.mockRestore(); }
  }, 20_000);
});
