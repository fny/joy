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
   *  when environ is unreadable for a pid that exists — a process this
   *  daemon spawned is always readable by it, so "cannot read" means "not
   *  ours". */
  hasMarker(pid: number, marker: string): boolean | null {
    if (!hasProc()) return null;
    try {
      return fs.readFileSync(`/proc/${pid}/environ`, "latin1").split("\0").includes(`${PGROUP_MARKER_ENV}=${marker}`);
    } catch { return false; }
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

export interface KillProcessGroupOptions {
  /** How long SIGTERM gets before SIGKILL. Default 2000ms. */
  graceMs?: number;
  /** Where escalation is reported. Default: stderr. */
  log?: (line: string) => void;
  /** The `JOY_PGROUP` value the group was spawned with. On Linux a pid is
   *  then signalled only when /proc/<pid>/environ carries it — including
   *  the leader — and a group whose leader is already gone can still be
   *  found through the marker rather than through the reusable pgid. Where
   *  environ cannot be read (no /proc) the marker is not enforced. */
  marker?: string;
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
 *   - the group's members are captured (pid + start time) at the first
 *     signal, while the leader exists, and re-captured on every poll for as
 *     long as it does — that is the only window in which the pgid is proof
 *     of membership (the #571 survivor that outlives its leader is captured
 *     here);
 *   - after the leader is gone, only captured pids whose start time still
 *     matches are signalled, one by one — a reused pid has a different start
 *     time — and kill(-pgid) is never sent again;
 *   - with a `marker`, membership is additionally proven through the
 *     process's environment, which is also the only way a group whose
 *     leader was already gone when this was called is identified at all.
 *     Without a marker such a call signals nothing (the leader pid is the
 *     only evidence, and it is stale) and resolves true.
 */
export async function killProcessGroup(pid: number, opts: KillProcessGroupOptions = {}): Promise<boolean> {
  const graceMs = opts.graceMs ?? 2000;
  const log = opts.log ?? ((line: string) => process.stderr.write(line + "\n"));
  const marker = opts.marker;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const tick = 100;
  const rounds = Math.max(1, Math.ceil(graceMs / tick));

  // The leader's own incarnation, fixed at entry: the pid this was called
  // with must still be that process on every later probe.
  const leaderAtEntry = processProbe.identityOf(pid);
  if (leaderAtEntry && marker !== undefined && processProbe.hasMarker(pid, marker) === false) {
    log(`[kill-group] pid ${pid} does not carry ${PGROUP_MARKER_ENV}=${marker} — not ours, refusing to signal`);
    return true;
  }
  const leaderPresent = (): boolean => leaderAtEntry !== null && processProbe.identityOf(pid)?.start === leaderAtEntry.start;
  /** A scanned pid may join the owned set when the marker proves it, or —
   *  while the leader exists, so the pgid itself is proof — when the marker
   *  is absent or unverifiable on this platform. */
  const proven = (p: number, leaderHere: boolean): boolean => {
    if (marker === undefined) return leaderHere;
    const has = processProbe.hasMarker(p, marker);
    return has === true || (has === null && leaderHere);
  };

  /** pid → start time of every member proven to be ours. */
  const owned = new Map<number, string>();
  if (leaderAtEntry) owned.set(pid, leaderAtEntry.start);
  const capture = (): void => {
    const leaderHere = leaderPresent();
    // A bare pgid scan is evidence only while the leader exists; with a
    // marker every hit is proven on its own.
    if (!leaderHere && marker === undefined) return;
    for (const m of processProbe.membersOf(pid) ?? []) {
      if (owned.has(m.pid) || m.zombie) continue;
      if (proven(m.pid, leaderHere)) owned.set(m.pid, m.start);
    }
  };
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

  if (survivors().length === 0) return true;
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
    const joined = this.#buf.length ? Buffer.concat([this.#buf, b]) : Buffer.from(b);
    if (joined.length <= this.maxBytes) { this.#buf = joined; return; }
    this.#dropped += joined.length - this.maxBytes;
    this.#buf = joined.subarray(joined.length - this.maxBytes);
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
