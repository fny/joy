#!/usr/bin/env bun
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

import { join } from "path";
import { homedir, hostname, platform as osPlatform } from "os";
import { initRelay } from "./relay.ts";
import { SessionRegistry } from "./registry";
import { bindSessionOps } from "./operations";
import { startHttpServer } from "./transports/http";
import { registerMachineOps } from "./transports/relay-machine";

const PORT = parseInt(process.env.PORT ?? "4997");
const TMUX_SESSION = process.env.TMUX_SESSION ?? "joy";
const PUBLIC_DIR = join(import.meta.dir, "public");

// H3: per-instance token required on all mutating HTTP routes — prevents
// drive-by cross-origin session creation / prompt injection via no-cors POST.
const SERVER_TOKEN = crypto.randomUUID();
process.stderr.write(`[server] token: ${SERVER_TOKEN}\n`);

const relayClient = initRelay();

const registry = new SessionRegistry({
  tmuxSession: TMUX_SESSION,
  relayClient,
  // Whenever a session gets a relay session attached (launch, recover, or
  // reconnect), register the session-scoped catalog ops on it.
  onRelayAttached: (session, rs) => bindSessionOps(session, rs),
});

startHttpServer({ registry, port: PORT, publicDir: PUBLIC_DIR, token: SERVER_TOKEN });
process.stderr.write(`webchat server running on http://0.0.0.0:${PORT}\n`);

registry.recover();

if (relayClient) {
  // Upsert this machine's metadata server-side so the app's path picker can
  // format ~/foo nicely. homeDir is the field we actually care about; the
  // rest satisfy the schema. Best-effort — failures only degrade picker UX.
  void relayClient.getOrCreateMachine({
    host: hostname(),
    platform: osPlatform(),
    happyCliVersion: "joy-tmux/0.1.0",
    homeDir: homedir(),
    happyHomeDir: join(homedir(), ".happy"),
    happyLibDir: import.meta.dir,
  }).then(ok => {
    process.stderr.write(`[relay] machine metadata upsert: ${ok ? "ok" : "failed"}\n`);
  });

  registerMachineOps(relayClient, registry);

  relayClient.onReconnect = () => registry.onRelayReconnect();
}
