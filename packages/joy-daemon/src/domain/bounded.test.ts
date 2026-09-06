import { test, expect, describe, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { withDeadline, spawnSyncBounded, retireChildProcess, killProcessGroup, processGroupMembers, processProbe, pidAlive, withFd, boundedWriter, PGROUP_MARKER_ENV } from "./bounded";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const waitExit = async (p: ChildProcess) => { for (let i = 0; i < 100 && p.exitCode === null && p.signalCode === null; i++) await sleep(20); };

describe("withDeadline", () => {
  test("a prompt result wins", async () => {
    await expect(withDeadline(Promise.resolve(7), 1000, () => -1)).resolves.toBe(7);
  });

  test("a late result is fenced: onTimeout's value is returned and the original is ignored", async () => {
    let aborted = false;
    const slow = new Promise<number>((r) => setTimeout(() => r(99), 200));
    const v = await withDeadline(slow, 20, () => { aborted = true; return -1; });
    expect(v).toBe(-1);
    expect(aborted).toBe(true);
    await slow; // settles later; nothing observable happens
  });

  test("onTimeout may throw, which rejects", async () => {
    const never = new Promise<number>(() => {});
    await expect(withDeadline(never, 10, () => { throw new Error("deadline"); })).rejects.toThrow("deadline");
  });

  test("a prompt rejection propagates", async () => {
    await expect(withDeadline(Promise.reject(new Error("boom")), 1000, () => 0)).rejects.toThrow("boom");
  });
});

describe("spawnSyncBounded", () => {
  test("a child that never exits is killed at the deadline and reported as a failure (#594)", () => {
    const t0 = Date.now();
    const r = spawnSyncBounded("sleep", ["30"], 200);
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(r.ok).toBe(false);
    expect(r.timedOut).toBe(true);
  });

  test("stdout is returned untrimmed — leading whitespace and blank rows survive (#595)", () => {
    const r = spawnSyncBounded("printf", ["\\n  indented\\n\\n"], 5000);
    expect(r.ok).toBe(true);
    expect(r.timedOut).toBe(false);
    expect(r.out).toBe("\n  indented\n\n");
  });

  test("a missing binary is a failure, not a throw", () => {
    const r = spawnSyncBounded("/nonexistent/binary-xyz", [], 1000);
    expect(r.ok).toBe(false);
    expect(r.timedOut).toBe(false);
  });
});

describe("retireChildProcess", () => {
  test("a spawn error delivered after retirement does not become an unhandled 'error' (#590)", async () => {
    const proc = spawn("/nonexistent/binary-xyz", [], { stdio: ["pipe", "pipe", "ignore"] });
    // Node delivers ENOENT asynchronously; retire BEFORE it arrives, as stop()
    // racing a failed attach does. Without the sink this throws at the loop.
    retireChildProcess(proc, { stdin: "end" });
    await sleep(50);
    // Still here: the error was absorbed by the terminal sink.
    expect(proc.listenerCount("error")).toBeGreaterThan(0);
  });

  test("a live child is killed and its lifecycle listeners are gone", async () => {
    const proc = spawn("sleep", ["30"], { stdio: ["pipe", "ignore", "ignore"] });
    let exitedVia = "";
    proc.once("exit", () => { exitedVia = "lifecycle"; });
    retireChildProcess(proc, { stdin: "destroy" });
    for (let i = 0; i < 50 && proc.exitCode === null && proc.signalCode === null; i++) await sleep(20);
    expect(proc.signalCode ?? proc.exitCode).not.toBeNull();
    expect(exitedVia).toBe(""); // the owner's listener was removed
  });
});

describe("killProcessGroup", () => {
  /** Probe overrides are restored after every test: the seam is module-global. */
  const original = { ...processProbe };
  afterEach(() => { Object.assign(processProbe, original); });
  /** Every pid we spawn, so a failing assertion never leaves a sleeper behind. */
  const strays: number[] = [];
  afterEach(() => { for (const p of strays.splice(0)) { try { process.kill(p, "SIGKILL"); } catch { /* gone */ } } });
  const sleeperOf = (pgid: number): number => {
    const [survivor, ...rest] = processGroupMembers(pgid).filter((p) => p !== pgid);
    expect(rest).toEqual([]);
    expect(survivor).toBeDefined();
    strays.push(survivor);
    return survivor;
  };

  test("a TERM-resistant child that outlives its exited group leader is still found and killed (#571)", async () => {
    // Leader: a shell that forks a TERM-ignoring sleeper into the SAME process
    // group, then exits (on stdin EOF) — the shape of a launcher whose server
    // child ignores the first signal. The kill starts WHILE the leader lives,
    // which is when the group can be captured (#628); the leader then goes.
    const leader = spawn("/bin/sh", ["-c", "trap '' TERM; sleep 30 & read x; exit 0"], { detached: true, stdio: ["pipe", "ignore", "ignore"] });
    leader.unref();
    const pgid = leader.pid!;
    await sleep(100);
    const survivor = sleeperOf(pgid);

    const logs: string[] = [];
    const killed = killProcessGroup(pgid, { graceMs: 400, log: (l) => logs.push(l) });
    leader.stdin.end();
    await waitExit(leader);
    expect(leader.exitCode).toBe(0); // exited on its own — never SIGKILLed
    const gone = await killed;
    expect(gone).toBe(true);
    expect(pidAlive(survivor)).toBe(false);
    expect(processGroupMembers(pgid)).toEqual([]);
    expect(logs.some((l) => l.includes("escalating to SIGKILL"))).toBe(true);
  });

  test("a group whose leader is already gone is NOT signalled through the reused pgid (#628)", async () => {
    const leader = spawn("/bin/sh", ["-c", "exit 0"], { detached: true, stdio: "ignore" });
    await waitExit(leader);
    const oldPid = leader.pid!;
    expect(pidAlive(oldPid)).toBe(false);
    // An unrelated detached process — say the next vitest worker — that the
    // kernel handed the old pid as its pgid. Simulated: the pgid lookup
    // reports it in the dead leader's group.
    const victim = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
    victim.unref();
    strays.push(victim.pid!);
    await sleep(50);
    let scans = 0;
    processProbe.membersOf = (pgid) => {
      scans++;
      const id = original.identityOf(victim.pid!)!;
      return pgid === oldPid ? [{ pid: victim.pid!, ...id }] : original.membersOf(pgid);
    };
    const logs: string[] = [];
    await expect(killProcessGroup(oldPid, { graceMs: 200, log: (l) => logs.push(l) })).resolves.toBe(true);
    await sleep(50);
    expect(pidAlive(victim.pid!)).toBe(true);
    expect(victim.signalCode).toBeNull();
    expect(scans).toBe(0); // a dead leader's pid is never used to scan
    expect(logs).toEqual([]);
  });

  test("with a marker, a reused pgid's members are checked against /proc environ and left alone (#628)", async () => {
    if (!existsSync("/proc/self/environ")) return;
    const leader = spawn("/bin/sh", ["-c", "exit 0"], { detached: true, stdio: "ignore" });
    await waitExit(leader);
    const oldPid = leader.pid!;
    const victim = spawn("sleep", ["30"], { detached: true, stdio: "ignore", env: { ...process.env, [PGROUP_MARKER_ENV]: "someone-else" } });
    victim.unref();
    strays.push(victim.pid!);
    await sleep(50);
    processProbe.membersOf = (pgid) => pgid === oldPid ? [{ pid: victim.pid!, ...original.identityOf(victim.pid!)! }] : original.membersOf(pgid);
    await expect(killProcessGroup(oldPid, { graceMs: 200, marker: "tok-628", log: () => {} })).resolves.toBe(true);
    await sleep(50);
    expect(pidAlive(victim.pid!)).toBe(true);
    expect(victim.signalCode).toBeNull();
  });

  test("with a marker, a survivor whose leader exited before the call is found through its environ and killed (#628)", async () => {
    if (!existsSync("/proc/self/environ")) return;
    // The daemon-restart shape: the launcher pid is recorded, the launcher
    // is gone, the TERM-ignoring server it forked lives on with the marker.
    const leader = spawn("/bin/sh", ["-c", "trap '' TERM; sleep 30 & exit 0"], { detached: true, stdio: "ignore", env: { ...process.env, [PGROUP_MARKER_ENV]: "tok-571" } });
    await waitExit(leader);
    const pgid = leader.pid!;
    const survivor = sleeperOf(pgid);
    const logs: string[] = [];
    await expect(killProcessGroup(pgid, { graceMs: 300, marker: "tok-571", log: (l) => logs.push(l) })).resolves.toBe(true);
    expect(pidAlive(survivor)).toBe(false);
    expect(logs.some((l) => l.includes("escalating to SIGKILL"))).toBe(true);
  });

  test("a captured member whose start time no longer matches is a reused pid and is not signalled (#628)", async () => {
    // Leader honours TERM; its background child ignores it. After SIGTERM the
    // leader is gone and only captured pids may be signalled — and this one
    // now reports a different start time, i.e. a different process.
    const leader = spawn("/bin/sh", ["-c", "(trap '' TERM; exec sleep 30) & sleep 30"], { detached: true, stdio: "ignore" });
    leader.unref();
    const pgid = leader.pid!;
    await sleep(150);
    const members = processGroupMembers(pgid);
    strays.push(...members);
    expect(members.length).toBe(3);
    const killed = killProcessGroup(pgid, { graceMs: 300, log: () => {} });
    // After the first (synchronous) capture, every later look at the group
    // sees the TERM-ignoring child as a different incarnation.
    await waitExit(leader);
    expect(leader.signalCode).toBe("SIGTERM");
    const survivor = sleeperOf(pgid); // the foreground sleep died with the leader
    processProbe.identityOf = (p) => {
      const id = original.identityOf(p);
      return id && p === survivor ? { ...id, start: `${id.start}-reused` } : id;
    };
    await expect(killed).resolves.toBe(true); // nothing left that is provably ours
    expect(pidAlive(survivor)).toBe(true);
  });

  test("an already-dead pid resolves true without escalation", async () => {
    const p = spawn("true", [], { stdio: "ignore" });
    await waitExit(p);
    expect(pidAlive(p.pid!)).toBe(false);
    await expect(killProcessGroup(p.pid!, { graceMs: 100, log: () => {} })).resolves.toBe(true);
  });
});

describe("withFd", () => {
  const openFds = () => readdirSync("/proc/self/fd").length;

  test("closes the descriptor when fn returns", () => {
    const dir = mkdtempSync(join(tmpdir(), "withfd-"));
    try {
      const p = join(dir, "f"); writeFileSync(p, "hi");
      const before = openFds();
      expect(withFd(p, "r", () => 42)).toBe(42);
      expect(openFds()).toBe(before);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("closes the descriptor when fn throws (#489)", () => {
    const dir = mkdtempSync(join(tmpdir(), "withfd-"));
    try {
      const p = join(dir, "f"); writeFileSync(p, "hi");
      const before = openFds();
      for (let i = 0; i < 5; i++) {
        expect(() => withFd(p, "r", () => { throw new Error("EIO"); })).toThrow("EIO");
      }
      expect(openFds()).toBe(before);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("boundedWriter", () => {
  function fakeSink(): { sink: { writableLength: number; write(c: string): boolean; destroy(): void }; writes: string[]; destroyed: number } {
    const state = { writes: [] as string[], destroyed: 0 };
    const sink = {
      writableLength: 0, // nothing is ever drained: the slow-client model
      write(c: string) { state.writes.push(c); sink.writableLength += Buffer.byteLength(c); return true; },
      destroy() { state.destroyed++; },
    };
    return { sink, ...state, get writes() { return state.writes; }, get destroyed() { return state.destroyed; } };
  }

  test("writes pass through until the pending bytes would exceed the cap, then the client is dropped once (#597)", () => {
    const f = fakeSink();
    let overflow = 0;
    const write = boundedWriter(f.sink, 100, () => { overflow++; });
    expect(write("x".repeat(60))).toBe(true);
    expect(write("y".repeat(40))).toBe(true); // exactly at the cap is allowed
    expect(write("z")).toBe(false); // one byte over → dropped
    expect(overflow).toBe(1);
    expect(f.destroyed).toBe(1);
    expect(write("more")).toBe(false); // no further writes, no second overflow
    expect(overflow).toBe(1);
    expect(f.sink.writableLength).toBe(100);
  });

  test("a draining client is never dropped", () => {
    const sink = { writableLength: 0, write: () => true, destroy: () => { throw new Error("must not destroy"); } };
    const write = boundedWriter(sink, 10, () => { throw new Error("must not overflow"); });
    for (let i = 0; i < 1000; i++) expect(write("12345")).toBe(true);
  });
});
