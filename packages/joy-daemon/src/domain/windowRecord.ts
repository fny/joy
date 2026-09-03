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

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, readdirSync } from "fs";
import { join } from "path";
import { defaultStateDir } from "./receipts";

export interface WindowRecord {
  /** joy session id (the tmux window suffix j-<id>). */
  id: string;
  /** Per-session tmux server label (-L <socket>), or absent/null for a
   *  legacy window on the shared server (pre per-session-servers). */
  socket?: string | null;
  /** v2 nucleus linkage: the relay-side session id this local session serves. */
  v2SessionId?: string;
  /** v2 content key (base64, 32 bytes) — the symmetric key sealed to the
   *  account in the bind envelope. Persisted so prompts stay decryptable
   *  across daemon restarts. Same trust domain as the transcripts beside it. */
  v2SessionKey?: string;
  /** Directory Claude was launched in — stable across in-pane `cd`. */
  launchCwd: string;
  /** Claude's transcript/session uuid, once learned from a transcript entry. */
  claudeSessionId?: string;
  /** True once the user set a title explicitly (/title): agent joy-title tags
   *  and Claude's own ai-title re-titles are ignored until a bare /title
   *  unlocks. Persisted so the lock survives daemon restarts. */
  titleLockedByUser?: boolean;
  /** Last ai-title VALUE applied from the transcript. Persisted because the
   *  in-memory dedupe reset on every restart: the tailer replayed Claude's
   *  ancient, endlessly-repeated ai-title, saw it as new, and stomped the
   *  agent's <joy-title> back to a title from days ago (one session had 3195
   *  copies of the same stale value). */
  lastAiTitle?: string;
  /** Transcript replay checkpoint (codex review finding 8): byte offset of
   *  the tail AFTER the last processed entry, per transcript path. Recovery
   *  resumes here instead of replaying the whole file from 0 — which both
   *  bounds restart cost and makes receipt pruning a correctness bound
   *  (receipts only need to cover post-checkpoint overlap). Path-scoped: a
   *  /clear rotation binds a NEW file, where offset 0 is correct. */
  transcriptCheckpoint?: { path: string; offset: number };
  /** Agent type — the discriminator recovery uses to reconstruct the right
   *  session class (claude Session vs CodexSession). Absent = claude (legacy). */
  agent?: "claude" | "codex" | "opencode" | "pi";
  /** Codex app-server thread id, for thread/resume on recovery. */
  codexThreadId?: string;
  /** Codex app-server unix socket path (per session). */
  codexSocketPath?: string;
  /** Codex app-server pid — so recovery can kill an orphan it rejoins. */
  codexServerPid?: number;
  /** Codex session settings — restored on recovery so a resumed session keeps
   *  its model/effort/permission rather than resetting to defaults. */
  codexSettings?: { model?: string; effort?: string; permissionMode?: string; developerInstructions?: string; config?: Record<string, string> };
  /** opencode: server-side session id (persists across server restarts). */
  opencodeSessionId?: string;
  /** opencode: last spawned server pid (reaped on takeover). */
  opencodeServerPid?: number;
  /** Reconcile checkpoint: last fully-delivered opencode message id. */
  opencodeDeliveredThrough?: string;
  opencodeSettings?: { model?: string; providerID?: string };
  piSettings?: { model?: string; sessionId?: string };
  updatedAt: number;
}

function recordPath(id: string, baseDir = defaultStateDir()): string {
  if (!existsSync(baseDir)) mkdirSync(baseDir, { recursive: true });
  return join(baseDir, `window-${id}.json`);
}

/** Delete a session's record — call on intentional kill so record-based
 *  recovery (codex) can't resurrect a session the user ended. */
export function deleteWindowRecord(id: string, baseDir = defaultStateDir()): void {
  try { rmSync(join(baseDir, `window-${id}.json`), { force: true }); } catch { /* best effort */ }
}

/** All persisted window records (recovery scan). */
export function listWindowRecords(baseDir = defaultStateDir()): WindowRecord[] {
  try {
    if (!existsSync(baseDir)) return [];
    const out: WindowRecord[] = [];
    for (const f of readdirSync(baseDir)) {
      const m = /^window-([0-9a-f]{8})\.json$/.exec(f);
      if (!m) continue;
      const rec = loadWindowRecord(m[1], baseDir);
      if (rec) out.push(rec);
    }
    return out;
  } catch { return []; }
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
  patch: { launchCwd?: string; socket?: string | null; v2SessionId?: string; v2SessionKey?: string; claudeSessionId?: string; titleLockedByUser?: boolean; lastAiTitle?: string; transcriptCheckpoint?: { path: string; offset: number }; agent?: "claude" | "codex" | "opencode" | "pi"; codexThreadId?: string; codexSocketPath?: string; codexServerPid?: number; codexSettings?: { model?: string; effort?: string; permissionMode?: string; developerInstructions?: string; config?: Record<string, string> }; opencodeSessionId?: string; opencodeServerPid?: number; opencodeDeliveredThrough?: string; opencodeSettings?: { model?: string; providerID?: string }; piSettings?: { model?: string; sessionId?: string } },
  baseDir = defaultStateDir(),
): void {
  try {
    const prev = loadWindowRecord(id, baseDir);
    const next: WindowRecord = {
      id,
      launchCwd: patch.launchCwd ?? prev?.launchCwd ?? "",
      socket: patch.socket !== undefined ? patch.socket : prev?.socket ?? null,
      v2SessionId: patch.v2SessionId ?? prev?.v2SessionId,
      v2SessionKey: patch.v2SessionKey ?? prev?.v2SessionKey,
      claudeSessionId: patch.claudeSessionId ?? prev?.claudeSessionId,
      titleLockedByUser: patch.titleLockedByUser ?? prev?.titleLockedByUser,
      lastAiTitle: patch.lastAiTitle ?? prev?.lastAiTitle,
      transcriptCheckpoint: patch.transcriptCheckpoint ?? prev?.transcriptCheckpoint,
      agent: patch.agent ?? prev?.agent,
      codexThreadId: patch.codexThreadId ?? prev?.codexThreadId,
      codexSocketPath: patch.codexSocketPath ?? prev?.codexSocketPath,
      codexServerPid: patch.codexServerPid ?? prev?.codexServerPid,
      codexSettings: patch.codexSettings ?? prev?.codexSettings,
      opencodeSessionId: patch.opencodeSessionId ?? prev?.opencodeSessionId,
      opencodeServerPid: patch.opencodeServerPid ?? prev?.opencodeServerPid,
      opencodeDeliveredThrough: patch.opencodeDeliveredThrough ?? prev?.opencodeDeliveredThrough,
      opencodeSettings: patch.opencodeSettings ?? prev?.opencodeSettings,
      piSettings: patch.piSettings ?? prev?.piSettings,
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
