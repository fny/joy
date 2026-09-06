// Machine-wide single-instance guard for the joy-daemon daemon.
//
// Only one daemon may run per machine: two would both recover() the same tmux
// windows and attach duplicate relay sessions, producing duplicate messages.
// The fixed HTTP port is only an implicit guard (bypassable via a different
// PORT, and EADDRINUSE crashes uncaught), so we take an explicit lock that is
// independent of the port.
//
// The mutual exclusion is an OS-BACKED lock: an SQLite connection holding
// `BEGIN IMMEDIATE` on `<lockPath>.db` (node:sqlite, already a dependency via
// forkHarness). SQLite's fcntl/flock locking is atomic and dies with the
// process, so there is nothing to reclaim and no reclaim protocol to race.
// Every pure-file protocol tried before (#589: O_EXCL create-then-write, link
// of a full record, rename-aside reclaim, a mutex-serialized reclaim, a
// pid-owned mutex) left some window in which a paused or racing starter could
// remove a live owner's lock — Astra reproduced each one. A file lock cannot
// do compare-and-delete; the OS lock can.
//
// `<lockPath>` itself stays as an INFORMATIONAL pidfile (line 1 = pid, then a
// nonce and time) for `joy stop`/status readers and legacy daemons. A live
// legacy daemon (pre-SQLite-lock) is detected from that file and honoured;
// a dead one's file is simply overwritten.

import { openSync, writeSync, closeSync, unlinkSync, readFileSync, mkdirSync, renameSync, statSync } from "fs";
import { dirname } from "path";
import { randomBytes } from "crypto";
import { createRequire } from "module";

type SqliteDb = { exec(sql: string): void; close(): void };
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as { DatabaseSync: new (p: string) => SqliteDb };

export class SingletonError extends Error {
  constructor(public readonly holderPid: number, detail?: string) {
    super(detail ?? `another joy-daemon daemon is already running (pid ${holderPid})`);
    this.name = "SingletonError";
  }
}

/** Is `pid` a live process? `process.kill(pid, 0)` sends no signal but throws
 *  ESRCH when the process is gone; EPERM means it exists under another user. */
function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

interface LockRecord { pid: number; raw: string }

/** The lock as it stands on disk; null when there is none. An empty or
 *  unparseable file reads as pid 0 (a legacy daemon mid-creation, or junk). */
function readLock(lockPath: string): LockRecord | null {
  try {
    const raw = readFileSync(lockPath, "utf8");
    return { pid: parseInt(raw.split("\n")[0]?.trim() ?? "", 10) || 0, raw };
  } catch {
    return null;
  }
}

/** A lock with no readable pid may be a LEGACY daemon between its O_EXCL
 *  create and its write. It is occupied until it has had this long to finish;
 *  older than that it is junk from a crash and reclaimable. */
const CREATION_GRACE_MS = 10_000;

/**
 * Acquire the daemon lock at `lockPath`. Returns a `release()` to call on
 * shutdown. Throws {@link SingletonError} if a live daemon already holds it
 * (or another starter is mid-way through taking it). A stale lock (holder pid
 * dead/unreadable and old) is removed and reclaimed.
 */
export function acquireSingleton(
  lockPath: string,
  opts?: { isAlive?: (pid: number) => boolean; now?: () => number },
): () => void {
  const isAlive = opts?.isAlive ?? defaultIsAlive;
  const now = opts?.now ?? Date.now;
  mkdirSync(dirname(lockPath), { recursive: true });

  // Legacy holders first: a daemon from before the SQLite lock only has the
  // pidfile. Live pid → occupied. Empty/unparseable and young → a legacy
  // creation in progress → occupied. Dead or old → ignorable.
  const existing = readLock(lockPath);
  if (existing) {
    if (existing.pid && existing.pid !== process.pid && isAlive(existing.pid)) throw new SingletonError(existing.pid);
    if (!existing.pid) {
      let ageMs = Infinity;
      try { ageMs = now() - statSync(lockPath).mtimeMs; } catch { /* gone */ }
      if (ageMs < CREATION_GRACE_MS) throw new SingletonError(0, `another joy-daemon daemon is taking the lock at ${lockPath} right now`);
    }
  }

  // The real lock. BEGIN IMMEDIATE takes SQLite's RESERVED lock; a second
  // connection (any process, or this one) gets SQLITE_BUSY at once.
  const db = new DatabaseSync(`${lockPath}.db`);
  try {
    db.exec("PRAGMA busy_timeout = 0");
    db.exec("BEGIN IMMEDIATE");
  } catch (e) {
    try { db.close(); } catch { /* best effort */ }
    const holder = readLock(lockPath);
    const msg = String((e as Error).message ?? e);
    if (/locked|busy/i.test(msg)) throw new SingletonError(holder?.pid ?? 0, holder?.pid ? undefined : `another joy-daemon daemon holds the lock at ${lockPath}`);
    throw e;
  }

  // Informational pidfile, written whole then renamed in (readers never see
  // a partial record). We hold the OS lock, so no one else writes it now.
  const nonce = randomBytes(8).toString("hex");
  const record = `${process.pid}\n${nonce}\n${now()}\n`;
  const tmp = `${lockPath}.${process.pid}.${nonce}.tmp`;
  const fd = openSync(tmp, "w");
  try { writeSync(fd, record); } finally { closeSync(fd); }
  renameSync(tmp, lockPath);

  let released = false;
  return () => {
    if (released) return;
    released = true;
    try { if (readLock(lockPath)?.raw === record) unlinkSync(lockPath); } catch { /* already gone */ }
    try { db.exec("ROLLBACK"); } catch { /* connection may already be closed */ }
    try { db.close(); } catch { /* best effort */ }
  };
}
