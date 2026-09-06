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

function procState(pid: number): string | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] ?? null;
  } catch { return null; }
}

/**
 * Live members of the process group led by `pgid`, plus the leader itself
 * when it is alive and not a zombie. Scans /proc so a child that outlived its
 * group leader is still found (#571): kill(-pgid, 0) says nothing once the
 * leader is gone, and probing only the leader hid the surviving server.
 * Per-pid failures are skipped — a process vanishing between readdir and read
 * must not end the scan.
 */
/** Enumeration outcome: `members` when the platform could actually list the
 *  group (an empty list then means "only zombies / nobody"), `null` when it
 *  could not (no /proc AND no usable ps) — the two must not be confused: a
 *  parent holding an exited child unreaped is a zombie-only group that is
 *  still addressable by kill(-pgid, 0), and treating "addressable but
 *  unenumerated" as survivors made killProcessGroup refuse a replacement
 *  although nothing executable remained (Astra on 4b47e729). */
export function enumerateProcessGroup(pgid: number): number[] | null {
  let entries: string[] = [];
  try { entries = fs.readdirSync("/proc"); } catch { /* no /proc */ }
  if (entries.length > 0) return processGroupMembers(pgid);
  try {
    const r = spawnSync("ps", ["-A", "-o", "pid=,pgid=,stat="], { encoding: "utf8", timeout: 5_000 });
    if (r.status !== 0 || !r.stdout) return null;
    const out: number[] = [];
    let targetListedZombie = false;
    for (const line of r.stdout.split("\n")) {
      const m = /^\s*(\d+)\s+(\d+)\s+(\S+)/.exec(line);
      if (!m) continue;
      const pid = Number(m[1]); const zombie = m[3].startsWith("Z");
      if (pid === pgid && zombie) targetListedZombie = true;
      if (Number(m[2]) === pgid && !zombie) out.push(pid);
    }
    // ps listed the world: a target that ps shows outside the group (a
    // non-leader pid) still counts when alive and not a zombie — and ps's own
    // positive zombie verdict wins over kill(pid, 0), which cannot tell a
    // zombie from a live process without /proc (Astra on b8dc2bf6).
    if (!out.includes(pgid) && !targetListedZombie && pidAlive(pgid) && procState(pgid) !== "Z") out.push(pgid);
    return out;
  } catch { return null; }
}

export function processGroupMembers(pgid: number): number[] {
  const out: number[] = [];
  let entries: string[] = [];
  try { entries = fs.readdirSync("/proc"); } catch { /* no /proc */ }
  if (entries.length === 0) {
    // No /proc (macOS, BSD): ask ps for pid/pgid/state of every process. A
    // surviving group whose leader exited was invisible here before, so
    // killProcessGroup declared victory after SIGTERM alone (Astra on da868c80).
    try {
      const r = spawnSync("ps", ["-A", "-o", "pid=,pgid=,stat="], { encoding: "utf8", timeout: 5_000 });
      for (const line of (r.stdout ?? "").split("\n")) {
        const m = /^\s*(\d+)\s+(\d+)\s+(\S+)/.exec(line);
        if (m && Number(m[2]) === pgid && !m[3].startsWith("Z")) out.push(Number(m[1]));
      }
      return out;
    } catch { /* fall through to the leader-only evidence below */ }
  }
  for (const d of entries) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const stat = fs.readFileSync(`/proc/${d}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (fields[0] === "Z") continue; // a zombie is not a live member
      if (Number(fields[2]) === pgid) out.push(Number(d));
    } catch { /* gone meanwhile */ }
  }
  if (pidAlive(pgid) && !out.includes(pgid)) {
    // Only a POSITIVELY identified zombie is excluded; an unreadable state
    // (no /proc, a failed read) keeps the kill(pid, 0) evidence.
    if (procState(pgid) !== "Z") out.push(pgid);
  }
  return out;
}

export interface KillProcessGroupOptions {
  /** How long SIGTERM gets before SIGKILL. Default 2000ms. */
  graceMs?: number;
  /** Where escalation is reported. Default: stderr. */
  log?: (line: string) => void;
}

/**
 * Terminate the process group led by `pid` — SIGTERM, a grace period, then
 * SIGKILL to the group AND to every surviving member individually — and
 * report whether the group is gone. Falls back to a single-process kill when
 * `pid` is not a group leader. Resolves false when members survived SIGKILL,
 * so a caller can refuse to start a replacement on top of them.
 */
export async function killProcessGroup(pid: number, opts: KillProcessGroupOptions = {}): Promise<boolean> {
  const graceMs = opts.graceMs ?? 2000;
  const log = opts.log ?? ((line: string) => process.stderr.write(line + "\n"));
  const groupKill = (sig: NodeJS.Signals): boolean => {
    try { process.kill(-pid, sig); return true; } catch { /* not a group leader */ }
    try { process.kill(pid, sig); return true; } catch { return false; /* gone */ }
  };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const tick = 100;
  const rounds = Math.max(1, Math.ceil(graceMs / tick));

  if (!groupKill("SIGTERM")) return true;
  const groupExists = (): boolean => { try { process.kill(-pid, 0); return true; } catch { return false; } };
  const stillThere = (): number[] => {
    const members = enumerateProcessGroup(pid);
    if (members !== null) return members; // a real listing: zombie-only == nobody left
    // Enumeration unavailable: keep BOTH kinds of evidence — the group being
    // addressable, and the target pid itself being alive (the single-process
    // fallback signals a non-leader pid that kill(-pid) never reaches; Astra
    // on b8dc2bf6) — so escalation happens instead of a false "gone".
    return groupExists() || pidAlive(pid) ? [pid] : [];
  };
  for (let i = 0; i < rounds && stillThere().length; i++) await sleep(tick);
  let left = stillThere();
  if (left.length) {
    log(`[kill-group] group ${pid} survived SIGTERM (${left.join(",")}) — escalating to SIGKILL`);
    groupKill("SIGKILL");
    for (const p of left) { try { process.kill(p, "SIGKILL"); } catch { /* gone */ } }
    for (let i = 0; i < rounds && stillThere().length; i++) await sleep(tick);
    left = stillThere();
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
