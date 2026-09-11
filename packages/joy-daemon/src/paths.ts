import { homedir } from "os";
import { join, dirname, isAbsolute, sep } from "path";
import { readFileSync, realpathSync, readdirSync, existsSync } from "fs";

/** Expand a leading ~ to the daemon user's home. tmux's -c does NOT expand
 *  tildes (it is not a shell) and the app may send paths with ~ unresolved.
 *  A RAW concatenation — never path.join/normalize: that folded `~/link/..`
 *  to the home directory before canonicalCwd could follow the link (#564
 *  residual). Callers that want a folded path canonicalise afterwards. */
export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return `${homedir().replace(/\/+$/, "")}${sep}${p.slice(2)}`;
  return p;
}

/** The ONE absolute, canonical form of a working directory (#549 #564):
 *  `~` expanded, `.`/`..` segments folded, symlinks resolved through the
 *  deepest existing ancestor (so a directory that does not exist yet —
 *  createDir, a clone target — still lands under its real parent). Claude
 *  Code keys its project dir (`~/.claude/projects/<encoded cwd>`) on the
 *  process's physical cwd, so a session launched in `/repo/.` or through a
 *  symlink was pinned to a transcript under a directory Claude never wrote;
 *  every launch, record, transcript path and teleport must use this form.
 *
 *  Resolution walks the path from the root with FILESYSTEM semantics — each
 *  existing component is realpath'd before the next one is looked at, and a
 *  `..` steps up from the PHYSICAL directory reached so far — the way the
 *  kernel enters the directory. A lexical `path.resolve` before the realpath
 *  folded `shortcut/..` to the link's parent, while `cd shortcut/..` lands in
 *  the link TARGET's parent: the session launched in a different directory
 *  (a different repository) from the one the user named (#564 residual).
 *  Components past the first missing one are folded lexically onto the
 *  resolved prefix (they exist nowhere yet, so there is nothing to follow). */
export function canonicalCwd(p: string): string {
  // RAW components — the spelling is never joined or normalised first, so
  // each `..` is applied to the directory actually reached. A relative
  // spelling is prefixed with the process cwd's components (already
  // physical: getcwd(3) returns the resolved directory); `join(cwd, spelled)`
  // folded `shortcut/..` lexically before the walk (#564 residual).
  const spelled = expandHome(p.trim());
  const prefix = isAbsolute(spelled) ? [] : process.cwd().split(sep);
  const parts = [...prefix, ...spelled.split(sep)].filter((seg) => seg !== "" && seg !== ".");
  let phys: string = sep;     // the physical directory reached so far
  const tail: string[] = [];  // components below the first missing one
  for (const seg of parts) {
    if (tail.length > 0) {
      // Below a missing directory nothing exists to follow: fold lexically.
      if (seg === "..") tail.pop(); else tail.push(seg);
      continue;
    }
    if (seg === "..") { phys = dirname(phys); continue; }
    try { phys = realpathSync.native(join(phys, seg)); }
    catch { tail.push(seg); /* not there (yet), or unreadable: lexical from here */ }
  }
  return join(phys, ...tail);
}

/** The Joy home — $JOY_HOME_DIR or ~/.joy. Daemon state, per-session dirs,
 *  and the relay pairing all live here.
 *
 *  ISOLATION RULE: an overridden JOY_HOME_DIR (tests, e2e harnesses) means an
 *  isolated universe — nothing under the real ~/.joy is read or written. */
export function joyHomeDir(): string {
  const env = process.env.JOY_HOME_DIR;
  if (env) return env.replace(/^~/, homedir());
  return join(homedir(), ".joy");
}

/** A relay URL as typed: a bare host[:port] gets https:// (`joy auth
 *  relay.example:4997`), a full http(s) URL passes through. There is no
 *  built-in relay and no alias table — the relay is always one you chose. */
export function normalizeRelayUrl(input: string): string {
  const v = input.trim().replace(/\/+$/, "");
  if (/^https?:\/\//i.test(v)) return v;
  if (/^[a-z0-9.-]+(:\d{1,5})?$/i.test(v) && v.includes(".")) return `https://${v}`;
  return v;
}

/** No relay configured on this machine: nothing in $JOY_RELAY_URL, no
 *  ~/.joy/relay.json, and not exactly one paired relay to infer it from. */
export class NoRelayConfiguredError extends Error {
  constructor() { super("no relay configured — pair this machine first: joy auth <relay url>"); this.name = "NoRelayConfiguredError"; }
}

// The ONE relay this machine talks to. Resolution, cached per process:
// $JOY_RELAY_URL (the installed service carries it) → ~/.joy/relay.json
// {serverUrl} (`joy auth` writes it) → the single relay this machine is
// paired with (~/.joy/relays/<key>/settings.json) — a machine paired before
// relay.json existed has no relay.json, and its shell must keep working.
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

export function joyRelayUrlOrNull(): string | null {
  if (cachedRelayUrl) return cachedRelayUrl;
  let url = process.env.JOY_RELAY_URL?.trim() ? normalizeRelayUrl(process.env.JOY_RELAY_URL) : undefined;
  if (!url) {
    try {
      const rc = JSON.parse(readFileSync(join(joyHomeDir(), "relay.json"), "utf8")) as { serverUrl?: string };
      if (rc.serverUrl) url = normalizeRelayUrl(rc.serverUrl);
    } catch { /* not written yet */ }
  }
  if (!url) url = pairedRelayUrl() ?? undefined;
  if (url) cachedRelayUrl = url;
  return url ?? null;
}

export function joyRelayUrl(): string {
  const url = joyRelayUrlOrNull();
  if (!url) throw new NoRelayConfiguredError();
  return url;
}

/** The relay of the ONE pairing under ~/.joy/relays/, from the serverUrl
 *  pairing wrote into its settings.json. Null when there is none, or more
 *  than one (then the machine must say which, in relay.json). */
function pairedRelayUrl(): string | null {
  let found: string[] = [];
  try {
    const root = join(joyHomeDir(), "relays");
    for (const d of readdirSync(root)) {
      try {
        const s = JSON.parse(readFileSync(join(root, d, "settings.json"), "utf8")) as { serverUrl?: string };
        if (s.serverUrl && existsSync(join(root, d, "access.key"))) found.push(normalizeRelayUrl(s.serverUrl));
      } catch { /* not a pairing */ }
    }
  } catch { return null; }
  found = [...new Set(found)];
  return found.length === 1 ? found[0] : null;
}

/** Stable identifier of the relay: host, or host_port — same convention as the
 *  credential dirs and the app. */
export function joyRelayKey(serverUrl: string = joyRelayUrl()): string {
  const u = new URL(serverUrl);
  return u.port ? `${u.hostname}_${u.port}` : u.hostname;
}

/** The daemon's tmux namespace, `-L joy-<relayKey>`. Derived from the relay
 *  and kept that way: renaming it would orphan the live windows of every
 *  installed daemon. */
export function tmuxSocketArgs(): string[] {
  return ["-L", `joy-${joyRelayKey()}`];
}

/** Per-SESSION tmux server label (docs/per-session-tmux-design.md): each
 *  agent session gets its own server so a tmux leak dies with the session
 *  (kill-server returns every byte to the OS). `joy-<id>` — the session
 *  inside carries the same name and the agent runs in a window pinned to
 *  `agent`, so `tmux -L joy-<id> attach` is the whole incantation and other
 *  windows can be added beside the agent's. (Older servers were labelled
 *  `joy-<relayKey>-s-<id>` with session `j-<id>`; tmuxNamesFor() still
 *  resolves those from their records until they end.) */
export function tmuxServerLabel(sessionId: string): string {
  return `joy-${sessionId}`;
}

/** The tmux session name + agent-window target for a per-session server,
 *  by label scheme. */
export function tmuxNamesFor(socket: string, sessionId: string): { session: string; target: string } {
  if (socket === `joy-${sessionId}`) return { session: socket, target: `${socket}:${TMUX_AGENT_WINDOW}` };
  return { session: `j-${sessionId}`, target: `j-${sessionId}` }; // legacy per-session scheme
}

/** The one window the daemon manages on a per-session server. Pinned
 *  (automatic-rename off) so the running command never renames it. */
export const TMUX_AGENT_WINDOW = "agent";

/** Test-only: drop the cached relay resolution so env overrides apply. */
export function __resetRelaySelection(): void {
  cachedRelayUrl = null;
}

/** Where the daemon keeps its state: daemon.json, windows, queues, receipts.
 *  Relay-scoped: everything lives beside that relay's credentials under
 *  ~/.joy/relays/<key>/state — beside the pairing it belongs to. */
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

/** Where the app's uploads for a session land (attachments.ts writeUpload) —
 *  beside the agent's media, never in the project. */
export function joySessionUploadsDir(sessionId: string): string {
  return join(joySessionDir(sessionId), "uploads");
}
