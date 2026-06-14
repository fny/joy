// Machine-wide single-instance guard for the joy-tmux daemon.
//
// Only one daemon may run per machine: two would both recover() the same tmux
// windows and attach duplicate relay sessions, producing duplicate messages.
// The fixed HTTP port is only an implicit guard (bypassable via a different
// PORT, and EADDRINUSE crashes uncaught), so we take an explicit pidfile lock
// that is independent of the port.
//
// The lock is an O_EXCL-created file holding the holder's pid. O_EXCL makes
// acquisition atomic, so two simultaneous cold starts can't both win. A lock
// left by a crashed daemon (dead pid) is treated as stale and reclaimed.

import { openSync, writeSync, closeSync, unlinkSync, readFileSync, mkdirSync } from "fs";
import { dirname } from "path";

export class SingletonError extends Error {
  constructor(public readonly holderPid: number) {
    super(`another joy-tmux daemon is already running (pid ${holderPid})`);
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

function readLockPid(lockPath: string): number {
  try {
    return parseInt(readFileSync(lockPath, "utf8").trim(), 10) || 0;
  } catch {
    return 0;
  }
}

/**
 * Acquire the daemon lock at `lockPath`. Returns a `release()` to call on
 * shutdown. Throws {@link SingletonError} if a live daemon already holds it.
 * A stale lock (holder pid dead/unreadable) is removed and reclaimed.
 */
export function acquireSingleton(
  lockPath: string,
  opts?: { isAlive?: (pid: number) => boolean },
): () => void {
  const isAlive = opts?.isAlive ?? defaultIsAlive;
  mkdirSync(dirname(lockPath), { recursive: true });

  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const fd = openSync(lockPath, "wx"); // O_CREAT | O_EXCL | O_WRONLY — atomic
      writeSync(fd, String(process.pid));
      closeSync(fd);

      let released = false;
      return () => {
        if (released) return;
        released = true;
        // Only remove the lock if it's still ours (a restart may have handed it on).
        try {
          if (readLockPid(lockPath) === process.pid) unlinkSync(lockPath);
        } catch { /* already gone */ }
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const holder = readLockPid(lockPath);
      if (holder && holder !== process.pid && isAlive(holder)) {
        throw new SingletonError(holder);
      }
      // Stale lock (dead/unknown holder) — drop it and retry the atomic create.
      try { unlinkSync(lockPath); } catch { /* raced with another reclaimer */ }
    }
  }
  throw new Error(`could not acquire daemon lock at ${lockPath} after retries`);
}
