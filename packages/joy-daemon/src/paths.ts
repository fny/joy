import { homedir } from "os";
import { join } from "path";
import { existsSync, mkdirSync, renameSync, symlinkSync, lstatSync, readFileSync } from "fs";

/**
 * The Happy home directory — $HAPPY_HOME_DIR (with a leading ~ expanded) or
 * ~/.happy. As of 2026-08-11 this holds ONLY what belongs to the ORIGINAL
 * relay's pairing (access.key, settings.json — shared with happy-cli daemons).
 * Everything joy-owned lives under joyHomeDir().
 */
export function happyHomeDir(): string {
  const env = process.env.HAPPY_HOME_DIR;
  return env ? env.replace(/^~/, homedir()) : join(homedir(), ".happy");
}

/** The Joy home — $JOY_HOME_DIR or ~/.joy. Daemon state, per-session dirs,
 *  and credentials for any NON-default relay all live here.
 *
 *  ISOLATION RULE: an overridden HAPPY_HOME_DIR (tests, e2e harnesses) means
 *  an isolated universe — joy state follows it unless JOY_HOME_DIR says
 *  otherwise. Without this, an "isolated" daemon reads the real ~/.joy/state
 *  (observed live 2026-08-12: the e2e daemon hit the PROD singleton lock and
 *  the compat symlink pointed the test home at prod state). */
export function joyHomeDir(): string {
  const env = process.env.JOY_HOME_DIR;
  if (env) return env.replace(/^~/, homedir());
  const happyEnv = process.env.HAPPY_HOME_DIR;
  if (happyEnv) return happyEnv.replace(/^~/, homedir());
  return join(homedir(), ".joy");
}

/** The relay a daemon talks to when nothing is configured. Override with
 *  $JOY_RELAY_URL (alias or URL) or ~/.joy/relay.json {serverUrl}. */
export const DEFAULT_RELAY_URL = "https://joy.voltai.party:4997";

/** The ORIGINAL relay, and the ONLY one that keeps the legacy on-disk layout:
 *  credentials in ~/.happy (shared with happy-cli), bare tmux namespaces, state
 *  in ~/.joy/state. Every other relay — today's default included — is scoped by
 *  relay key, which is what lets the default move without relocating an
 *  existing install's credentials, state or live tmux sockets. */
export const LEGACY_RELAY_URL = "https://api.cluster-fluster.com";

/** Shorthand names accepted by --relay / JOY_RELAY_URL — mirrors the app's
 *  KNOWN_RELAYS (joy-app sources/sync/serverConfig.ts). */
export const RELAY_ALIASES: Record<string, string> = {
  happy: LEGACY_RELAY_URL,
  "happy-joy": "https://joy.voltai.party:24997",
  joy: DEFAULT_RELAY_URL,
  "joy-dev": "https://joy.voltai.party:14997",
};

export function resolveRelayAlias(nameOrUrl: string): string {
  return RELAY_ALIASES[nameOrUrl] ?? nameOrUrl;
}

// The relay THIS PROCESS is bound to. One daemon/CLI process serves exactly
// one relay — running against another relay is a different process — so the
// resolution is cached. Selection: $JOY_RELAY_URL (alias or URL) →
// ~/.joy/relay.json {serverUrl} → the default relay.
let cachedRelayUrl: string | null = null;

/** Relay perimeter key (joy-relay's gate). Priority: JOY_RELAY_ACCESS_KEY
 *  env (via ~/.joy/env or the service env) as an explicit override, then
 *  perimeter.key beside the relay creds — written by `joy auth` pairing,
 *  derived from the account secret (same tree as the app, so every client
 *  presents the identical value with zero distribution). Null → send nothing
 *  (open relays, Happy Cloud). Read lazily, NOT cached: the env loader may
 *  run after module import. */
export function joyRelayAccessKey(): string | null {
  const k = process.env.JOY_RELAY_ACCESS_KEY;
  if (k && k.trim()) return k.trim();
  try {
    const v = readFileSync(join(joyRelayCredsDir(), "perimeter.key"), "utf8").trim();
    if (v) return v;
  } catch { /* not paired against a gated relay */ }
  return null;
}

export function joyRelayUrl(): string {
  if (cachedRelayUrl) return cachedRelayUrl;
  let url = process.env.JOY_RELAY_URL ? resolveRelayAlias(process.env.JOY_RELAY_URL) : undefined;
  if (!url) {
    try {
      const rc = JSON.parse(readFileSync(join(joyHomeDir(), "relay.json"), "utf8")) as { serverUrl?: string };
      if (rc.serverUrl) url = rc.serverUrl;
    } catch { /* no override → default */ }
  }
  cachedRelayUrl = url || DEFAULT_RELAY_URL;
  return cachedRelayUrl;
}

/** Talking to the relay a fresh install would pick. Display only — it must
 *  never gate on-disk layout, or changing the default would move files. */
export function isDefaultRelay(): boolean {
  return joyRelayUrl() === DEFAULT_RELAY_URL;
}

/** The legacy relay's bare on-disk layout (see LEGACY_RELAY_URL). This — not
 *  isDefaultRelay — is what credential dirs, state dirs and tmux namespaces
 *  key on, so those stay put no matter what the default becomes. */
export function usesLegacyLayout(): boolean {
  return joyRelayUrl() === LEGACY_RELAY_URL;
}

/** Stable per-relay identifier: host, or host_port — same convention as the
 *  credential dirs and the app. */
export function joyRelayKey(serverUrl: string = joyRelayUrl()): string {
  const u = new URL(serverUrl);
  return u.port ? `${u.hostname}_${u.port}` : u.hostname;
}

/** Per-relay tmux namespace. The DEFAULT relay keeps the default tmux server
 *  (and the plain "joy" session) — unchanged for the running fleet. Any other
 *  relay gets its OWN tmux server via -L, so concurrent daemons never share a
 *  window registry or a control-mode client. (Eventually, when the joy relay
 *  becomes primary, its daemon takes the plain "joy" namespace.) */
export function tmuxSocketArgs(): string[] {
  return usesLegacyLayout() ? [] : ["-L", `joy-${joyRelayKey()}`];
}

/** Per-SESSION tmux server label (docs/per-session-tmux-design.md): each
 *  agent session gets its own server so a tmux leak dies with the session
 *  (kill-server returns every byte to the OS). Relay-scoped so concurrent
 *  per-relay daemons can never collide on a session id. */
export function tmuxServerLabel(sessionId: string): string {
  return usesLegacyLayout() ? `joy-s-${sessionId}` : `joy-${joyRelayKey()}-s-${sessionId}`;
}

/** Test-only: drop the cached relay resolution so env overrides apply. */
export function __resetRelaySelection(): void {
  cachedRelayUrl = null;
}

// One-shot migration: the state dir moved from ~/.happy/joy-tmux-state to
// ~/.joy/state (2026-08-11). A same-filesystem rename carries windows/queues/
// receipts across atomically; the old location is left absent so happy tools
// never see stale joy state. Lazy + cached: every entrypoint (server, cli,
// tests via env overrides) goes through joyStateDir().
let stateMigrated = false;

/** Where the daemon keeps its state: daemon.json, windows, queues, receipts.
 *  Relay-scoped: a NON-default relay's daemon keeps everything (lock,
 *  daemon.json, windows, queues, receipts) beside that relay's credentials
 *  under ~/.joy/relays/<key>/state, so concurrent per-relay daemons never
 *  share state. Only the default relay's dir carries migration history. */
export function joyStateDir(): string {
  if (!usesLegacyLayout()) return join(joyRelayCredsDir(), "state");
  const dir = join(joyHomeDir(), "state");
  if (!stateMigrated) {
    stateMigrated = true;
    const legacy = join(happyHomeDir(), "joy-tmux-state");
    const legacyExists = (() => { try { lstatSync(legacy); return true; } catch { return false; } })();
    if (!existsSync(dir) && legacyExists) {
      try {
        mkdirSync(joyHomeDir(), { recursive: true });
        renameSync(legacy, dir);
        process.stderr.write(`[paths] migrated state ${legacy} -> ${dir}\n`);
      } catch (e) {
        process.stderr.write(`[paths] state migration failed (${e}) — using legacy dir\n`);
        return legacy;
      }
    }
    // (A compat symlink at the legacy path existed 2026-08-11..13 for sessions
    // with the old path baked into their hook settings; the fleet was cycled
    // 2026-08-13, so new code no longer creates it.)
  }
  return dir;
}

/** Credentials dir for a NON-default relay: ~/.joy/relays/<host[_port]>/
 *  (access.key + settings.json, same shapes as ~/.happy's). The DEFAULT
 *  relay's credentials stay in ~/.happy — they're shared with happy-cli. */
export function joyRelayCredsDir(serverUrl: string = joyRelayUrl()): string {
  return join(joyHomeDir(), "relays", joyRelayKey(serverUrl));
}

/** Per-session home for everything session-related the daemon/agent persists
 *  outside the project cwd — display images (joy-img media/), future drafts,
 *  exports. The readFile RPC allows this directory as a second root scoped to
 *  exactly the session being asked (each session reaches only its own folder). */
export function joySessionDir(sessionId: string): string {
  return join(joyHomeDir(), "sessions", sessionId);
}
