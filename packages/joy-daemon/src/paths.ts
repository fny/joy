import { homedir } from "os";
import { join } from "path";
import { readFileSync } from "fs";

/** The Joy home — $JOY_HOME_DIR or ~/.joy. Daemon state, per-session dirs,
 *  and per-relay credentials all live here.
 *
 *  ISOLATION RULE: an overridden JOY_HOME_DIR (tests, e2e harnesses) means an
 *  isolated universe — nothing under the real ~/.joy is read or written. */
export function joyHomeDir(): string {
  const env = process.env.JOY_HOME_DIR;
  if (env) return env.replace(/^~/, homedir());
  return join(homedir(), ".joy");
}

/** The relay a daemon talks to when nothing is configured. Override with
 *  $JOY_RELAY_URL (alias or URL) or ~/.joy/relay.json {serverUrl}. */
export const DEFAULT_RELAY_URL = "https://joy.voltai.party:4997";

/** Shorthand names accepted by --relay / JOY_RELAY_URL — mirrors the app's
 *  KNOWN_RELAYS (joy-app sources/sync/serverConfig.ts). */
export const RELAY_ALIASES: Record<string, string> = {
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
 *  (open relays). Read lazily, NOT cached: the env loader may run after
 *  module import. */
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

/** Stable per-relay identifier: host, or host_port — same convention as the
 *  credential dirs and the app. */
export function joyRelayKey(serverUrl: string = joyRelayUrl()): string {
  const u = new URL(serverUrl);
  return u.port ? `${u.hostname}_${u.port}` : u.hostname;
}

/** Per-relay tmux namespace: every relay gets its OWN tmux server via -L, so
 *  concurrent daemons never share a window registry or a control-mode client. */
export function tmuxSocketArgs(): string[] {
  return ["-L", `joy-${joyRelayKey()}`];
}

/** Per-SESSION tmux server label (docs/per-session-tmux-design.md): each
 *  agent session gets its own server so a tmux leak dies with the session
 *  (kill-server returns every byte to the OS). Relay-scoped so concurrent
 *  per-relay daemons can never collide on a session id. */
export function tmuxServerLabel(sessionId: string): string {
  return `joy-${joyRelayKey()}-s-${sessionId}`;
}

/** Test-only: drop the cached relay resolution so env overrides apply. */
export function __resetRelaySelection(): void {
  cachedRelayUrl = null;
}

/** Where the daemon keeps its state: daemon.json, windows, queues, receipts.
 *  Relay-scoped: everything lives beside that relay's credentials under
 *  ~/.joy/relays/<key>/state, so concurrent per-relay daemons never share. */
export function joyStateDir(): string {
  return join(joyRelayCredsDir(), "state");
}

/** Credentials dir for a relay: ~/.joy/relays/<host[_port]>/ (access.key +
 *  settings.json + perimeter.key, written by `joy auth`). */
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
