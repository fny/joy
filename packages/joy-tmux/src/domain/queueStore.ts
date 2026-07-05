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
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { joyStateDir } from "../paths";

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

export function saveQueue(sessionId: string, items: PersistedQueueItem[], baseDir = joyStateDir()): void {
  try {
    const p = queuePath(sessionId, baseDir);
    if (items.length === 0) {
      rmSync(p, { force: true });
      return;
    }
    mkdirSync(baseDir, { recursive: true });
    writeFileSync(p, JSON.stringify(items));
  } catch (e) {
    process.stderr.write(`[queue-store] save failed for ${sessionId}: ${e}\n`);
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
