// Per-window persistence: a small `window-<id>.json` record tying a tmux window
// (joy session id) to the conversation it launched and its launch directory.
//
// Why: on daemon restart, recover() used to bind each surviving window to the
// NEWEST transcript in its cwd (mtime) and to the pane's CURRENT dir
// (#{pane_current_path}). Both are wrong when the window is detached/idle, the
// dir was touched by another claude/codex run, or the user cd'd inside the pane —
// the card then floods with an unrelated conversation and resume targets the
// wrong jsonl (BUG-6/13/15). This record is the authoritative binding, written
// when the id/cwd are first learned and preferred during recover()/restart().

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "fs";
import { join } from "path";
import { defaultStateDir } from "./receipts";

export interface WindowRecord {
  /** joy session id (the tmux window suffix j-<id>). */
  id: string;
  /** Directory Claude was launched in — stable across in-pane `cd`. */
  launchCwd: string;
  /** Claude's transcript/session uuid, once learned from a transcript entry. */
  claudeSessionId?: string;
  updatedAt: number;
}

function recordPath(id: string, baseDir = defaultStateDir()): string {
  if (!existsSync(baseDir)) mkdirSync(baseDir, { recursive: true });
  return join(baseDir, `window-${id}.json`);
}

export function loadWindowRecord(id: string, baseDir = defaultStateDir()): WindowRecord | null {
  try {
    const p = recordPath(id, baseDir);
    if (!existsSync(p)) return null;
    const parsed = JSON.parse(readFileSync(p, "utf-8")) as WindowRecord;
    if (typeof parsed.id !== "string" || typeof parsed.launchCwd !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Write/merge a window record. Atomic via tmp+rename so a crash mid-write can't
 *  leave a truncated file. Merges so we don't clobber a known claudeSessionId. */
export function saveWindowRecord(
  id: string,
  patch: { launchCwd?: string; claudeSessionId?: string },
  baseDir = defaultStateDir(),
): void {
  try {
    const prev = loadWindowRecord(id, baseDir);
    const next: WindowRecord = {
      id,
      launchCwd: patch.launchCwd ?? prev?.launchCwd ?? "",
      claudeSessionId: patch.claudeSessionId ?? prev?.claudeSessionId,
      updatedAt: Date.now(),
    };
    if (!next.launchCwd) return; // nothing useful to persist yet
    const p = recordPath(id, baseDir);
    const tmp = `${p}.tmp`;
    writeFileSync(tmp, JSON.stringify(next));
    renameSync(tmp, p);
  } catch {
    // best-effort; recovery falls back to the newest-transcript heuristic
  }
}
