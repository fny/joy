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
import { readFileSync } from "fs";
import { initRelay, loadCredentials } from "./relay/relay.ts";
import { migrateLegacyEnvFile, applyEnvStore } from "./domain/envStore";
import { startNucleusLane } from "./relay/nucleusLane.ts";
import { startTunnelExecutor } from "./tunnel/executor.ts";
import { acquireSingleton, SingletonError } from "./singleton";
import { joyStateDir, joyRelayUrl, joyRelayKey, joyHomeDir, joyRelayCredsDir } from "./paths";
import { ledgerFor } from "./domain/ledger";
import { mkdirSecure, writeSecretFileAtomic } from "./domain/secretFile";
import { launcherFromEnv, processStartId } from "./daemonLauncher";
import { importLegacyState } from "./domain/ledgerImport";

// Provider keys for spawned agents live in the sealed store (~/.joy/env.sealed,
// domain/envStore.ts — set from the app or `joy env set`). A plaintext
// ~/.joy/env from before is sealed into it here and removed. applyEnvStore
// runs again before every spawn, so a key added later reaches the next
// session without a restart.
migrateLegacyEnvFile((line) => process.stderr.write(line + "\n"));
applyEnvStore();
import { SessionRegistry } from "./domain/registry";
import { startHttpServer } from "./transports/http";
import { computeUsage, periodToRange } from "./claude/usage";

// Last resort. Every known fire-and-forget promise is observed at its call
// site; this exists so the NEXT one somebody forgets logs a stack instead of
// killing every live session's lane (two such crashes filed on 2026-09-04,
// issues #29 and #46). uncaughtException is left to Node: a throw out of a
// synchronous callback means state is unknown, and systemd restarts us.
process.on("unhandledRejection", (reason) => {
  const msg = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
  process.stderr.write(`[daemon] unhandled rejection (kept running): ${msg}\n`);
});
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
// The token itself is NOT logged (#48): stderr becomes ~/.joy/.../daemon.log,
// opened with the umask default, so printing it published machine-wide
// session/bash/file access to every local account. It lives in daemon.json
// (0600), which is where the CLI reads it from.
process.stderr.write(`[server] control token written to daemon.json\n`);

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
    mkdirSecure(STATE_DIR);
    writeSecretFileAtomic(join(STATE_DIR, "daemon.json"), JSON.stringify({
      token: SERVER_TOKEN, pid: process.pid, port,
      relay: joyRelayUrl(), relayKey: joyRelayKey(),
      startedAt: Date.now(), version: "joy-daemon/0.1.0",
      // Process identity for `joy stop` (#495): the kernel's start identity
      // for THIS pid (the one thing a reused pid cannot reproduce), the entry
      // script this daemon runs (process.argv[1] — absolute, the way the
      // command line shows it) and the node binary. verifyDaemonPid requires
      // the live pid to match all three before it signals anything; a
      // daemon.json that outlived its writer used to get whatever now held
      // the pid killed.
      startId: processStartId(process.pid), entry: process.argv[1], exec: process.execPath,
      // How this daemon was launched (#502 residual): `joy stop` consults it
      // when the supervisor itself cannot be asked whether it owns the pid.
      launcher: launcherFromEnv(process.env),
    }));
  } catch (e) {
    process.stderr.write(`[server] failed to write daemon state: ${e}\n`);
  }
}
// Written before listen so a racing CLI sees it; with a dynamic port (0) the
// onListening rewrite below fills in the real one and the CLI polls until then.
writeDaemonState(PORT);

// The durable acceptance ledger (domain/ledger.ts): opened before anything
// recovers or accepts work, with the one-time import of the legacy per-file
// stores (queue-*.json, *.receipts.json, v2-outbound.json, codex-*.json,
// v2-spawns.json, the execution fields of window-*.json) — originals moved
// to state/imported-v1/. Terminal rows are pruned on a 7-day retention.
// A source that fails to import is left in place and retried next boot; the
// sessions it belongs to are quarantined below (review 95c4781e).
const importReport = (() => {
  const ledger = ledgerFor(STATE_DIR);
  const creds = loadCredentials();
  const report = importLegacyState(ledger, STATE_DIR, { sealsContent: !!creds?.encryption?.publicKey, log: (line) => process.stderr.write(line + "\n") });
  if (report.failed.length) {
    process.stderr.write(`[ledger-import] ${report.failed.length} file(s) could not be imported (left in place, retried next boot): ${report.failed.map((f) => `${f.file} (${f.error})`).join(", ")}`
      + (report.quarantine.length ? `; quarantined until then: ${report.quarantine.join(", ")}` : "") + "\n");
  }
  const prune = () => { try { const r = ledger.prune(); if (r.commands || r.outbox || r.receipts) process.stderr.write(`[ledger] pruned ${r.commands} commands, ${r.outbox} outbox rows, ${r.receipts} receipts\n`); } catch (e) { process.stderr.write(`[ledger] prune failed: ${e instanceof Error ? e.message : e}\n`); } };
  prune();
  setInterval(prune, 24 * 3_600_000).unref();
  return report;
})();

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
// Boot gate: a session whose legacy source failed to import must not accept
// or recover work until the import completes — recover() skips it (logged
// once) and create({ id }) refuses it.
if (importReport.quarantine.length) registry.quarantine(importReport.quarantine, "legacy import failed");

// The port the local surface ACTUALLY bound. With PORT=0 the kernel picks
// one and only onListening knows it — everything that dials the local
// surface must read it from here rather than capture PORT (#588).
let boundPort = PORT;
startHttpServer({
  registry, port: PORT, publicDir: PUBLIC_DIR, token: SERVER_TOKEN,
  onListening: (port) => {
    boundPort = port;
    if (port !== PORT) writeDaemonState(port);
    process.stderr.write(`webchat server running on http://127.0.0.1:${port} (relay ${joyRelayUrl()})\n`);
  },
});

// Populate the machine-wide command set before recover() adopts sessions, so
// the first per-session push already includes personal + plugin commands.
registry.commands.rescanMachine();
void registry.recover().catch((e) => process.stderr.write(`[recover] failed: ${e instanceof Error ? e.message : e}\n`));

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
      // The pairing carries the account's content PUBLIC key — the lane
      // seals v2 content under per-session keys enveloped to it.
      accountContentPublicKey: creds.encryption.publicKey,
      // The per-machine key: the lane opens spawn specs the app sealed under
      // its "Joy Spawn Spec" leaf (#107) — the same root the tunnel uses.
      machineKey: creds.encryption.machineKey.length === 32 ? creds.encryption.machineKey : null,
      log: (line) => process.stderr.write(line + "\n"),
    });
    // The machine record advertises `capabilities.spawnSpecSealed` from the
    // LANE's key state — the one that will actually open the spec (#107).
    // Credentials are read once per boot (`joy auth` re-pairs on disk and
    // the daemon restarts), so this is set once; should the key ever change
    // in-process, set it again and pushMachineIfChanged republishes once.
    if (relayClient?.setSpawnSpecSealed(nucleusLane.spawnSpecSealed())) void registry.commands.pushMachineIfChanged();
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
      // Resolved per request from the BOUND port (#588): with PORT=0 the
      // executor used to hold http://127.0.0.1:0 forever, so every tunneled
      // files / git / terminal / usage request failed with a sealed 502
      // while the local HTTP server was healthy.
      targetBase: () => `http://127.0.0.1:${boundPort}`,
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
