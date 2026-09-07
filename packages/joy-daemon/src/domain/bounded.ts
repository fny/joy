// Lifecycle and bounded-I/O primitives (review campaign 2026-09, Wave B:
// #489 #590 #594 #595 #597, and the group-kill logic behind #571).
//
// The family: an operation that can wait forever, hold a descriptor past its
// error path, keep listeners on a process it no longer owns, or buffer output
// for a reader that never drains. Each site had its own partial answer; these
// are the shared ones. Every helper here is small on purpose — the point is
// that a site cannot get the fence wrong by writing it inline.

import { spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";

// ── deadlines ────────────────────────────────────────────────────────────────

/**
 * Settle `promise` within `ms` or fall back to `onTimeout`. The fence is
 * real: after the deadline the original promise's later result is IGNORED,
 * and `onTimeout` is where the caller aborts the underlying operation (kill
 * the process, destroy the request) and produces the fallback value or throws.
 */
export function withDeadline<T>(promise: Promise<T>, ms: number, onTimeout: () => T | Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { resolve(onTimeout()); } catch (e) { reject(e); }
    }, ms);
    timer.unref?.();
    promise.then(
      (v) => { if (done) return; done = true; clearTimeout(timer); resolve(v); },
      (e) => { if (done) return; done = true; clearTimeout(timer); reject(e); },
    );
  });
}

// ── bounded synchronous subprocess ───────────────────────────────────────────

export interface BoundedSyncResult {
  ok: boolean;
  /** stdout, decoded as UTF-8 and NOT trimmed: capture-pane rows keep their
   *  leading whitespace and blank lines (#595). Scalar readers trim. */
  out: string;
  stderr: string;
  /** The child was killed because it exceeded the deadline (#594). */
  timedOut: boolean;
  status: number | null;
}

/**
 * spawnSync with a hard deadline. A synchronous child blocks the whole event
 * loop, so a child that never exits (a wedged tmux server) freezes every
 * session, the HTTP transport and every timer; the deadline turns that into a
 * failed result. SIGKILL, not SIGTERM: the child is by definition not
 * responding. Callers that need sync semantics keep them — only the unbounded
 * wait is removed.
 */
export function spawnSyncBounded(cmd: string, args: readonly string[], timeoutMs: number): BoundedSyncResult {
  const r = spawnSync(cmd, [...args], { stdio: ["ignore", "pipe", "pipe"], timeout: timeoutMs, killSignal: "SIGKILL" });
  const err = r.error as (NodeJS.ErrnoException | undefined);
  const timedOut = err?.code === "ETIMEDOUT";
  return {
    ok: !err && r.status === 0,
    out: r.stdout?.toString("utf8") ?? "",
    stderr: r.stderr?.toString("utf8") ?? "",
    timedOut,
    status: r.status,
  };
}

// ── retiring a child process ─────────────────────────────────────────────────

const noop = (): void => {};

/**
 * Let go of a child process the owner no longer wants events from, WITHOUT
 * letting its late 'error' crash the daemon (#590). `removeAllListeners()`
 * alone is the bug: a spawn failure (ENOENT, EACCES, EAGAIN) is delivered
 * asynchronously, and an 'error' event with no listener is thrown at the
 * event loop. So lifecycle listeners are removed, terminal error sinks are
 * installed on the process and each of its pipes, stdin is closed, and the
 * process is killed if it is still alive.
 */
export function retireChildProcess(proc: ChildProcess | null | undefined, opts: { stdin?: "end" | "destroy" } = {}): void {
  if (!proc) return;
  proc.removeAllListeners();
  for (const s of [proc.stdin, proc.stdout, proc.stderr]) s?.removeAllListeners();
  proc.on("error", noop);
  for (const s of [proc.stdin, proc.stdout, proc.stderr]) s?.on("error", noop);
  try {
    if (opts.stdin === "destroy") proc.stdin?.destroy();
    else proc.stdin?.end();
  } catch { /* already gone */ }
  try { proc.kill(); } catch { /* already gone */ }
}

// ── process-group kill with escalation ───────────────────────────────────────

/** Is `pid` alive (signal 0 delivered)? A zombie counts as alive here. */
export function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Name of the env marker a spawn site can stamp on a process group so the
 *  kill can prove a pid is ITS OWN before signalling it (#628, part c). */
export const PGROUP_MARKER_ENV = "JOY_PGROUP";

/** A fresh marker value for one spawned group. Pass `{ [PGROUP_MARKER_ENV]: token }`
 *  in the child's env and the same token as `marker` to killProcessGroup. */
export function newProcessGroupMarker(): string {
  return `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** What identifies one incarnation of a pid: its start time. A reused pid
 *  has a different one. `start` is /proc/<pid>/stat field 22 (clock ticks
 *  since boot) on Linux, `ps -o lstart=` elsewhere. */
export interface ProcessIdentity {
  start: string;
  zombie: boolean;
}

/** Start id reported when the pid is alive but no platform facility can
 *  read its start time (no /proc AND no usable ps). Two reads of such a pid
 *  compare equal, which degrades to the old kill(pid, 0) evidence. */
const UNKNOWN_START = "?";

let procAvailable: boolean | null = null;
function hasProc(): boolean {
  if (procAvailable === null) { try { fs.readdirSync("/proc/self"); procAvailable = true; } catch { procAvailable = false; } }
  return procAvailable;
}

/** The post-`)` fields of /proc/<pid>/stat: state(0) ppid(1) pgrp(2) …
 *  starttime(19) — comm can contain spaces and parens, so split after the
 *  LAST ')'. `null` when the pid is not there. */
function procStatFields(pid: number): string[] | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  } catch { return null; }
}

/** Parse one `ps -o pid=,pgid=,stat=,lstart=` row. lstart contains spaces,
 *  so it is whatever follows the three fixed columns. */
function parsePsRow(line: string): { pid: number; pgid: number; zombie: boolean; start: string } | null {
  const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
  if (!m) return null;
  return { pid: Number(m[1]), pgid: Number(m[2]), zombie: m[3].startsWith("Z"), start: m[4] };
}

function psRows(args: string[]): NonNullable<ReturnType<typeof parsePsRow>>[] | null {
  try {
    const r = spawnSync("ps", args, { encoding: "utf8", timeout: 5_000 });
    if (r.error || !r.stdout) return null;
    return r.stdout.split("\n").map(parsePsRow).filter((x): x is NonNullable<typeof x> => x !== null);
  } catch { return null; }
}

/**
 * The platform probes behind the group kill, on one object so a test can
 * substitute a pgid lookup or a start time (simulating a reused pid without
 * racing the kernel's allocator). Production code never reassigns these.
 */
export const processProbe = {
  /** `null` when `pid` is not there. */
  identityOf(pid: number): ProcessIdentity | null {
    if (hasProc()) {
      const f = procStatFields(pid);
      return f && f[19] !== undefined ? { start: f[19], zombie: f[0] === "Z" } : null;
    }
    const rows = psRows(["-o", "pid=,pgid=,stat=,lstart=", "-p", String(pid)]);
    if (rows === null) return pidAlive(pid) ? { start: UNKNOWN_START, zombie: false } : null;
    const row = rows.find((r) => r.pid === pid);
    return row ? { start: row.start, zombie: row.zombie } : null;
  },
  /** Every process whose pgid is `pgid`, with its identity. Per-pid failures
   *  are skipped — a process vanishing between readdir and read must not end
   *  the scan. `null` when the platform cannot list processes at all. */
  membersOf(pgid: number): Array<{ pid: number } & ProcessIdentity> | null {
    if (hasProc()) {
      const out: Array<{ pid: number } & ProcessIdentity> = [];
      let entries: string[] = [];
      try { entries = fs.readdirSync("/proc"); } catch { return null; }
      for (const d of entries) {
        if (!/^\d+$/.test(d)) continue;
        const f = procStatFields(Number(d));
        if (f && Number(f[2]) === pgid && f[19] !== undefined) out.push({ pid: Number(d), start: f[19], zombie: f[0] === "Z" });
      }
      return out;
    }
    const rows = psRows(["-A", "-o", "pid=,pgid=,stat=,lstart="]);
    return rows === null ? null : rows.filter((r) => r.pgid === pgid).map(({ pid, start, zombie }) => ({ pid, start, zombie }));
  },
  /** Does `pid`'s initial environment carry `JOY_PGROUP=<marker>`? Linux
   *  only (/proc/<pid>/environ): `null` where it cannot be checked, `false`
   *  when environ is unreadable for a LIVE pid that exists — a process this
   *  daemon spawned is always readable by it, so "cannot read" means "not
   *  ours". A ZOMBIE is the exception: it has already released its memory,
   *  so its environ is empty/unreadable for everyone, and reading that as
   *  "not ours" disowned a group whose leader had just exited (its pid is
   *  still un-reusable, so the pgid is still proof) — `null` there. */
  hasMarker(pid: number, marker: string): boolean | null {
    if (!hasProc()) return null;
    let raw = "";
    try {
      raw = fs.readFileSync(`/proc/${pid}/environ`, "latin1");
      if (raw.split("\0").includes(`${PGROUP_MARKER_ENV}=${marker}`)) return true;
    } catch { /* gone, a zombie, or not ours — decided below */ }
    return raw.length === 0 && processProbe.identityOf(pid)?.zombie === true ? null : false;
  },
};

/**
 * Live (non-zombie) members of the process group `pgid`, plus the leader
 * itself when it is alive and not a zombie. Diagnostic and test helper: the
 * kill below does NOT identify a group this way once its leader is gone
 * (#628) — see killProcessGroup.
 */
export function processGroupMembers(pgid: number): number[] {
  const out = (processProbe.membersOf(pgid) ?? []).filter((m) => !m.zombie).map((m) => m.pid);
  if (!out.includes(pgid)) {
    const leader = processProbe.identityOf(pgid);
    if (leader && !leader.zombie) out.push(pgid);
  }
  return out;
}

// ── spawn-time group identity (#628) ─────────────────────────────────────────
//
// A pgid is only a NAME for a group; the identity is the leader's incarnation
// (pid + start time) plus what that group contained while the leader lived.
// Both must be captured at SPAWN, not at the first signal: a leader that exits
// before the kill runs — a shell that backgrounds a job and returns, which is
// the ordinary shape of `sh -c 'cmd & …'` — leaves the helper with nothing but
// a stale pid, and "no evidence" was being reported as "terminated" while the
// job it left behind kept running (#628, Wave F14).

interface SpawnedGroup {
  pid: number;
  /** The leader's start time at spawn; `undefined` when the platform could
   *  not read one (the identity check then degrades to "the pid exists"). */
  start?: string;
  /** The `JOY_PGROUP` token stamped on the spawn's environment, if any. */
  marker?: string;
  /** pid → start time of every process seen in the group while it was
   *  provably ours. The leader is the first entry. */
  members: Map<number, string>;
  lastScanAt: number;
  /** How many callers still hold this registration (#628 F21). A spawn site
   *  takes one at registerGroup and drops it when its run settles; while it
   *  is held the record is the caller's only proof of WHICH process it
   *  spawned, so the sweep must not collect it. */
  holds: number;
}

/** Groups this daemon created, by leader pid. Entries are dropped when the
 *  group is killed (killProcessGroup) or retired (forgetGroup). */
const spawnedGroups = new Map<number, SpawnedGroup>();
/** Above this many live records, dead ones are swept on the next register. */
const GROUP_SWEEP_AT = 64;
/** Minimum gap between opportunistic /proc scans for one group. */
const GROUP_SCAN_INTERVAL_MS = 200;

/** A caller's claim on a registration. Held from the spawn until the run
 *  settles: the sweep below never collects a held record, so a group's
 *  identity cannot be scavenged out from under the caller that is still
 *  responsible for killing it (#628 F21). Releasing the last claim retires
 *  the record. */
export interface GroupRegistration {
  readonly pid: number;
  /** Give up this caller's claim. Idempotent, and a no-op once the record has
   *  already been retired (by killProcessGroup or forgetGroup). */
  release(): void;
}

/**
 * Record a process group at the moment it is spawned: the leader's start time
 * (so a later kill can tell the group apart from whatever inherits its pid)
 * and the marker its children inherit. Call it right after a detached spawn,
 * with the same token that was put in the child's `JOY_PGROUP`.
 *
 * The returned registration is a LEASE (#628 F21): hold it for as long as the
 * caller may still have to signal that group, and release it when the run
 * settles. A registration the sweep can evict while a caller still intends to
 * kill through it is worse than no registration at all — the kill then has no
 * start-time fence and the pid's current occupant, which may be an unrelated
 * process that inherited the number, looks like the leader.
 */
export function registerGroup(pid: number, opts: { marker?: string; start?: string } = {}): GroupRegistration {
  if (!Number.isInteger(pid) || pid <= 0) return { pid, release() { /* nothing was recorded */ } };
  if (spawnedGroups.size >= GROUP_SWEEP_AT) sweepSpawnedGroups();
  const start = opts.start ?? processProbe.identityOf(pid)?.start;
  const members = new Map<number, string>();
  if (start !== undefined) members.set(pid, start);
  const rec: SpawnedGroup = { pid, start, marker: opts.marker, members, lastScanAt: 0, holds: 1 };
  spawnedGroups.set(pid, rec);
  refreshGroupMembers(pid, { force: true });
  let released = false;
  return {
    pid,
    release() {
      if (released) return;
      released = true;
      // Only this record's claim is dropped: if the pid was re-registered (or
      // the record already retired) the entry now belongs to someone else.
      if (spawnedGroups.get(pid) !== rec) return;
      rec.holds -= 1;
      // Nobody's obligation any more: collect it now if the group is provably
      // finished, otherwise leave it for the sweep — a caller being done does
      // not mean the processes are.
      if (rec.holds <= 0 && groupCollectable(rec)) spawnedGroups.delete(pid);
    },
  };
}

/** Forget a registered group — its leader has been reaped and the caller no
 *  longer intends to signal it. */
export function forgetGroup(pid: number): void { spawnedGroups.delete(pid); }

/** The spawn identity recorded for `pid`, for diagnostics, persistence and
 *  tests. `undefined` when the group was never registered here. */
export function spawnedGroupIdentity(pid: number): { start?: string; marker?: string; members: number[] } | undefined {
  const rec = spawnedGroups.get(pid);
  return rec ? { start: rec.start, marker: rec.marker, members: [...rec.members.keys()] } : undefined;
}

/**
 * Bound the registry: a long-lived daemon must not accumulate one entry per
 * tool run. It is ONLY a memory bound, never an expiry — evicting a record
 * that a caller still needs re-opens the very defect the registry exists to
 * close (#628 F21: after enough unrelated spawns, the kill lost the start
 * time of a group whose leader had exited and fell back to signalling
 * whatever now held the pid). So a record goes only when
 *   - no caller still holds it (its lease was released), AND
 *   - its leader is CONFIRMED gone — the pid is free, or a different
 *     incarnation now holds it; "cannot tell" keeps the record, AND
 *   - nothing captured under it is still alive.
 */
function sweepSpawnedGroups(): void {
  for (const [pid, rec] of spawnedGroups) if (rec.holds <= 0 && groupCollectable(rec)) spawnedGroups.delete(pid);
}

/** Is there provably nothing left for this record to identify? True only when
 *  the LEADER is confirmed gone — its pid free, or a different incarnation on
 *  it — and nothing captured under it is still alive. "Cannot tell" is false:
 *  a record is never dropped on a guess (#628 F21). */
function groupCollectable(rec: SpawnedGroup): boolean {
  const leader = processProbe.identityOf(rec.pid);
  const leaderGone = leader === null
    || (rec.start !== undefined && rec.start !== UNKNOWN_START && leader.start !== rec.start);
  if (!leaderGone) return false;
  return ![...rec.members].some(([p, start]) => {
    const now = processProbe.identityOf(p);
    return now !== null && !now.zombie && now.start === start;
  });
}

/** Add every member of `pgid` that is provably ours to `into`. The bare pgid
 *  is proof only while the leader is verifiably still there; with a marker
 *  each hit proves itself through its own environment.
 *
 *  Returns whether the group was actually SEARCHED: false when there was no
 *  admissible way to look (no leader and no marker) and false when the
 *  platform could not list processes at all. An empty result from a scan that
 *  never happened is not evidence of an empty group (#628 F21). */
function captureMembers(pgid: number, marker: string | undefined, leaderHere: boolean, into: Map<number, string>): boolean {
  if (!leaderHere && marker === undefined) return false;
  const rows = processProbe.membersOf(pgid);
  if (rows === null) return false;
  for (const m of rows) {
    if (m.zombie || into.has(m.pid)) continue;
    if (marker === undefined) { if (leaderHere) into.set(m.pid, m.start); continue; }
    const has = processProbe.hasMarker(m.pid, marker);
    if (has === true || (has === null && leaderHere)) into.set(m.pid, m.start);
  }
  return true;
}

/**
 * Opportunistically widen a registered group's captured membership. Cheap and
 * safe to call from a hot path (it scans at most every 200ms, and only while
 * the group is still identifiable): every call makes a leader that exits early
 * less likely to take its descendants out of reach.
 */
export function refreshGroupMembers(pid: number, opts: { force?: boolean } = {}): void {
  const rec = spawnedGroups.get(pid);
  if (!rec) return;
  const now = Date.now();
  if (!opts.force && now - rec.lastScanAt < GROUP_SCAN_INTERVAL_MS) return;
  rec.lastScanAt = now;
  const leader = processProbe.identityOf(pid);
  const leaderHere = leader !== null && (rec.start === undefined || leader.start === rec.start);
  captureMembers(pid, rec.marker, leaderHere, rec.members);
}

/**
 * Is the process now occupying `pid` the one whose spawn identity is
 * `expected` (start time and/or `JOY_PGROUP` marker)? False when the pid is
 * free, or when it has been reused by an unrelated process — the caller must
 * then NOT signal it. With nothing expected and no registration, "the pid
 * exists" is all that can be said, which is the pre-#628 contract.
 */
export function isSpawnedGroupLeader(pid: number, expected: { start?: string; marker?: string } = {}): boolean {
  const now = processProbe.identityOf(pid);
  if (!now) return false;
  const rec = spawnedGroups.get(pid);
  const start = expected.start ?? rec?.start;
  if (start !== undefined && start !== UNKNOWN_START && now.start !== start) return false;
  const marker = expected.marker ?? rec?.marker;
  if (marker !== undefined && processProbe.hasMarker(pid, marker) === false) return false;
  return true;
}

export interface KillProcessGroupOptions {
  /** How long SIGTERM gets before SIGKILL. Default 2000ms. */
  graceMs?: number;
  /** Where escalation is reported. Default: stderr. */
  log?: (line: string) => void;
  /** The `JOY_PGROUP` value the group was spawned with. On Linux a pid is
   *  then signalled only when /proc/<pid>/environ carries it — including
   *  the leader — and a group whose leader is already gone can still be
   *  found through the marker rather than through the reusable pgid. Where
   *  environ cannot be read (no /proc) the marker is not enforced.
   *  Defaults to the marker recorded by registerGroup. */
  marker?: string;
  /** The leader's start time as recorded at spawn, for a group registered in
   *  ANOTHER process (a server pid read back from disk after a restart).
   *  In-process callers get this from registerGroup instead. */
  spawnStart?: string;
}

/**
 * Terminate the process group led by `pid` — SIGTERM, a grace period, then
 * SIGKILL to the group AND to every surviving member individually — and
 * report whether the group is gone. Falls back to a single-process kill when
 * `pid` is not a group leader. Resolves false when members survived SIGKILL,
 * so a caller can refuse to start a replacement on top of them.
 *
 * Ownership (#628): a pgid equals its leader's pid and is only unambiguous
 * while that pid still exists (alive, or a zombie not yet reaped). Once the
 * leader is reaped the number is free, and the next process to be born with
 * it — the next vitest worker, a `timeout` wrapper, anything — leads an
 * UNRELATED group; scanning for "pgid == dead leader" then SIGKILLed the
 * test runner (exit 143). So:
 *   - the group's members are captured (pid + start time) from the SPAWN
 *     onwards — at registration, on every opportunistic refresh, on entry
 *     here and on every poll — for as long as the leader exists: that is the
 *     only window in which the pgid is proof of membership (the #571
 *     survivor that outlives its leader is captured here);
 *   - after the leader is gone, only captured pids whose start time still
 *     matches are signalled, one by one — a reused pid has a different start
 *     time — and kill(-pgid) is never sent again;
 *   - with a `marker`, membership is additionally proven through the
 *     process's environment, which is also the only way a group whose
 *     leader was already gone when this was called is identified at all;
 *   - a group registered at spawn (registerGroup) brings its OWN evidence:
 *     the leader's start time, so a pid reused before this was even entered
 *     is recognised and never signalled, and the members captured while the
 *     leader lived, which are signalled individually once it is gone. A
 *     leader that exits before the deadline no longer takes its descendants
 *     out of reach (#628, Wave F14);
 *   - that registration is a LEASE the caller holds until its run settles, so
 *     the registry's sweep cannot scavenge the start-time fence while the kill
 *     is still owed — and with a group claimed under the pid (a marker, a
 *     recorded start, a registration) the occupant is signalled only when it
 *     is POSITIVELY identified: no start-time match and no readable marker
 *     means nothing is signalled at all (#628, Wave F21).
 *
 * The verdict is evidence-based: `true` means the group was searched and
 * nothing of it survives. When a group the daemon registered cannot be
 * searched at all — its leader vanished, no marker can be verified here and
 * nothing but the leader was ever captured — this resolves FALSE
 * (termination unconfirmed) rather than claiming a kill that never happened.
 * An unregistered pid carries no such claim (nobody here says a group ever
 * existed under it), so it keeps the older contract and resolves true.
 */
export async function killProcessGroup(pid: number, opts: KillProcessGroupOptions = {}): Promise<boolean> {
  const graceMs = opts.graceMs ?? 2000;
  const log = opts.log ?? ((line: string) => process.stderr.write(line + "\n"));
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const tick = 100;
  const rounds = Math.max(1, Math.ceil(graceMs / tick));

  // Last chance to widen the captured set while the leader may still exist.
  refreshGroupMembers(pid, { force: true });
  const rec = spawnedGroups.get(pid);
  const marker = opts.marker ?? rec?.marker;
  const spawnStart = opts.spawnStart ?? rec?.start;
  /** What was captured while the group was provably ours. */
  const captured = new Map<number, string>(rec?.members ?? []);
  // The registration is consumed here: this call is the group's retirement.
  forgetGroup(pid);

  // The leader's own incarnation, fixed at entry: the pid this was called
  // with must still be that process on every later probe — and it must be
  // the process that was spawned, not whatever the kernel handed the number
  // to afterwards. A pid that fails that test is NOT treated as the leader
  // (no kill(-pgid), no single-process kill); only captured members and, with
  // a marker, self-proving ones can still be signalled.
  const occupant = processProbe.identityOf(pid);
  const reused = occupant !== null && spawnStart !== undefined && spawnStart !== UNKNOWN_START && occupant.start !== spawnStart;
  const markerProof = occupant !== null && marker !== undefined ? processProbe.hasMarker(pid, marker) : null;
  const foreign = markerProof === false;
  // Absence of a mismatch is NOT identification (#628 F21). The occupant is
  // the leader only when something positively says so: its start time is the
  // one recorded at spawn, or its own environment carries our marker. When a
  // group was claimed under this pid — a marker, a recorded start time, a
  // registration — and neither proof is available (the start time was never
  // read, or /proc is not there to check the marker), the pid is UNIDENTIFIED
  // and nothing is signalled through it. Falling back to "the pid exists" is
  // how a scavenged registration turned kill(-pgid) loose on a stranger.
  const identified = (occupant !== null && spawnStart !== undefined && occupant.start === spawnStart) || markerProof === true;
  /** Did anyone claim a group ever existed under this pid? With no marker, no
   *  recorded start and no registration there is nothing to prove and nothing
   *  to disprove: "the pid exists" is all there ever was (pre-#628 contract). */
  const claimed = marker !== undefined || spawnStart !== undefined || rec !== undefined;
  if (reused) log(`[kill-group] pid ${pid} is not the process spawned here (start ${occupant!.start} ≠ ${spawnStart}) — refusing to signal it`);
  else if (foreign) log(`[kill-group] pid ${pid} does not carry ${PGROUP_MARKER_ENV}=${marker} — not ours, refusing to signal it`);
  else if (occupant !== null && claimed && !identified) log(`[kill-group] pid ${pid} cannot be proven to be the process spawned here (no start-time or ${PGROUP_MARKER_ENV} match) — refusing to signal it`);
  const leaderAtEntry = occupant !== null && !reused && !foreign && (identified || !claimed) ? occupant : null;
  const leaderPresent = (): boolean => leaderAtEntry !== null && processProbe.identityOf(pid)?.start === leaderAtEntry.start;

  /** pid → start time of every member proven to be ours. */
  const owned = new Map<number, string>(captured);
  if (leaderAtEntry) owned.set(pid, leaderAtEntry.start);
  /** Did any scan of the group actually happen? A platform that cannot list
   *  processes returns nothing from every scan, which must not read as "the
   *  group is empty" (#628 F21). */
  let searched = false;
  const capture = (): void => { if (captureMembers(pid, marker, leaderPresent(), owned)) searched = true; };
  const survivors = (): number[] => {
    capture();
    const out: number[] = [];
    for (const [p, start] of owned) {
      const now = processProbe.identityOf(p);
      if (now && !now.zombie && now.start === start) out.push(p);
    }
    return out;
  };
  const signal = (sig: NodeJS.Signals): void => {
    // Group-wide delivery only while the leader exists: -pgid is unambiguous
    // then, and it reaches a member forked between capture and signal.
    if (leaderPresent()) { try { process.kill(-pid, sig); } catch { /* not a group leader: single-process below */ } }
    for (const p of survivors()) { try { process.kill(p, sig); } catch { /* gone */ } }
  };

  if (survivors().length === 0) {
    // Nothing of ours is alive — but "nothing found" is only a termination
    // when there was somewhere to look. A registered group whose leader is
    // gone, with no verifiable marker and nothing captured beyond the leader,
    // was never searched: say so instead of confirming a kill (#628 F14).
    // A marker only makes the group findable if the group could be ENUMERATED
    // (and the marker itself read): with `membersOf` returning null on every
    // scan there was nowhere to look, and a marked record whose leader has
    // vanished is then unconfirmed rather than gone (#628 F21).
    const markerCheckable = marker !== undefined && searched && processProbe.hasMarker(pid, marker) !== null;
    const searchable = leaderAtEntry !== null || markerCheckable || captured.size > 1;
    if (!searchable && rec) {
      log(`[kill-group] group ${pid}: its leader was already gone and the group could not be searched (nothing captured${marker !== undefined && !searched ? ", no process listing available" : ""}) — termination unconfirmed`);
      return false;
    }
    return true;
  }
  signal("SIGTERM");
  for (let i = 0; i < rounds && survivors().length; i++) await sleep(tick);
  let left = survivors();
  if (left.length) {
    log(`[kill-group] group ${pid} survived SIGTERM (${left.join(",")}) — escalating to SIGKILL`);
    signal("SIGKILL");
    for (let i = 0; i < rounds && survivors().length; i++) await sleep(tick);
    left = survivors();
    if (left.length) { log(`[kill-group] group ${pid}: ${left.join(",")} still alive after SIGKILL`); return false; }
  }
  return true;
}

/**
 * The live members of `pgid` that PROVE they are ours, usable after the leader
 * has exited — when the bare pgid is a reusable number and no longer evidence
 * of anything (#628). A pid qualifies when its own environment carries the
 * spawn's `JOY_PGROUP` marker, or when it matches a (pid, start time) pair
 * captured while the group was provably ours — the registration made at spawn,
 * or a `members` list persisted from an earlier daemon run.
 *
 * `searched` reports whether the platform could enumerate at all: an empty
 * list with `searched: false` means "nowhere to look", not "nothing there".
 */
export function ownedGroupMembers(
  pgid: number,
  opts: { marker?: string; members?: Iterable<readonly [number, string]> } = {},
): { searched: boolean; pids: number[] } {
  const rec = spawnedGroups.get(pgid);
  const marker = opts.marker ?? rec?.marker;
  const captured = new Map<number, string>(opts.members ?? rec?.members ?? []);
  const pids = new Set<number>();
  for (const [p, start] of captured) {
    const now = processProbe.identityOf(p);
    if (now !== null && !now.zombie && now.start === start) pids.add(p);
  }
  let searched = false;
  if (marker !== undefined) {
    const rows = processProbe.membersOf(pgid);
    if (rows !== null) {
      searched = true;
      for (const m of rows) { if (!m.zombie && processProbe.hasMarker(m.pid, marker) === true) pids.add(m.pid); }
    }
  }
  return { searched, pids: [...pids] };
}

// ── descriptor lifecycle ─────────────────────────────────────────────────────

/**
 * Open `path`, run `fn` with the descriptor, ALWAYS close it — including when
 * `fn` throws (#489: a readSync that failed left its descriptor open on every
 * retry until the daemon ran out). Errors from `fn` propagate after the close.
 */
export function withFd<T>(path: string, flags: fs.OpenMode, fn: (fd: number) => T): T {
  const fd = fs.openSync(path, flags);
  try { return fn(fd); }
  finally { try { fs.closeSync(fd); } catch { /* the descriptor is gone either way */ } }
}

// ── bounded response writer ──────────────────────────────────────────────────

// ── bounded stream tails ─────────────────────────────────────────────────────

/**
 * A fixed-size tail of a stream that must still be DRAINED (#69).
 *
 * The failure it replaces: a long-running child's stderr listener that kept
 * appending to a startup buffer for the life of the session, so the daemon
 * retained the server's entire log. Dropping the listener instead is worse —
 * an unread pipe fills at ~64 KiB and the child blocks on write forever. So:
 * read every chunk, keep only the last `maxBytes`, and hand the tail back for
 * a diagnostic ("what did it say before it died?").
 *
 * Bytes, not characters: chunks are concatenated and trimmed at the byte
 * level, then decoded once at read time, so a multibyte character split
 * across chunks survives. The trim can cut a character in half at the FRONT
 * of the window; `text()` drops the leading partial rather than emitting a
 * replacement character.
 */
export class BoundedTail {
  readonly maxBytes: number;
  #buf: Buffer = Buffer.alloc(0);
  #dropped = 0;
  constructor(maxBytes = 16 * 1024) { this.maxBytes = Math.max(1, maxBytes); }
  push(chunk: Buffer | string): void {
    const b = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    // The retained tail is ALWAYS a fresh allocation of at most maxBytes (#69
    // residual): a subarray of the concatenation — or of the caller's chunk —
    // is a view that pins the whole backing ArrayBuffer (a 48 MiB chunk stayed
    // live behind a 16 KiB "tail" until clear()). Buffer.concat / Buffer.from
    // copy, so the caller's memory is free the moment it drops it.
    if (b.length >= this.maxBytes) {
      // The chunk alone fills the window: everything retained so far falls out.
      this.#dropped += this.#buf.length + (b.length - this.maxBytes);
      this.#buf = Buffer.from(b.subarray(b.length - this.maxBytes));
      return;
    }
    const drop = Math.max(0, this.#buf.length + b.length - this.maxBytes);
    this.#dropped += drop;
    this.#buf = Buffer.concat([drop ? this.#buf.subarray(drop) : this.#buf, b]);
  }
  /** Bytes discarded because they fell out of the window. */
  get droppedBytes(): number { return this.#dropped; }
  get byteLength(): number { return this.#buf.length; }
  /** The retained tail, decoded. A leading partial character is dropped. */
  text(): string {
    let start = 0;
    // A UTF-8 continuation byte (10xxxxxx) at the front is the tail of a
    // character whose lead byte was trimmed away.
    while (start < this.#buf.length && (this.#buf[start] & 0xc0) === 0x80) start++;
    return this.#buf.subarray(start).toString("utf8");
  }
  clear(): void { this.#buf = Buffer.alloc(0); }
}

export interface BoundedSink {
  readonly writableLength: number;
  write(chunk: string): boolean;
  destroy(): void;
}

/**
 * A `write` for a long-lived response (SSE / NDJSON follow) that refuses to
 * buffer without bound (#597). `res.write` always accepts and queues; a client
 * that stops reading makes the queue grow with every broadcast until the
 * daemon's memory does. Once the pending bytes would exceed `maxBytes` the
 * client is dropped: `onOverflow` runs (unsubscribe), the sink is destroyed,
 * and every later write is a no-op returning false.
 */
export function boundedWriter(sink: BoundedSink, maxBytes: number, onOverflow: () => void): (chunk: string) => boolean {
  let dropped = false;
  return (chunk: string) => {
    if (dropped) return false;
    if (sink.writableLength + Buffer.byteLength(chunk) > maxBytes) {
      dropped = true;
      try { onOverflow(); } finally { try { sink.destroy(); } catch { /* already closed */ } }
      return false;
    }
    sink.write(chunk);
    return true;
  };
}
