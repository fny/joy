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

// fs is used through the default export object (not named imports) so tests
// can inject a failing rmSync with vi.spyOn — see #567 below.
import fs from "fs";
import { join } from "path";
import { joyStateDir as defaultStateDir } from "../paths";
import { writeSecretFileAtomic, mkdirSecure } from "./secretFile";
import type { JoyHandoffInfo } from "../relay/relay";

// The record holds a session's IDENTITY and CONFIGURATION only. Its execution
// state — the transcript replay checkpoint, opencode's delivered-through
// message, the in-flight handoff job — lives in the ledger (domain/ledger.ts:
// checkpoints(claude_transcript | opencode_msg), jobs(handoff)), where it
// commits together with the outbound rows it depends on (campaign decision,
// 2026-09-06).

export interface WindowRecord {
  /** joy session id (the tmux window suffix j-<id>). */
  id: string;
  /** This session IS an automation run (domain/automationRun.ts). Persisted
   *  because the run's outcome must still be reportable after a daemon
   *  restart — a run stuck in `running` blocks every later firing of its
   *  automation, since an overlapping one is skipped. */
  automationRunId?: string;
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
  /** Claude's permission mode as launched / last set. Restart reads it so a
   *  session started in plan or default mode does not come back in bypass. */
  claudePermissionMode?: string;
  /** The per-launch identity exported to the claude process as JOY_LAUNCH_ID
   *  and echoed back on every hook event as launch_id: the session accepts
   *  hooks from THIS launch only. Persisted so a recovered session keeps the
   *  fence; absent for launches that predate it (those accept any launch). */
  hookLaunchId?: string;
  /** The key envelope of an in-flight announce (relay/nucleusLane): kept so a
   *  retry after a lost reply repeats the SAME request — the relay's
   *  idempotency is by intent + request hash. */
  v2AnnounceEnvelope?: string;
  /** True once the user set a title explicitly (/title): agent joy-title tags
   *  and Claude's own ai-title re-titles are ignored until a bare /title
   *  unlocks. Persisted so the lock survives daemon restarts. */
  titleLockedByUser?: boolean;
  /** The title the user set with /title — persisted WITH the lock (#474):
   *  a restart's replacement restored the lock but had no summary, so the
   *  card kept (or re-published) the transcript's old ai-title while the
   *  user's title was gone. Cleared (null) when a bare /title unlocks. */
  userTitle?: string;
  /** Last ai-title VALUE applied from the transcript. Persisted because the
   *  in-memory dedupe reset on every restart: the tailer replayed Claude's
   *  ancient, endlessly-repeated ai-title, saw it as new, and stomped the
   *  agent's <joy-title> back to a title from days ago (one session had 3195
   *  copies of the same stale value). */
  lastAiTitle?: string;
  /** The title the AGENT last set with a <joy-title/> tag. Persisted because
   *  the agent OWNS the title once it re-titles (#631): Claude re-derives its
   *  ai-title off the first message of a conversation and never revisits it,
   *  while a session here lives for days and pivots, so a later ai-title
   *  carries strictly less information than the agent's tag and must not
   *  stomp it. Released by a user /title (which takes ownership) or by a
   *  /clear (which starts a new conversation). */
  agentTitle?: string;
  /** Created with `joy new --headless`: nobody is watching it, so it stays out
   *  of the app's session list and sends no turn-done push. Persisted because
   *  the property belongs to the session, not to the process that made it. */
  headless?: boolean;
  /** Push notifications for this session are silenced. Persisted here rather
   *  than in app settings because the DAEMON is the only place a mute can be
   *  enforced: a remote notification is displayed by the phone's OS before the
   *  app can decide, so the only way not to see one is not to send it. Lives
   *  with the session, so it holds across daemon restarts and every device. */
  notificationsMuted?: boolean;
  /** Agent type — the discriminator recovery uses to reconstruct the right
   *  session class (claude Session vs CodexSession). Absent = claude (legacy). */
  agent?: "claude" | "codex" | "opencode" | "pi" | "agy";
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
  /** opencode: the spawn identity of `opencodeServerPid` (#628) — the
   *  launcher's start time and the `JOY_PGROUP` token its group inherited.
   *  A pid on its own is not an identity: by the time a later daemon run
   *  reads this record the number may belong to someone else entirely, so
   *  recovery verifies BOTH before it signals anything. */
  opencodeServerStart?: string;
  opencodeServerMarker?: string;
  opencodeSettings?: { model?: string; providerID?: string; permissionMode?: string; effort?: string };
  piSettings?: { model?: string; sessionId?: string; effort?: string; permissionMode?: string; extraArgs?: string };
  /** Antigravity (agy): model display name + the conversation id to --conversation on the next turn. */
  agySettings?: { model?: string; conversationId?: string; effort?: string; permissionMode?: string; extraArgs?: string };
  /** The settled handoff link (peer, state) — the card is rebuilt from a
   *  blank holder on every restart, so "Hand back" needs it from here. */
  handoff?: JoyHandoffInfo | null;
  /** Tombstone (#567): the session was killed on purpose but the record file
   *  could not be removed (EROFS/EACCES/EBUSY). A tombstoned record is
   *  invisible to load/list — so recovery cannot resurrect the session — and
   *  is swept on the next successful delete attempt. Cleared only by a patch
   *  that carries a launchCwd (a real new launch under the same id). */
  killed?: boolean;
  updatedAt: number;
}

/** Thrown by a caller that must NOT proceed on a record write that did not
 *  land (#474 residual): a `/title` acknowledged and published while the
 *  record kept the old title was silently reverted by the next replacement.
 *  Callers keep their previous in-memory state and let this surface as a
 *  refusal (a `not_durable` op result, a failed relay turn). */
export class WindowRecordWriteError extends Error {
  constructor(id: string, what: string) {
    super(`${what} not persisted: the window record for ${id} could not be written (see the [window-record] line above); the previous state stands`);
    this.name = "WindowRecordWriteError";
  }
}

function recordPath(id: string, baseDir = defaultStateDir()): string {
  if (!fs.existsSync(baseDir)) fs.mkdirSync(baseDir, { recursive: true });
  return join(baseDir, `window-${id}.json`);
}

/** Ids whose delete failed IN THIS PROCESS. Even when the tombstone write
 *  fails too (a read-only state dir refuses both), the record stays hidden
 *  from this process's recovery/list paths and the delete is retried on
 *  every list. Keyed by baseDir+id so tests with several dirs do not collide. */
const failedDeletes = new Set<string>();
const deleteKey = (id: string, baseDir: string) => `${baseDir}\u0000${id}`;

/** Delete a session's record — call on intentional kill so record-based
 *  recovery (codex/opencode/agy) can't resurrect a session the user ended.
 *
 *  A failed unlink used to be swallowed (#567): teardown reported success,
 *  the record stayed, and the next boot recovered the "killed" session as
 *  running against a card the kill had already archived. Now a failure is
 *  (1) reported to stderr, (2) remembered so this process never lists the
 *  record again, (3) tombstoned on disk (`killed: true`) so a LATER daemon
 *  ignores it too, and (4) retried on every listWindowRecords. Returns
 *  whether the file is gone. */
export function deleteWindowRecord(id: string, baseDir = defaultStateDir()): boolean {
  const p = join(baseDir, `window-${id}.json`);
  try {
    fs.rmSync(p, { force: true });
    failedDeletes.delete(deleteKey(id, baseDir));
    return true;
  } catch (e) {
    failedDeletes.add(deleteKey(id, baseDir));
    let tombstoned = false;
    try {
      const raw = readRecordRaw(id, baseDir);
      if (raw) { writeSecretFileAtomic(p, JSON.stringify({ ...raw, killed: true, updatedAt: Date.now() })); tombstoned = true; }
    } catch { /* the same fault that blocked the unlink usually blocks this too */ }
    process.stderr.write(`[window-record] ${id}: delete failed (${e instanceof Error ? e.message : e}); ${tombstoned ? "tombstoned — " : "NOT tombstoned — "}hidden from recovery in this process, retried on the next scan\n`);
    return false;
  }
}

/** All persisted window records (recovery scan). Tombstoned records and
 *  records whose delete failed in this process are excluded — and each such
 *  file gets another delete attempt while we are here. */
/** When a record was last written. The record is rewritten on every material
 *  change, so its mtime is the closest thing to "when did you last work on
 *  this session" that survives the machine restart which lost it. */
export function windowRecordMtime(id: string, baseDir = defaultStateDir()): number | undefined {
  try { return fs.statSync(recordPath(id, baseDir)).mtimeMs; } catch { return undefined; }
}

export function listWindowRecords(baseDir = defaultStateDir()): WindowRecord[] {
  try {
    if (!fs.existsSync(baseDir)) return [];
    const out: WindowRecord[] = [];
    for (const f of fs.readdirSync(baseDir)) {
      const m = /^window-([0-9a-f]{8})\.json$/.exec(f);
      if (!m) continue;
      const id = m[1];
      const raw = readRecordRaw(id, baseDir);
      if (!raw) continue;
      if (raw.killed || failedDeletes.has(deleteKey(id, baseDir))) {
        // Sweep: a delete that failed earlier may succeed now (fs remounted,
        // permissions fixed). Either way the record is not a live session.
        try { fs.rmSync(join(baseDir, f), { force: true }); failedDeletes.delete(deleteKey(id, baseDir)); } catch { /* still stuck; still hidden */ }
        continue;
      }
      out.push(raw);
    }
    return out;
  } catch { return []; }
}

/** Which Claude transcript a recovered window binds to (#563).
 *
 *  Evidence order: the checkpointed path (what the previous daemon was
 *  actually tailing) → the record's Claude id (the `--session-id` the daemon
 *  chose at launch, persisted BEFORE Claude runs, or the id learned from the
 *  transcript) → nothing. With a record present the newest-mtime heuristic is
 *  never used: a fresh session that had not produced its first transcript
 *  when the daemon restarted used to fall through to the newest unclaimed
 *  file in the project — an unrelated conversation whose history was then
 *  replayed into the card and whose id a later restart resumed. A pinned path
 *  that does not exist yet is returned as-is (`pending: true`): the Session
 *  waits for exactly that file, the way a fresh launch does. The heuristic
 *  survives only for windows with NO record at all (pre-record daemons). */
/** What recovery knows about a window: the record's Claude id and the
 *  ledger's transcript checkpoint (`checkpoints(claude_transcript)`). */
export interface RecoveredBinding { claudeSessionId?: string; transcriptCheckpoint?: { path: string; offset: number } }
export function resolveRecoveredTranscript(
  rec: RecoveredBinding | null,
  transcriptDir: string,
  claimed: ReadonlySet<string>,
  newestUnclaimed: () => string | null,
): { transcriptPath?: string; claudeSessionId?: string; pending: boolean } {
  if (rec) {
    const ckpt = rec.transcriptCheckpoint?.path;
    if (ckpt && fs.existsSync(ckpt) && !claimed.has(ckpt)) {
      return { transcriptPath: ckpt, claudeSessionId: ckpt.replace(/^.*\//, "").replace(/\.jsonl$/, ""), pending: false };
    }
    if (rec.claudeSessionId) {
      const pinned = join(transcriptDir, `${rec.claudeSessionId}.jsonl`);
      if (claimed.has(pinned)) return { pending: false }; // another recovered session already tails it
      return { transcriptPath: pinned, claudeSessionId: rec.claudeSessionId, pending: !fs.existsSync(pinned) };
    }
    return { pending: false }; // a record with no identity: stay unbound, never adopt project history
  }
  const fallback = newestUnclaimed();
  if (fallback && !claimed.has(fallback)) {
    return { transcriptPath: fallback, claudeSessionId: fallback.replace(/^.*\//, "").replace(/\.jsonl$/, ""), pending: false };
  }
  return { pending: false };
}

/** The record file as written, tombstone included; null when missing/invalid. */
function readRecordRaw(id: string, baseDir: string): WindowRecord | null {
  try {
    const p = recordPath(id, baseDir);
    if (!fs.existsSync(p)) return null;
    const parsed = JSON.parse(fs.readFileSync(p, "utf-8")) as WindowRecord;
    if (typeof parsed.id !== "string" || typeof parsed.launchCwd !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function loadWindowRecord(id: string, baseDir = defaultStateDir()): WindowRecord | null {
  const rec = readRecordRaw(id, baseDir);
  // A tombstoned record (or one this process failed to delete) reads as
  // absent: the session it described was killed on purpose (#567).
  if (!rec || rec.killed || failedDeletes.has(deleteKey(id, baseDir))) return null;
  return rec;
}

/** Write/merge a window record. Atomic via tmp+rename so a crash mid-write can't
 *  leave a truncated file. Merges so we don't clobber a known claudeSessionId.
 *
 *  Returns whether the record is now ON DISK. Callers that promise something
 *  on the strength of the record — a handoff job "will retry on daemon
 *  restart" (#542), a fresh Claude id recovery will pin to (#563) — must check
 *  it: the write used to be fire-and-forget, so those promises were made even
 *  when the state dir refused the write. */
export function saveWindowRecord(
  id: string,
  patch: { launchCwd?: string; socket?: string | null; v2SessionId?: string; v2SessionKey?: string; claudeSessionId?: string; titleLockedByUser?: boolean; userTitle?: string | null; lastAiTitle?: string; agentTitle?: string | null; agent?: "claude" | "codex" | "opencode" | "pi" | "agy"; codexThreadId?: string; codexSocketPath?: string; codexServerPid?: number; codexSettings?: { model?: string; effort?: string; permissionMode?: string; developerInstructions?: string; config?: Record<string, string> }; opencodeSessionId?: string; opencodeServerPid?: number; opencodeServerStart?: string; opencodeServerMarker?: string; opencodeSettings?: { model?: string; providerID?: string; permissionMode?: string; effort?: string }; piSettings?: { model?: string; sessionId?: string; effort?: string; permissionMode?: string; extraArgs?: string }; agySettings?: { model?: string; conversationId?: string; effort?: string; permissionMode?: string; extraArgs?: string }; handoff?: JoyHandoffInfo | null; notificationsMuted?: boolean; headless?: boolean; automationRunId?: string; claudePermissionMode?: string; hookLaunchId?: string; v2AnnounceEnvelope?: string },
  baseDir = defaultStateDir(),
): boolean {
  try {
    // Merge against the RAW file: a tombstoned record must stay tombstoned
    // under a late patch from the dying session (a checkpoint timer, a title)
    // — only a patch carrying launchCwd is a new launch under this id, which
    // clears the tombstone (#567). loadWindowRecord would hide the tombstone
    // and let the merge silently revive the record.
    const raw = readRecordRaw(id, baseDir);
    const reviving = patch.launchCwd !== undefined;
    const prev = raw && (raw.killed || failedDeletes.has(deleteKey(id, baseDir))) && !reviving ? null : raw;
    if (reviving) failedDeletes.delete(deleteKey(id, baseDir));
    const next: WindowRecord = {
      id,
      launchCwd: patch.launchCwd ?? prev?.launchCwd ?? "",
      socket: patch.socket !== undefined ? patch.socket : prev?.socket ?? null,
      v2SessionId: patch.v2SessionId ?? prev?.v2SessionId,
      v2SessionKey: patch.v2SessionKey ?? prev?.v2SessionKey,
      claudeSessionId: patch.claudeSessionId ?? prev?.claudeSessionId,
      claudePermissionMode: patch.claudePermissionMode ?? prev?.claudePermissionMode,
      hookLaunchId: patch.hookLaunchId ?? prev?.hookLaunchId,
      v2AnnounceEnvelope: patch.v2AnnounceEnvelope ?? prev?.v2AnnounceEnvelope,
      handoff: patch.handoff === null ? undefined : patch.handoff ?? prev?.handoff,
      notificationsMuted: patch.notificationsMuted ?? prev?.notificationsMuted,
      headless: patch.headless ?? prev?.headless,
      automationRunId: patch.automationRunId ?? prev?.automationRunId,
      titleLockedByUser: patch.titleLockedByUser ?? prev?.titleLockedByUser,
      userTitle: patch.userTitle === null ? undefined : patch.userTitle ?? prev?.userTitle,
      lastAiTitle: patch.lastAiTitle ?? prev?.lastAiTitle,
      agentTitle: patch.agentTitle === null ? undefined : patch.agentTitle ?? prev?.agentTitle,
      agent: patch.agent ?? prev?.agent,
      codexThreadId: patch.codexThreadId ?? prev?.codexThreadId,
      codexSocketPath: patch.codexSocketPath ?? prev?.codexSocketPath,
      codexServerPid: patch.codexServerPid ?? prev?.codexServerPid,
      codexSettings: patch.codexSettings ?? prev?.codexSettings,
      opencodeSessionId: patch.opencodeSessionId ?? prev?.opencodeSessionId,
      opencodeServerPid: patch.opencodeServerPid ?? prev?.opencodeServerPid,
      // The identity travels WITH the pid: a patch that carries a new server
      // pid must not inherit the previous server's start time / marker (#628).
      opencodeServerStart: patch.opencodeServerPid !== undefined ? patch.opencodeServerStart : patch.opencodeServerStart ?? prev?.opencodeServerStart,
      opencodeServerMarker: patch.opencodeServerPid !== undefined ? patch.opencodeServerMarker : patch.opencodeServerMarker ?? prev?.opencodeServerMarker,
      opencodeSettings: patch.opencodeSettings ?? prev?.opencodeSettings,
      piSettings: patch.piSettings ?? prev?.piSettings,
      agySettings: patch.agySettings ?? prev?.agySettings,
      updatedAt: Date.now(),
    };
    // A late patch onto a tombstone with no launchCwd of its own has nothing
    // to persist: the record must stay dead, not be reborn as a launch-less
    // shell. (`prev` is null in that case, so launchCwd is empty.)
    if (!next.launchCwd) return false;
    // 0600 in a 0700 dir: the record carries v2SessionKey, the key that
    // decrypts every app↔daemon message of this session (#48).
    mkdirSecure(baseDir);
    writeSecretFileAtomic(recordPath(id, baseDir), JSON.stringify(next));
    return true;
  } catch (e) {
    // Reported to the caller (false) AND logged; recovery for a record that
    // never landed falls back to the newest-transcript heuristic.
    process.stderr.write(`[window-record] ${id}: save failed: ${e instanceof Error ? e.message : e}\n`);
    return false;
  }
}
