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

  it("treats a free pid as unowned rather than starting a kill", async () => {
    const done = spawn("true", [], { stdio: "ignore" });
    for (let i = 0; i < 100 && done.exitCode === null && done.signalCode === null; i++) await sleep(20);
    expect(await reapRecordedOpencodeServer(done.pid!, { start: "whatever", marker: "tok-recorded" })).toBe("unowned");
    expect(killGroup).not.toHaveBeenCalled();
  }, 20_000);
});
