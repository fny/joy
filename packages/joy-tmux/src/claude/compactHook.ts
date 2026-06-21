// PreCompact hook plumbing. A managed Claude Code settings file (loaded via
// `claude --settings`, which MERGES on top of the user's own settings rather
// than replacing them) whose PreCompact hook pings the daemon the moment Claude
// starts compacting. The app then shows a "compacting" status until the
// compact_boundary transcript record (written on completion) clears it.
import { execPath } from "node:process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { joyStateDir } from "../paths";

// The hook script body. Reads the PreCompact stdin payload for the trigger
// (manual/auto), then POSTs to the daemon's session-scoped /compacting route.
// It ALWAYS exits 0 — a non-zero PreCompact hook (exit 2) would block Claude's
// compaction — and bounds its network call so it can't stall the compaction.
const HOOK_SCRIPT = `// joy-tmux PreCompact hook — auto-generated; do not edit.
// Best-effort: tells the daemon a compaction started so the app can show a
// "compacting" status. Always exits 0 (a blocking PreCompact would stall Claude).
import { readFileSync } from 'node:fs';
let trigger = 'auto';
try {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  if (input.trigger === 'manual' || input.trigger === 'auto') trigger = input.trigger;
} catch {}
try {
  const file = process.env.JOY_DAEMON_FILE;
  const sid = process.env.JOY_SESSION_ID;
  if (file && sid) {
    const { port, token } = JSON.parse(readFileSync(file, 'utf8'));
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 1500);
    await fetch('http://127.0.0.1:' + port + '/sessions/' + sid + '/compacting', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-joy-token': token },
      body: JSON.stringify({ trigger }),
      signal: ctrl.signal,
    }).catch(() => {});
    clearTimeout(timer);
  }
} catch {}
process.exit(0);
`;

// Bump when HOOK_SCRIPT or the settings shape changes so stale copies on disk
// are rewritten on the next daemon start.
const HOOK_VERSION = "1";

let cachedSettingsPath: string | null = null;

/**
 * Ensure the managed Claude settings file + PreCompact hook script exist in the
 * joy state dir, and return the settings path to pass to `claude --settings`.
 * Idempotent and cheap: writes only when missing or version-stale. Returns ""
 * if the files can't be written, so the caller can skip the flag rather than
 * hand claude a bad --settings path.
 */
export function ensureCompactHookSettings(): string {
  if (cachedSettingsPath) return cachedSettingsPath;
  const dir = joyStateDir();
  const hookPath = join(dir, "precompact-hook.mjs");
  const settingsPath = join(dir, "claude-settings.json");
  const stampPath = join(dir, "precompact-hook.version");
  try {
    mkdirSync(dir, { recursive: true });
    const stamp = existsSync(stampPath) ? readFileSync(stampPath, "utf8") : "";
    if (stamp !== HOOK_VERSION || !existsSync(hookPath) || !existsSync(settingsPath)) {
      writeFileSync(hookPath, HOOK_SCRIPT);
      // Run via the daemon's own node (absolute path) so the hook works
      // regardless of the login shell's PATH. Quote both paths for spaces.
      const command = `"${execPath}" "${hookPath}"`;
      const settings = {
        hooks: {
          PreCompact: [{ matcher: "", hooks: [{ type: "command", command }] }],
        },
      };
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
      writeFileSync(stampPath, HOOK_VERSION);
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
