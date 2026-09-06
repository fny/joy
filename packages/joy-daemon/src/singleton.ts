// Machine-wide single-instance guard for the joy-daemon daemon.
//
// Only one daemon may run per machine: two would both recover() the same tmux
// windows and attach duplicate relay sessions, producing duplicate messages.
// The fixed HTTP port is only an implicit guard (bypassable via a different
// PORT, and EADDRINUSE crashes uncaught), so we take an explicit pidfile lock
// that is independent of the port.
//
// The lock is published ATOMICALLY WITH ITS FULL RECORD: the record is written
// to a private temp file first and link(2)ed into place — link fails EEXIST
// when anything is there, and no reader can ever observe an empty or partial
// lock. The old O_EXCL-create-then-write left a window in which a second
// starter read the not-yet-written file as "holder pid 0", judged it stale,
// unlinked it and took its own; the first then finished writing into an
// unlinked descriptor and ALSO reported success — two daemons, same sessions
// (#589). A lock left by a crashed daemon (dead pid) is stale and reclaimed,
// but reclamation renames the exact file it judged stale aside and verifies
// it got THAT file — a newer owner's lock that landed in between is restored,
// never unlinked.
//
// Record format (three lines): holder pid, a per-acquisition nonce, the
// acquisition time in ms. Line 1 alone is what the legacy format held, so a
// legacy reader (parseInt of the file) still sees the pid.

import { openSync, writeSync, closeSync, unlinkSync, readFileSync, mkdirSync, linkSync, statSync } from "fs";
import { dirname } from "path";
import { randomBytes } from "crypto";

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

  const nonce = randomBytes(8).toString("hex");
  const record = `${process.pid}\n${nonce}\n${now()}\n`;
  const tmp = `${lockPath}.${process.pid}.${nonce}.tmp`;

  /** Publish the full record under lockPath atomically. False = occupied. */
  const publish = (): boolean => {
    const fd = openSync(tmp, "w");
    try { writeSync(fd, record); } finally { closeSync(fd); }
    try {
      linkSync(tmp, lockPath);
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      return false;
    } finally {
      try { unlinkSync(tmp); } catch { /* best effort */ }
    }
  };

  for (let attempt = 0; attempt < 5; attempt++) {
    if (publish()) {
      let released = false;
      return () => {
        if (released) return;
        released = true;
        // Only remove the lock if it's still ours (a restart may have handed it on).
        try {
          if (readLock(lockPath)?.raw === record) unlinkSync(lockPath);
        } catch { /* already gone */ }
      };
    }
    const holder = readLock(lockPath);
    if (!holder) continue; // vanished between our link and our read — retry the create
    if (holder.pid && holder.pid !== process.pid && isAlive(holder.pid)) {
      throw new SingletonError(holder.pid);
    }
    if (!holder.pid) {
      let ageMs = Infinity;
      try { ageMs = now() - statSync(lockPath).mtimeMs; } catch { /* gone: treat as stale, the rename below fails harmlessly */ }
      if (ageMs < CREATION_GRACE_MS) {
        throw new SingletonError(0, `another joy-daemon daemon is taking the lock at ${lockPath} right now`);
      }
    }
    // Stale lock (dead holder, or junk older than the creation grace) — remove
    // exactly that file under the reclaim mutex and retry the atomic create.
    if (!reclaim(lockPath, holder, now, isAlive)) continue;
  }
  throw new Error(`could not acquire daemon lock at ${lockPath} after retries`);
}

/** A reclaimer that crashed holding the mutex must not block every later
 *  starter: a mutex older than this is junk. */
const RECLAIM_MUTEX_STALE_MS = 30_000;

/** Remove a lock judged stale WITHOUT ever removing a live owner's, even
 *  briefly. Reclaimers serialize on an O_EXCL mutex file; under it the lock
 *  is re-read and unlinked only if it is byte-identical to the record that
 *  was judged stale. A live owner can only appear by link(2), which fails
 *  while that stale file exists, and can only replace it by reclaiming —
 *  which needs this mutex. The earlier rename-aside/restore protocol left a
 *  window where a third starter took the pathname while a fresh owner's lock
 *  was aside, and both reported ownership (Astra on 53d22103, #589).
 *  Returns false when the reclaim did not happen (the caller re-evaluates). */
function reclaim(lockPath: string, stale: LockRecord, now: () => number, isAlive: (pid: number) => boolean = defaultIsAlive): boolean {
  const mutex = `${lockPath}.reclaiming`;
  let fd: number;
  try {
    fd = openSync(mutex, "wx");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    // The mutex names its holder. It is stolen only from a DEAD holder —
    // never by age alone: a live reclaimer paused between its re-read and
    // its unlink would otherwise resume and remove the thief's fresh lock
    // (Astra on af76c787). A paused-but-alive holder blocks us; we report
    // occupied and the caller can retry later.
    let holderPid = NaN;
    try { holderPid = Number(readFileSync(mutex, "utf8").trim()); } catch { return false; }
    if (Number.isInteger(holderPid) && holderPid > 0 && isAlive(holderPid)) {
      throw new SingletonError(holderPid, `another joy-daemon daemon (pid ${holderPid}) is reclaiming the lock at ${lockPath} right now`);
    }
    let age = 0;
    try { age = now() - statSync(mutex).mtimeMs; } catch { return false; }
    // An unreadable/pidless mutex is a creation in progress unless it is old.
    if (!(Number.isInteger(holderPid) && holderPid > 0) && age < RECLAIM_MUTEX_STALE_MS) {
      throw new SingletonError(0, `another joy-daemon daemon is reclaiming the lock at ${lockPath} right now`);
    }
    try { unlinkSync(mutex); } catch { /* a racer removed it */ }
    return false; // retry the whole evaluation
  }
  try {
    writeSync(fd, `${process.pid}\n`);
    closeSync(fd);
    const current = readLock(lockPath);
    if (!current || current.raw !== stale.raw) return false; // replaced or gone while we decided
    try { unlinkSync(lockPath); } catch { return false; }
    return true;
  } finally {
    try { unlinkSync(mutex); } catch { /* best effort */ }
  }
}
