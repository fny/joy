#!/usr/bin/env -S node --import tsx
// joy-tmux entry point: construct the session registry, mount the two
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
import { mkdirSync, writeFileSync } from "fs";
import { initRelay } from "./relay/relay.ts";
import { acquireSingleton, SingletonError } from "./singleton";
import { happyHomeDir, joyStateDir } from "./paths";
import { SessionRegistry } from "./domain/registry";
import { bindSessionOps } from "./domain/operations";
import { startHttpServer } from "./transports/http";
import { registerMachineOps } from "./transports/relay-machine";

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
try {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(join(STATE_DIR, "daemon.json"), JSON.stringify({
    token: SERVER_TOKEN, pid: process.pid, port: PORT,
    startedAt: Date.now(), version: "joy-tmux/0.1.0",
  }));
} catch (e) {
  process.stderr.write(`[server] failed to write daemon state: ${e}\n`);
}

const relayClient = initRelay();

// Machine-metadata blob upserted server-side: homeDir lets the app's path
// picker format ~/foo, and slashCommands (folded in by the command registry)
// powers the machine page's command list.
const machineMetadata = {
  host: hostname(),
  platform: osPlatform(),
  happyCliVersion: "joy-tmux/0.1.0",
  homeDir: homedir(),
  happyHomeDir: happyHomeDir(),
  happyLibDir: __dirname,
};

const registry = new SessionRegistry({
  tmuxSession: TMUX_SESSION,
  relayClient,
  baseMachineMetadata: machineMetadata,
  // Whenever a session gets a relay session attached (launch, recover, or
  // reconnect), register the session-scoped catalog ops AND push its slash
  // commands (project ∪ machine), folding the project into machine knowledge.
  onRelayAttached: (session, rs) => {
    bindSessionOps(session, rs);
    void registry.commands.onSessionAttached(session.cwd, rs);
  },
});

startHttpServer({ registry, port: PORT, publicDir: PUBLIC_DIR, token: SERVER_TOKEN });
process.stderr.write(`webchat server running on http://0.0.0.0:${PORT}\n`);

// Populate the machine-wide command set before recover() adopts sessions, so
// the first per-session push already includes personal + plugin commands.
registry.commands.rescanMachine();
registry.recover();

if (relayClient) {
  // Upsert machine metadata (homeDir for the picker + the discovered slash
  // commands for the machine page). pushMachineIfChanged sends the full blob,
  // so homeDir is preserved. Best-effort — failures only degrade those UIs.
  void registry.commands.pushMachineIfChanged();

  registerMachineOps(relayClient, registry);

  // Personal/plugin commands change rarely; re-scan on a coarse interval and
  // push only when the set actually changes (no fs.watch). Sessions refresh
  // their project portion on attach; the machine page has an explicit refresh.
  setInterval(() => {
    registry.commands.rescanMachine();
    void registry.commands.pushMachineIfChanged();
  }, 5 * 60 * 1000).unref();

  relayClient.onReconnect = () => registry.onRelayReconnect();
}
