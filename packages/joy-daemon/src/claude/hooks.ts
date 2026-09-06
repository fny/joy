// Claude Code hook plumbing. A managed settings file (loaded via
// `claude --settings`, which MERGES on top of the user's own settings rather
// than replacing them) registers joy's hooks, all pointing at ONE generated
// script that forwards the event to the daemon's session-scoped /hook route.
//
// Hooks are the LIVE STATE EDGES the daemon otherwise has to infer from pane
// heuristics or transcript lag:
//   SessionStart      → authoritative transcript binding (session_id +
//                       transcript_path at claude startup — no mtime discovery,
//                       and the --continue backfill cap computes against the
//                       TRUE file the moment it exists)
//   SessionEnd        → claude is exiting (end_reason): teardown without
//                       waiting for the pid probe or the pane's frozen frame
//   UserPromptSubmit  → a prompt was really submitted (text included): instant
//                       thinking-on + authoritative dispatch delivery confirm
//   Stop              → turn finished: thinking-off + queue drain
//   StopFailure       → turn failed (error_type): authentication_failed opens
//                       the login-code gate
//   PostToolUse       → a tool completed: the turn is still generating
//   PermissionRequest → claude is about to ask for permission (tool_name)
//   Notification      → claude is waiting (notification_type: permission /
//                       idle prompt / auth_success …): thinking-off, needs-input
//   SubagentStop      → a subagent finished (permission_mode refresh only)
//   PreCompact        → compaction started (the original hook)
//
// `permission_mode` rides on most of these and is forwarded from every one;
// so do the subagent identity (agent_id / agent_type) and the daemon's own
// per-launch identity (JOY_LAUNCH_ID → launch_id, the ingress fence).
//
// Everything is BEST-EFFORT by design: the script bounds its network call,
// swallows every failure (daemon down → ECONNREFUSED, unknown session → 404,
// missing daemon.json), and always exits 0 so a hook can never block or stall
// Claude. When hooks don't arrive (adopted sessions never spawned with
// --settings, old settings snapshots, daemon downtime) the pane/transcript
// heuristics carry the session exactly as before. Once a session HAS seen a
// hook from its own claude process (session.ts `hooksLive`), hooks become the
// authority for the states they can observe and the pane parser is demoted to
// a tie-breaker for those — it stays the only source for what hooks cannot
// see: draft text, dialogs, the login form, the shells footer
// (docs/review-campaign-2026-09-claude-runtime-spike.md, candidate A).
import { execPath } from "node:process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { joyStateDir } from "../paths";
import { shellJoin } from "../domain/quote";
import { writeFileAtomic } from "../domain/atomicWrite";

// The generic hook script. Reads the hook payload from stdin, forwards a
// compact subset to POST /sessions/$JOY_SESSION_ID/hook. Daemon coordinates
// (port + token) are read from daemon.json AT FIRE TIME so daemon restarts
// that rotate the token don't strand running claudes.
const HOOK_SCRIPT = `// joy-daemon hook forwarder — auto-generated; do not edit.
// Best-effort: forwards Claude Code hook events to the joy daemon. Always
// exits 0 (a blocking hook would stall Claude); failures are swallowed.
import { readFileSync } from 'node:fs';
let input = {};
try {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  input = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
} catch {}
try {
  const file = process.env.JOY_DAEMON_FILE;
  const sid = process.env.JOY_SESSION_ID;
  if (file && sid) {
    const { port, token } = JSON.parse(readFileSync(file, 'utf8'));
    const body = {
      event: input.hook_event_name,
      session_id: input.session_id,
      transcript_path: input.transcript_path,
      prompt: input.prompt,
      prompt_id: input.prompt_id,
      message: input.message,
      source: input.source,
      trigger: input.trigger,
      permission_mode: input.permission_mode,
      notification_type: input.notification_type,
      // SessionEnd's wire field is \`reason\` (input.end_reason never existed):
      // ship it under the daemon's name, accepting either.
      end_reason: input.end_reason ?? input.reason,
      error_type: input.error_type,
      tool_name: input.tool_name,
      stop_hook_active: input.stop_hook_active,
      // Subagent identity: tool hooks fire for subagents too, and the daemon
      // must not read a background agent's PostToolUse as the main agent's.
      agent_id: input.agent_id,
      agent_type: input.agent_type,
      // Launch identity: the daemon exports a fresh JOY_LAUNCH_ID into every
      // claude it starts. The joy session id is a ROUTE that a restart's
      // replacement inherits and the conversation id survives a --resume, so
      // this is the only field that tells the daemon WHICH process fired.
      launch_id: process.env.JOY_LAUNCH_ID,
    };
    // Drop the keys the event didn't carry so the daemon sees an absent field,
    // not a JSON null it has to special-case.
    for (const k of Object.keys(body)) if (body[k] === undefined || body[k] === null) delete body[k];
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 1500);
    await fetch('http://127.0.0.1:' + port + '/sessions/' + sid + '/hook', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-joy-token': token },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    }).catch(() => {});
    clearTimeout(timer);
  }
} catch {}
process.exit(0);
`;

// Legacy PreCompact script (kept ON DISK, no longer referenced by new
// settings): sessions launched before this version snapshot their hook config
// at claude startup and keep invoking precompact-hook.mjs → the /compacting
// route until they restart. Deleting the file would silently break them.

// Bump when HOOK_SCRIPT or the settings shape changes so stale copies on disk
// are rewritten on the next daemon start.
// "3": the command is shell-quoted (#470) — installs stamped "2" still carry
// the double-quoted, $-expanding command until they are regenerated (Astra).
// "4": SessionEnd/PermissionRequest/StopFailure/PostToolUse/SubagentStop are
// registered and the forwarder ships permission_mode, notification_type,
// end_reason, error_type, tool_name, prompt_id, stop_hook_active — the fields
// that let hooks be the state authority (spike Wave F, step one). Sessions
// launched under "3" keep their snapshot until they restart: they still
// flip `hooksLive`, and the daemon copes with the missing fields (a hook
// without permission_mode simply doesn't refresh the mode).
// "5": SessionEnd forwards the real wire field (`reason` → end_reason — the
// "4" script read a field that never existed, so every exit was "other") and
// the subagent identity (agent_id / agent_type) rides along.
// "6": the per-launch identity (JOY_LAUNCH_ID → launch_id) rides along, so a
// session fences hook ingress to ITS process — not just its conversation id,
// which a same-conversation --resume replacement shares with its predecessor.
// The script is read at fire time, so every running claude forwards it from
// the moment the file is rewritten; one launched without the env var simply
// sends no launch_id (its session was recorded without one, and accepts that).
const HOOK_VERSION = "6";

// The stamp covers the script version AND the embedded node path: the hook
// command pins the daemon's absolute execPath, so a node upgrade that removes
// the old binary would otherwise leave every hook ENOENTing silently (hooks
// are best-effort — nothing surfaces) until someone bumped the version.
function hookStamp(): string {
  return `${HOOK_VERSION}:${execPath}`;
}

let cachedSettingsPath: string | null = null;

/** The settings file is only "installed" if Claude can parse it: an existence
 *  check alone once accepted a JSON truncated by a failed write (#471). */
function settingsIntact(settingsPath: string): boolean {
  try { JSON.parse(readFileSync(settingsPath, "utf8")); return true; } catch { return false; }
}

/**
 * Ensure the managed Claude settings file + hook script exist in the joy state
 * dir, and return the settings path to pass to `claude --settings`.
 * Idempotent and cheap: writes only when missing or version-stale. Returns ""
 * if the files can't be written, so the caller can skip the flag rather than
 * hand claude a bad --settings path.
 */
export function ensureHookSettings(): string {
  if (cachedSettingsPath) return cachedSettingsPath;
  const dir = joyStateDir();
  const hookPath = join(dir, "joy-hook.mjs");
  const settingsPath = join(dir, "claude-settings.json");
  const stampPath = join(dir, "joy-hooks.version");
  try {
    mkdirSync(dir, { recursive: true });
    const stamp = existsSync(stampPath) ? readFileSync(stampPath, "utf8") : "";
    try { rmSync(join(dir, "precompact-hook.version"), { force: true }); } catch {}
    if (stamp !== hookStamp() || !existsSync(hookPath) || !settingsIntact(settingsPath)) {
      // The stamp means "both files are complete and current". Drop it BEFORE
      // touching either file: a repair that dies between the script and the
      // settings (ENOSPC) used to leave the still-current stamp vouching for
      // whatever the second write left behind, and the next call cached that
      // as usable (#471). Each file lands by temp + rename, so a failed write
      // never replaces a complete file with a partial one either.
      rmSync(stampPath, { force: true });
      writeFileAtomic(hookPath, HOOK_SCRIPT);
      // Run via the daemon's own node (absolute path) so the hook works
      // regardless of the login shell's PATH. Claude runs the command through
      // a shell, so both paths are shell-quoted as LITERAL words: double
      // quotes still expanded `$`, backticks and `\` inside a JOY_HOME_DIR
      // such as /tmp/joy-$X and sent every hook to the wrong script (#470).
      const command = shellJoin([execPath, hookPath]);
      const entry = [{ matcher: "", hooks: [{ type: "command", command }] }];
      const settings = {
        hooks: {
          PreCompact: entry,
          SessionStart: entry,
          SessionEnd: entry,
          UserPromptSubmit: entry,
          Stop: entry,
          StopFailure: entry,
          PostToolUse: entry,
          PermissionRequest: entry,
          SubagentStop: entry,
          Notification: entry,
        },
      };
      writeFileAtomic(settingsPath, JSON.stringify(settings, null, 2));
      // Restored last, only once both files are complete on disk (#471).
      writeFileAtomic(stampPath, hookStamp());
    }
  } catch {
    return "";
  }
  cachedSettingsPath = settingsPath;
  return settingsPath;
}

/** Path to daemon.json, injected into Claude's env so the hook reads a fresh
 *  port+token (survives daemon restarts that rotate the token). */
export function daemonFilePath(): string {
  return join(joyStateDir(), "daemon.json");
}
