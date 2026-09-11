// What a reboot leaves behind, and how to bring it back.
//
// A DAEMON crash loses nothing: sessions live in tmux, which outlives the
// daemon, and recover() re-adopts every window it finds. A machine REBOOT is
// the gap — tmux dies with it, and all that survives is the window records in
// ~/.joy. recover() reads them, notices the server is gone, and logs it.
//
// So this is the bulk case, and only the bulk case: one session at a time
// already has Resume in the app's long-press menu.
//
// Deliberately NOT automatic on daemon start. A reboot would then silently
// launch a dozen agents that immediately start doing work nobody asked for at
// that moment, and one that was mid-destructive-task would do it twice.
// Restoring is a thing you ask for.
import type { WindowRecord } from "./windowRecord";
import { classifyRecord } from "./recordClass";

export type Harness = "claude" | "codex" | "opencode" | "pi" | "agy";

export interface Restorable {
  id: string;
  cwd: string;
  agent: Harness;
  /** The conversation to resume, in whatever the agent calls it. Absent means
   *  the folder can be reopened but the history cannot — worth restoring, and
   *  worth saying so. */
  resumeId?: string;
  model?: string;
  permissionMode?: string;
  effort?: string;
  extraArgs?: string;
  /** When this session was last touched, from its record's mtime. The record
   *  is written on every material change, so it is the closest thing to "when
   *  did you last work on this" that survives a reboot — and it is what both
   *  "most recent first" and "restore the latest in this project" need. */
  lastSeenAt?: number;
}

/**
 * Each agent keeps its conversation id somewhere different, because each
 * agent's own resume flag takes a different thing. One place that knows all
 * five beats five callers each remembering one.
 */
export function resumeIdOf(rec: WindowRecord): string | undefined {
  switch (rec.agent ?? "claude") {
    case "codex": return rec.codexThreadId;
    case "opencode": return rec.opencodeSessionId;
    case "pi": return rec.piSettings?.sessionId;
    case "agy": return rec.agySettings?.conversationId;
    default: return rec.claudeSessionId;
  }
}

function settingsOf(rec: WindowRecord): { model?: string; permissionMode?: string; effort?: string; extraArgs?: string } {
  switch (rec.agent ?? "claude") {
    case "codex": return rec.codexSettings ?? {};
    case "opencode": return rec.opencodeSettings ?? {};
    case "pi": return rec.piSettings ?? {};
    case "agy": return rec.agySettings ?? {};
    default: return { permissionMode: rec.claudePermissionMode };
  }
}

/**
 * Which records describe a session that is gone but could come back.
 *
 * `alive` answers "is this record's tmux server still there" — recover()
 * already asks exactly this, and a record whose server answers is not lost,
 * it is adopted.
 *
 * A record with no `socket` predates per-session servers and cannot be probed
 * individually, so it is left alone rather than guessed at: relaunching a
 * session that is actually running would give you two agents in one folder.
 *
 * Records are DELETED when a session is killed or archived (registry.replace,
 * opencodeSession), so a record that still exists is by definition one that
 * was not deliberately ended. That is the whole "was it running?" test, and
 * it is a better one than any flag we could have kept in sync.
 */
export function restorableFrom(
  records: WindowRecord[],
  alive: (rec: WindowRecord) => boolean,
  lastSeen?: (rec: WindowRecord) => number | undefined,
): Restorable[] {
  const out: Restorable[] = [];
  for (const rec of records) {
    // Records without a socket are `files_only` (unprobeable) and live ones
    // are adopted by recover(): only `restorable` is ours (domain/recordClass.ts).
    if (!rec.id || !rec.socket) continue;
    const cls = classifyRecord({ record: rec, windowAlive: alive(rec) });
    if (cls.kind !== "restorable") continue;
    const s = settingsOf(rec);
    out.push({
      id: rec.id,
      cwd: rec.launchCwd!,
      agent: (rec.agent ?? "claude") as Harness,
      resumeId: cls.resumeId,
      model: s.model,
      permissionMode: s.permissionMode,
      effort: s.effort,
      extraArgs: s.extraArgs,
      lastSeenAt: lastSeen?.(rec),
    });
  }
  // MOST RECENT FIRST. What you want back after a reboot is what you were
  // working on, and an alphabetical list buries that under whatever happens
  // to start with a. Ties break on cwd then id so the order is stable — a dry
  // run and the restore that follows must list the same things the same way.
  return out.sort((a, b) =>
    (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0)
    || a.cwd.localeCompare(b.cwd)
    || a.id.localeCompare(b.id));
}

/** The most recent restorable session in each project, newest project first —
 *  what "restore the latest here" needs, and what a per-project row shows. */
export function latestPerProject(sessions: Restorable[]): Restorable[] {
  const best = new Map<string, Restorable>();
  for (const s of sessions) {
    const current = best.get(s.cwd);
    if (!current || (s.lastSeenAt ?? 0) > (current.lastSeenAt ?? 0)) best.set(s.cwd, s);
  }
  return [...best.values()].sort((a, b) => (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0) || a.cwd.localeCompare(b.cwd));
}
