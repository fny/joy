// Per-session dispatch-queue persistence — closes the B1 loss hole: the relay
// pull cursor is persisted the moment a message is decrypted (BEFORE
// delivery), while the dispatch queue lived only in memory. Any daemon
// restart/crash with undelivered items therefore ate them silently — the
// message showed in the app (it reached the server) but was never typed into
// the pane and left no trace (observed live 2026-07-05: a /steer re-send
// pulled 2s after one deploy restart, killed 38s later by the next one).
//
// The queue file is written on every queue mutation (debounced by the caller's
// cadence — mutations are user-scale, not streaming-scale) and loaded when a
// Session is constructed, so queued-but-undelivered messages survive restarts
// and deliver on the next idle. The in-flight item is persisted at the HEAD:
// it is undelivered until confirmed, and every confirm path rebroadcasts (and
// thus re-persists) without it.
import { existsSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { joyStateDir } from "../paths";
import { writeFileAtomic } from "./atomicWrite";

export interface PersistedQueueItem {
  id: string;
  text: string;
  createdAt: number;
  source: string;
  mirrorToRelay: boolean;
  seq?: number;
  visible: boolean;
}

function queuePath(sessionId: string, baseDir: string): string {
  return join(baseDir, `queue-${sessionId}.json`);
}

/** Returns whether the spool write actually landed. The inbound relay path
 *  treats this as the durable-handoff ack (codex review finding 2): a
 *  swallowed write failure let the cursor advance past a message that only
 *  ever existed in memory. Other callers may ignore the return.
 *
 *  The write is an atomic replace (#555): the spool holds EVERY prompt already
 *  acknowledged to the relay, so a truncating writeFileSync that hit ENOSPC
 *  while adding one more prompt replaced all of them with partial JSON — the
 *  new enqueue correctly rejected its save, but the earlier acknowledged
 *  prompts were gone on the next restart. Now a failed save leaves the
 *  previous spool intact, and `false` is returned only after that has been
 *  confirmed by reading it back. */
export function saveQueue(sessionId: string, items: PersistedQueueItem[], baseDir = joyStateDir()): boolean {
  const p = queuePath(sessionId, baseDir);
  try {
    if (items.length === 0) {
      rmSync(p, { force: true });
      return true;
    }
    writeFileAtomic(p, JSON.stringify(items));
    return true;
  } catch (e) {
    // The old spool must still be there, complete. If it is not, that is a
    // second, louder failure — the caller cannot fix it, but the log must
    // say so instead of implying the earlier prompts are safe.
    const intact = spoolIntact(p);
    process.stderr.write(`[queue-store] save failed for ${sessionId}: ${e}${intact ? " (previous spool intact)" : " — PREVIOUS SPOOL UNREADABLE"}\n`);
    return false;
  }
}

/** True when the spool at `p` is absent (nothing to lose) or parses as an array. */
function spoolIntact(p: string): boolean {
  try {
    if (!existsSync(p)) return true;
    return Array.isArray(JSON.parse(readFileSync(p, "utf-8")));
  } catch {
    return false;
  }
}

export function loadQueue(sessionId: string, baseDir = joyStateDir()): PersistedQueueItem[] {
  try {
    const p = queuePath(sessionId, baseDir);
    if (!existsSync(p)) return [];
    const raw = JSON.parse(readFileSync(p, "utf-8"));
    if (!Array.isArray(raw)) return [];
    return raw.filter((r): r is PersistedQueueItem =>
      !!r && typeof r.id === "string" && typeof r.text === "string" && r.text.length > 0);
  } catch {
    return [];
  }
}

export function clearQueue(sessionId: string, baseDir = joyStateDir()): void {
  try { rmSync(queuePath(sessionId, baseDir), { force: true }); } catch { }
}
