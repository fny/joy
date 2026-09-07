import { test, expect, describe, afterEach, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import v8 from "node:v8";
import vm from "node:vm";
import { withDeadline, spawnSyncBounded, retireChildProcess, killProcessGroup, processGroupMembers, processProbe, pidAlive, withFd, boundedWriter, BoundedTail, PGROUP_MARKER_ENV, registerGroup, refreshGroupMembers, forgetGroup, spawnedGroupIdentity, ownedGroupMembers, type GroupRegistration } from "./bounded";

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
  afterEach(() => { for (const p of strays.splice(0)) { forgetGroup(p); try { process.kill(p, "SIGKILL"); } catch { /* gone */ } } });
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

  test("a group registered at spawn still reaches the child of a leader that exited first (#628 F14)", async () => {
    // The regression's shape WITHOUT a marker: the leader backgrounds a
    // TERM-resistant job and exits before anything kills it, so at kill time
    // the pgid is stale evidence. What was captured while it lived is not.
    const leader = spawn("/bin/sh", ["-c", "(trap '' TERM; exec sleep 30) & read x; exit 0"], { detached: true, stdio: ["pipe", "ignore", "ignore"] });
    leader.unref();
    const pgid = leader.pid!;
    registerGroup(pgid);
    await sleep(150);
    refreshGroupMembers(pgid, { force: true }); // the opportunistic widening a spawn site does
    const survivor = sleeperOf(pgid);
    leader.stdin.end();
    await waitExit(leader);
    expect(leader.exitCode).toBe(0);
    expect(pidAlive(pgid)).toBe(false); // the leader is GONE before the kill starts

    const logs: string[] = [];
    await expect(killProcessGroup(pgid, { graceMs: 300, log: (l) => logs.push(l) })).resolves.toBe(true);
    expect(pidAlive(survivor)).toBe(false);
    expect(logs.some((l) => l.includes("escalating to SIGKILL"))).toBe(true);
  });

  test("a pid reused BEFORE the kill is entered is not signalled and termination is unconfirmed (#628 F14)", async () => {
    // Nothing real is touched: the probes describe a pid whose occupant is a
    // different incarnation from the one registered at spawn.
    const pid = 991337;
    registerGroup(pid, { start: "SPAWN-INCARNATION" });
    processProbe.identityOf = (p) => (p === pid ? { start: "NEW-unrelated-incarnation", zombie: false } : original.identityOf(p));
    processProbe.membersOf = (pgid) => (pgid === pid ? [{ pid, start: "NEW-unrelated-incarnation", zombie: false }] : original.membersOf(pgid));
    const signals: Array<[number, string | number | undefined]> = [];
    const kill = vi.spyOn(process, "kill").mockImplementation(((p: number, s: NodeJS.Signals) => { signals.push([p, s]); return true; }) as typeof process.kill);
    const logs: string[] = [];
    try {
      await expect(killProcessGroup(pid, { graceMs: 0, log: (l) => logs.push(l) })).resolves.toBe(false);
      expect(signals).toEqual([]); // neither kill(-pgid) nor a single-process kill
    } finally { kill.mockRestore(); }
    expect(logs.some((l) => l.includes("not the process spawned here"))).toBe(true);
  });

  test("a registered group whose leader vanished with nothing captured is unconfirmed, not 'terminated' (#628 F14)", async () => {
    const p = spawn("true", [], { stdio: "ignore" });
    await waitExit(p);
    const pid = p.pid!;
    // Registered as if it had been spawned and its start time read then; by
    // kill time the pid is free and the group was never enumerable.
    registerGroup(pid, { start: "start-at-spawn" });
    const logs: string[] = [];
    await expect(killProcessGroup(pid, { graceMs: 100, log: (l) => logs.push(l) })).resolves.toBe(false);
    expect(logs.some((l) => l.includes("termination unconfirmed"))).toBe(true);
  });

  test("spawnedGroupIdentity is consumed by the kill, so records do not accumulate (#628 F14)", async () => {
    const p = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
    p.unref();
    strays.push(p.pid!);
    registerGroup(p.pid!, { marker: "tok-registry" });
    expect(spawnedGroupIdentity(p.pid!)).toMatchObject({ marker: "tok-registry" });
    await killProcessGroup(p.pid!, { graceMs: 100, log: () => {} });
    expect(spawnedGroupIdentity(p.pid!)).toBeUndefined();
  });

  test("a registration a caller still holds survives the registry sweep, so a reused pid is still refused (#628 F21)", async () => {
    // The registry's sweep is a memory bound, not an expiry. It used to
    // scavenge a group whose captured members no longer matched — and the pid
    // of an outstanding tool run is exactly that: its leader (a shell that
    // backgrounded the work) has exited. With the start-time fence gone, the
    // kill fell back to "the pid exists" and signalled whatever now held the
    // number. Nothing real is touched here: the probes describe the pids.
    const pid = 991339;
    const others: GroupRegistration[] = [];
    let stage = "spawn-incarnation";
    // No /proc on this platform: the marker cannot be inspected, so the start
    // time recorded at spawn is the ONLY fence there is.
    processProbe.identityOf = (p) => (p === pid ? { start: stage, zombie: false } : null);
    processProbe.membersOf = () => [];
    processProbe.hasMarker = () => null;
    const held = registerGroup(pid, { marker: "owned-marker" });
    stage = "new-unrelated-incarnation"; // the leader exited; a stranger got the pid
    const signals: Array<[number, string | number | undefined]> = [];
    const kill = vi.spyOn(process, "kill").mockImplementation(((p: number, s: NodeJS.Signals) => { signals.push([p, s]); return true; }) as typeof process.kill);
    const logs: string[] = [];
    try {
      // Other spawns, more than enough to trigger the sweep several times over,
      // while this caller still owns a teardown obligation on `pid`.
      for (let i = 0; i < 200; i++) others.push(registerGroup(992000 + i));
      expect(spawnedGroupIdentity(pid)).toMatchObject({ start: "spawn-incarnation", marker: "owned-marker" });
      await expect(killProcessGroup(pid, { marker: "owned-marker", graceMs: 0, log: (l) => logs.push(l) })).resolves.toBe(false);
      expect(signals).toEqual([]); // no kill(-pgid), no single-process kill
      expect(logs.some((l) => l.includes("not the process spawned here"))).toBe(true);
      // …and the bound still works: released records of finished groups go.
      for (const o of others) o.release();
      expect(spawnedGroupIdentity(992000)).toBeUndefined();
    } finally { held.release(); for (const o of others) forgetGroup(o.pid); kill.mockRestore(); }
  });

  test("a marked group that could not be enumerated at all is unconfirmed, not 'gone' (#628 F21)", async () => {
    // A marker is only evidence if the group can be SEARCHED. Here every scan
    // comes back null (no process listing on this platform), so "nothing of it
    // was found" is the absence of a search, not the absence of the group.
    const pid = 991338;
    let present = true;
    let scans = 0;
    processProbe.identityOf = (p) => (p === pid && present ? { start: "owned", zombie: false } : null);
    processProbe.membersOf = () => { scans++; return null; };
    processProbe.hasMarker = () => present;
    const held = registerGroup(pid, { marker: "recorded-marker" });
    present = false; // the leader is gone by the time the kill runs
    const kill = vi.spyOn(process, "kill").mockImplementation((() => true) as typeof process.kill);
    const logs: string[] = [];
    try {
      await expect(killProcessGroup(pid, { graceMs: 0, log: (l) => logs.push(l) })).resolves.toBe(false);
      expect(scans).toBeGreaterThan(0);
      expect(kill).not.toHaveBeenCalled();
      expect(logs.filter((l) => l.includes("termination unconfirmed"))).toHaveLength(1);
    } finally { held.release(); forgetGroup(pid); kill.mockRestore(); }
  });

  test("a pid registered again is a different group: the old lease signals nothing (#628 F29)", async () => {
    // The number was recycled while an earlier caller still owed its group a
    // kill. Registering it again used to REPLACE the held record, so the old
    // caller's teardown read the new spawn's captured members, SIGTERMed a
    // process it had never started, and retired the new caller's record on the
    // way out. Registrations are per (pid, incarnation): a lease addresses the
    // record it was given and no other. Nothing real is touched — the probes
    // describe the pids.
    const pid = 991341;
    let current = "spawn-incarnation";
    let live = true;
    processProbe.identityOf = (p) => (p === pid && live ? { start: current, zombie: false } : null);
    // Whatever holds the number leads the group and carries ITS own marker.
    processProbe.membersOf = (g) => (g === pid && live ? [{ pid, start: current, zombie: false }] : []);
    processProbe.hasMarker = (_p, marker) => marker === current;
    const first = registerGroup(pid, { marker: "spawn-incarnation" });
    current = "new-incarnation"; // the first leader exited; a new spawn got the pid
    const second = registerGroup(pid, { marker: "new-incarnation" });
    // The pid now names the newest registration…
    expect(spawnedGroupIdentity(pid)).toMatchObject({ start: "new-incarnation", marker: "new-incarnation" });
    const signals: Array<[number, string | number | undefined]> = [];
    const kill = vi.spyOn(process, "kill").mockImplementation(((p: number, s: NodeJS.Signals) => { signals.push([p, s]); live = false; return true; }) as typeof process.kill);
    const logs: string[] = [];
    try {
      // …while the FIRST caller's teardown still speaks for what IT spawned.
      await expect(killProcessGroup(pid, { group: first, marker: "spawn-incarnation", graceMs: 0, log: (l) => logs.push(l) })).resolves.toBe(false);
      expect(signals).toEqual([]); // the new process is never signalled
      expect(logs.some((l) => l.includes("not the process spawned here"))).toBe(true);
      // The newer registration is untouched by the older caller's retirement…
      expect(spawnedGroupIdentity(pid)).toMatchObject({ start: "new-incarnation", marker: "new-incarnation" });
      // …and still reaches its own process when ITS holder tears it down.
      await expect(killProcessGroup(pid, { group: second, marker: "new-incarnation", graceMs: 0, log: (l) => logs.push(l) })).resolves.toBe(true);
      expect(signals).toEqual([[-pid, "SIGTERM"]]);
    } finally { kill.mockRestore(); first.release(); second.release(); forgetGroup(pid); }
  });

  test.each([["a registration", true], ["a persisted identity", false]] as const)(
    "an unreadable start time is not an identity: %s is refused, never signalled (#628 F29)",
    async (_label, registered) => {
      // No /proc and no usable `ps`: the pid is alive but its start time reads
      // back as `?`. A recorded `?` compared against a current `?` used to
      // pass for identity and authorised kill(-pgid) on an occupant nobody
      // could identify. Unknown never matches unknown.
      const pid = 991342;
      processProbe.identityOf = (p) => (p === pid ? { start: "?", zombie: false } : null);
      processProbe.membersOf = () => null;
      processProbe.hasMarker = () => null;
      const held = registered ? registerGroup(pid, { marker: "tok-unknown" }) : null;
      const signals: Array<[number, string | number | undefined]> = [];
      const kill = vi.spyOn(process, "kill").mockImplementation(((p: number, s: NodeJS.Signals) => { signals.push([p, s]); return true; }) as typeof process.kill);
      const logs: string[] = [];
      try {
        await expect(killProcessGroup(pid, {
          group: held ?? undefined,
          marker: "tok-unknown",
          spawnStart: registered ? undefined : "?",
          graceMs: 0,
          log: (l) => logs.push(l),
        })).resolves.toBe(false);
        expect(signals).toEqual([]); // no kill(-pgid), no single-process kill
        expect(logs.some((l) => l.includes("cannot be proven to be the process spawned here"))).toBe(true);
      } finally { kill.mockRestore(); held?.release(); forgetGroup(pid); }
    },
  );

  test("a launcher that exited before its start time was sampled captures nothing from the incarnation that reused its pid (#628 F30)", async () => {
    // No /proc on this platform, so `hasMarker` can answer nothing, AND the
    // launcher was already gone when registerGroup looked at it — the record
    // therefore holds no start time at all. The number is then reused, and the
    // new incarnation forks a child into its own group. Reading "no recorded
    // start" as "the leader is present" made the bare pgid proof again: the
    // refresh at the top of the kill enrolled the STRANGER's child into this
    // record, and killProcessGroup — which correctly refuses to signal the
    // launcher pid itself — SIGTERMed that child individually. Holding the old
    // generation's lease is no defence when the refresh contaminates the very
    // record the lease points at. Nothing real is touched here: the probes
    // describe the pids.
    const pid = 991343;
    const child = pid + 1;
    let phase: "register" | "kill" = "register";
    let childLive = true;
    processProbe.identityOf = (p) => {
      if (phase === "register") return null; // the launcher exited before it was sampled
      if (p === pid) return { start: "new-incarnation", zombie: false };
      return p === child && childLive ? { start: "new-child", zombie: false } : null;
    };
    processProbe.membersOf = () => phase === "register" ? [] : [
      { pid, start: "new-incarnation", zombie: false },
      ...(childLive ? [{ pid: child, start: "new-child", zombie: false }] : []),
    ];
    processProbe.hasMarker = () => null; // no /proc: no candidate can prove anything
    const held = registerGroup(pid, { marker: "tok-f30" });
    expect(spawnedGroupIdentity(pid)).toMatchObject({ start: undefined, members: [] });
    phase = "kill"; // the pid is recycled; the new leader forks a child of its own
    held.refresh(true); // the opportunistic widening a spawn site does
    expect(spawnedGroupIdentity(pid)!.members).toEqual([]); // still nothing provably ours
    const signals: Array<[number, string | number | undefined]> = [];
    const kill = vi.spyOn(process, "kill").mockImplementation(((p: number, s: NodeJS.Signals) => {
      signals.push([p, s]);
      if (p === child) childLive = false;
      return true;
    }) as typeof process.kill);
    const logs: string[] = [];
    try {
      await expect(killProcessGroup(pid, { group: held, marker: "tok-f30", graceMs: 0, log: (l) => logs.push(l) })).resolves.toBe(false);
      expect(signals).toEqual([]); // not the stranger leader, and not its child
      expect(childLive).toBe(true);
      expect(logs.some((l) => l.includes("termination unconfirmed"))).toBe(true);
    } finally { kill.mockRestore(); held.release(); forgetGroup(pid); }
  });

  test("ownedGroupMembers tells 'searched and conclusive' apart from 'searched but unreadable' (#628 F30)", () => {
    // The group CAN be enumerated, and lists a live process — but without
    // /proc no candidate's JOY_PGROUP can be read, so the search classifies
    // nothing. An empty `pids` from that scan says as little as one from a
    // scan that never ran, and a caller must be able to tell the difference.
    const pgid = 991344;
    const child = pgid + 1;
    processProbe.identityOf = (p) => (p === child ? { start: "child-start", zombie: false } : null);
    processProbe.membersOf = () => [{ pid: child, start: "child-start", zombie: false }];
    processProbe.hasMarker = () => null; // unreadable: undecided, NOT "not ours"
    expect(ownedGroupMembers(pgid, { marker: "tok-f30" })).toEqual({ searched: true, pids: [], unclassified: 1 });
    processProbe.hasMarker = () => false; // readable, and positively someone else's
    expect(ownedGroupMembers(pgid, { marker: "tok-f30" })).toEqual({ searched: true, pids: [], unclassified: 0 });
    processProbe.hasMarker = () => true; // readable, and ours
    expect(ownedGroupMembers(pgid, { marker: "tok-f30" })).toEqual({ searched: true, pids: [child], unclassified: 0 });
    processProbe.membersOf = () => null; // nowhere to look at all
    expect(ownedGroupMembers(pgid, { marker: "tok-f30" })).toEqual({ searched: false, pids: [], unclassified: 0 });
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

describe("BoundedTail", () => {
  // `gc` without --expose-gc on the worker: turn the flag on at runtime and
  // pull the function out of a fresh context (the flag applies to contexts
  // created after it is set).
  v8.setFlagsFromString("--expose-gc");
  const gc = vm.runInNewContext("gc") as () => void;
  const collect = async () => { for (let i = 0; i < 4; i++) { await new Promise((r) => setImmediate(r)); gc(); } };
  const MiB = 1024 * 1024;

  test("keeps the last maxBytes across chunks and accounts for every byte that fell out", () => {
    const t = new BoundedTail(8);
    t.push("abcdef");
    t.push("ghij"); // 10 bytes total: 2 fall out
    expect(t.text()).toBe("cdefghij");
    expect(t.droppedBytes).toBe(2);
    t.push("0123456789ab"); // a chunk larger than the window: everything retained so far falls out too
    expect(t.text()).toBe("456789ab");
    expect(t.droppedBytes).toBe(2 + 8 + 4);
    expect(t.byteLength).toBe(8);
  });

  test("a chunk larger than the window is never retained as a view: backing memory stays at the cap (#69)", async () => {
    await collect();
    const before = process.memoryUsage().arrayBuffers;
    const t = new BoundedTail(16384);
    (function pushOneHugeChunk() { t.push(Buffer.alloc(48 * MiB, 0x78)); })();
    await collect();
    const held = process.memoryUsage().arrayBuffers - before;
    expect(t.byteLength).toBe(16384);
    expect(t.text()).toBe("x".repeat(16384));
    expect(held).toBeLessThan(1 * MiB); // the 48 MiB chunk is gone; only the ≤16 KiB tail (plus pool slack) remains
    // and a view handed in by the caller (a slice of a large pipe read) is copied too
    const big = Buffer.alloc(8 * MiB, 0x79);
    t.push(big.subarray(big.length - 10));
    expect(t.text().endsWith("y".repeat(10))).toBe(true);
    big.fill(0); // mutating the caller's buffer must not reach the retained tail
    expect(t.text().endsWith("y".repeat(10))).toBe(true);
  });
});
