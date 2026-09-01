#!/usr/bin/env -S node --import tsx
// joy-daemon entry point: construct the session registry, mount the two
// transports (HTTP debug surface + relay RPCs — both generated from the same
// operation catalog in operations.ts), recover any sessions left running in
// tmux from a previous daemon, and announce this machine to the relay.
//
// Architecture:
//   transport (parse wire) → operations.ts (route + glue) → Session/Registry (logic + state)
//
//   session.ts    — Session class: ALL per-session state + the single
//                   end()/sendText() lifecycle paths
//   registry.ts   — SessionRegistry: create/recover/reconnect + debug fan-out
//   operations.ts — the op catalog; each op defined once, reachable on both
//                   transports
//   transcript.ts — JSONL tail mechanics; fileOps.ts — bash/file/grep handlers

import { moduleDir } from "./esm";
import { join } from "path";
import { homedir, hostname, platform as osPlatform } from "os";
import { mkdirSync, writeFileSync, readFileSync } from "fs";
import { initRelay, loadCredentials } from "./relay/relay.ts";
import { startNucleusLane } from "./relay/nucleusLane.ts";
import { startTunnelExecutor } from "./tunnel/executor.ts";
import { acquireSingleton, SingletonError } from "./singleton";
import { joyStateDir, joyRelayUrl, joyRelayKey, joyHomeDir, joyRelayCredsDir } from "./paths";

// ~/.joy/env: optional KEY=value lines loaded into the daemon's environment at
// boot (never overriding real env). This is how provider API keys (e.g.
// FIREWORKS_API_KEY for the pi flavor) reach spawned agent processes on every
// platform — one file instead of per-platform systemd drop-ins / launchd
// plist edits. Lines starting with # are comments; `export ` prefixes are
// tolerated so a shell-style file works as-is.
try {
  const envFile = readFileSync(join(joyHomeDir(), "env"), "utf8");
  for (const raw of envFile.split("\n")) {
    const line = raw.trim().replace(/^export\s+/, "");
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (key && !(key in process.env)) process.env[key] = value;
  }
} catch { /* no ~/.joy/env — fine */ }
import { SessionRegistry } from "./domain/registry";
import { startHttpServer } from "./transports/http";
import { computeUsage, periodToRange } from "./claude/usage";
import { startResourceAlerts } from "./domain/resourceAlerts";

// Control-server port: the DEFAULT relay keeps the historical 4997; any other
// relay's daemon binds a DYNAMIC port (0) so N per-relay daemons coexist —
// the CLI discovers the real port from daemon.json, written on listen below.
// The daemon's local HTTP port. 4997 for every relay now that one machine
// runs one daemon; $PORT still overrides (a second daemon must be told a
// port explicitly rather than silently landing on a random one).
const PORT = parseInt(process.env.PORT ?? "4997");
const TMUX_SESSION = process.env.TMUX_SESSION ?? "joy";
const __dirname = moduleDir(import.meta.url);
const PUBLIC_DIR = join(__dirname, "..", "public"); // public/ is at the package root, src/ is one level down

// H3: per-instance token required on all mutating HTTP routes — prevents
// drive-by cross-origin session creation / prompt injection via no-cors POST.
const SERVER_TOKEN = crypto.randomUUID();
process.stderr.write(`[server] token: ${SERVER_TOKEN}\n`);

// Stable state file the `joy` CLI reads to locate + authenticate to this daemon
// (the token only otherwise appears on stderr, whose destination depends on how
// the daemon was launched). Written before listen so a racing CLI sees it.
const STATE_DIR = joyStateDir();

// Single-instance guard: refuse to start a second daemon on this machine (two
// would recover() the same tmux windows and attach duplicate relay sessions →
// duplicate messages). Acquired before any relay/tmux side effects.
try {
  const releaseLock = acquireSingleton(join(STATE_DIR, "daemon.lock"));
  process.on("exit", releaseLock);
  process.on("SIGINT", () => { releaseLock(); process.exit(0); });
  process.on("SIGTERM", () => { releaseLock(); process.exit(0); });
} catch (e) {
  if (e instanceof SingletonError) {
    process.stderr.write(`[server] ${e.message}; refusing to start a second daemon.\n`);
    process.exit(1);
  }
  throw e;
}
function writeDaemonState(port: number): void {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(join(STATE_DIR, "daemon.json"), JSON.stringify({
      token: SERVER_TOKEN, pid: process.pid, port,
      relay: joyRelayUrl(), relayKey: joyRelayKey(),
      startedAt: Date.now(), version: "joy-daemon/0.1.0",
    }));
  } catch (e) {
    process.stderr.write(`[server] failed to write daemon state: ${e}\n`);
  }
}
// Written before listen so a racing CLI sees it; with a dynamic port (0) the
// onListening rewrite below fills in the real one and the CLI polls until then.
writeDaemonState(PORT);

const relayClient = initRelay();

// Machine-metadata blob upserted server-side: homeDir lets the app's path
// picker format ~/foo, and slashCommands (folded in by the command registry)
// powers the machine page's command list.
const machineMetadata = {
  host: hostname(),
  platform: osPlatform(),
  joyDaemonVersion: "joy-daemon/0.1.0",
  homeDir: homedir(),
  joyHomeDir: joyRelayCredsDir(),
  joyLibDir: __dirname,
};

const registry = new SessionRegistry({
  tmuxSession: TMUX_SESSION,
  relayClient,
  baseMachineMetadata: machineMetadata,
  // Whenever a session gets a relay session attached (launch or recover),
  // push its slash commands (project ∪ machine), folding the project into
  // machine knowledge. Session ops arrive over the v2 tunnel (tunnel/executor).
  onRelayAttached: (session, rs) => {
    void registry.commands.onSessionAttached(session.cwd, rs, session.agentFlavor);
  },
});

startHttpServer({
  registry, port: PORT, publicDir: PUBLIC_DIR, token: SERVER_TOKEN,
  onListening: (port) => {
    if (port !== PORT) writeDaemonState(port);
    process.stderr.write(`webchat server running on http://127.0.0.1:${port} (relay ${joyRelayUrl()})\n`);
  },
});

// Populate the machine-wide command set before recover() adopts sessions, so
// the first per-session push already includes personal + plugin commands.
registry.commands.rescanMachine();
registry.recover();

// v2 nucleus lane: the daemon's app-facing message plane — claims the relay's
// durable v2 queue for this machine. Same credentials and machine identity as
// the account plane (RelayClient). Fail-soft: against a relay without /joy/v2
// it idles and retries; JOY_V2_LANE=0 disables it outright.
let nucleusLane: import("./relay/nucleusLane.ts").NucleusLaneHandle | null = null;
if (process.env.JOY_V2_LANE !== "0") {
  const creds = loadCredentials();
  if (creds) {
    nucleusLane = startNucleusLane({
      registry,
      relayUrl: joyRelayUrl(),
      token: creds.token,
      machineId: creds.machineId,
      // dataKey pairing carries the account's content PUBLIC key — the lane
      // seals v2 content under per-session keys enveloped to it. Legacy
      // pairings have no such key and stay on plaintext test envelopes.
      accountContentPublicKey: creds.encryption.type === "dataKey" ? creds.encryption.publicKey : null,
      log: (line) => process.stderr.write(line + "\n"),
    });
  } else {
    process.stderr.write("[v2-lane] no credentials (access.key) — lane not started\n");
  }

  // Sealed tunnel executor: serves this machine's /v2/* plane (files, git,
  // terminal, usage…) to the app THROUGH the relay, which only ever sees
  // opaque frames. Keyed on the per-machine key both ends share — a dataKey
  // daemon never holds the account master. Requires the local HTTP surface,
  // so it starts after startHttpServer bound its port.
  const tunnelCreds = loadCredentials();
  if (tunnelCreds && tunnelCreds.encryption.type === "dataKey" && tunnelCreds.encryption.machineKey.length === 32) {
    startTunnelExecutor({
      relayUrl: joyRelayUrl(),
      accountToken: tunnelCreds.token,
      machineKey: tunnelCreds.encryption.machineKey,
      machineId: tunnelCreds.machineId,
      // Borrow the lane's lease: acquiring a second one for the same machine
      // would release the lane's and the two would evict each other forever.
      borrowLease: () => nucleusLane?.currentLease() ?? null,
      targetBase: `http://127.0.0.1:${PORT}`,
      targetHeaders: { "X-Joy-Token": SERVER_TOKEN },
      log: (line) => process.stderr.write(line + "\n"),
    });
    process.stderr.write("[tunnel] executor started\n");
  } else {
    process.stderr.write("[tunnel] no dataKey machineKey — executor not started\n");
  }
}

if (relayClient) {
  // Upsert machine metadata (homeDir for the picker + the discovered slash
  // commands for the machine page). pushMachineIfChanged sends the full blob,
  // so homeDir is preserved. Best-effort — failures only degrade those UIs.
  void registry.commands.pushMachineIfChanged();

  // Personal/plugin commands change rarely; re-scan on a coarse interval and
  // push only when the set actually changes (no fs.watch). Sessions refresh
  // their project portion on attach; the machine page has an explicit refresh.
  setInterval(() => {
    registry.commands.rescanMachine();
    void registry.commands.pushMachineIfChanged();
  }, 5 * 60 * 1000).unref();

  // Push alerts when the box or an account quota crosses 90% (see
  // resourceAlerts.ts for the hysteresis + 4h cooldown semantics).
  startResourceAlerts(relayClient);
}

// Usage cache warmer: parse-ahead so joy-usage answers instantly. Once shortly
// after boot (folds any transcripts written while the daemon was down into the
// persisted cache), then every 2h in the background. The compute itself is
// incremental — cached files cost a stat each — so the periodic pass is cheap
// unless sessions were busy, which is exactly when pre-parsing pays off.
{
  const warm = () => {
    const { fromDay, toDay } = periodToRange("all");
    void computeUsage({ fromDay, toDay }).catch((e) => {
      process.stderr.write(`[usage] background warm failed: ${e}\n`);
    });
  };
  setTimeout(warm, 15_000).unref();
  setInterval(warm, 2 * 60 * 60 * 1000).unref();
}
