#!/usr/bin/env -S node --import tsx
// joy — CLI for the joy-daemon daemon (start/stop/restart/status/list/doctor/
// install/auth/notify), driving the daemon over its localhost HTTP API. The daemon writes daemon.json
// (token+pid+port) into its relay-scoped state dir on startup, which is how
// this CLI finds and authenticates to it — one daemon (and one state dir,
// tmux server, service unit) per relay; --relay picks which one.

import { existsSync, readFileSync, writeFileSync, mkdirSync, openSync, rmSync, readlinkSync, realpathSync } from "fs";
import { join, dirname, resolve, basename, sep, isAbsolute } from "path";
import { homedir, platform as osPlatform } from "os";
import { spawn, spawnSync } from "child_process";
import { moduleDir } from "./esm";
import { joyHomeDir, joyStateDir, joyRelayUrl, joyRelayKey, isDefaultRelay, joyRelayCredsDir, resolveRelayAlias } from "./paths";
import { parseBackupCode, pairWithRelay, deriveRelayPerimeterKey } from "./relay/pairing";
import { createInterface } from "node:readline/promises";
import { tmuxArgv } from "./tmux/shell";
import { launchdPlist } from "./launchdPlist";

// --relay <alias|url> (also --relay=…) selects which relay's daemon this CLI
// invocation addresses. Consumed HERE, before any relay-scoped const below is
// computed, by bridging to JOY_RELAY_URL — which paths.ts and any daemon we
// spawn both read. One process, one relay.
for (let i = process.argv.length - 1; i >= 2; i--) {
  const a = process.argv[i];
  if (a === "--relay" && process.argv[i + 1]) {
    process.env.JOY_RELAY_URL = resolveRelayAlias(process.argv[i + 1]);
    process.argv.splice(i, 2);
  } else if (a.startsWith("--relay=")) {
    process.env.JOY_RELAY_URL = resolveRelayAlias(a.slice("--relay=".length));
    process.argv.splice(i, 1);
  }
}

const DEFAULT_PORT = 4997;
// Credentials home for the SELECTED relay: ~/.joy/relays/<key>/.
const CREDS_DIR = joyRelayCredsDir();
const STATE_DIR = joyStateDir();
const STATE_FILE = join(STATE_DIR, "daemon.json");
const LOG_FILE = join(STATE_DIR, "daemon.log");
// pnpm global installs resolve import.meta.url into pnpm's versioned content-addressed
// store (…/node_modules/.pnpm/@fny+joy-daemon@1.0.15_…/node_modules/@fny/joy-daemon). Baking
// THAT into a launchd/systemd service breaks on the next `pnpm add -g`: pnpm makes a fresh
// store dir for the new version and deletes the old one, so the service's server.ts path
// vanishes and the daemon crash-loops. Collapse it to pnpm's stable top-level node_modules
// symlink (always repointed at the current version). No-op for source checkouts / npm-global,
// which have no .pnpm segment. (NODE = process.execPath is already a stable, canonical
// version-install path — verified — so it needs no such treatment.)
//
// The virtual store always hangs off a `node_modules` directory, so the rewrite must
// swallow "node_modules/.pnpm/<pkg>/node_modules/" as ONE unit: replacing only the
// ".pnpm/<pkg>/node_modules/" tail left the leading node_modules standing and produced
// …/node_modules/node_modules/@fny/joy-daemon — a directory that does not exist, so
// `joy start` spawned nothing and `joy install` baked a dead path into the unit (#503).
// The collapsed path is used only when server.ts is actually there; otherwise the
// real (store) path stands, which at least works until the next upgrade.
export function resolvePkgDir(dir: string, exists: (p: string) => boolean = existsSync): string {
  const candidates = [
    dir.replace(/\/node_modules\/\.pnpm\/[^/]+\/node_modules\//, "/node_modules/"),
    // A virtual store not under node_modules (custom virtual-store-dir): the
    // .pnpm segment's parent is the install root.
    dir.replace(/\/\.pnpm\/[^/]+\/node_modules\//, "/node_modules/"),
  ];
  for (const c of candidates) {
    if (c !== dir && exists(join(c, "server.ts"))) return c;
  }
  return dir;
}
const PKG_DIR = resolvePkgDir(moduleDir(import.meta.url));
const SERVER_TS = join(PKG_DIR, "server.ts");
const NODE = process.execPath;

// ── tiny ANSI helpers (no dep) ──────────────────────────────────────────────
const c = {
  g: (s: string) => `\x1b[32m${s}\x1b[0m`,
  r: (s: string) => `\x1b[31m${s}\x1b[0m`,
  y: (s: string) => `\x1b[33m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  b: (s: string) => `\x1b[1m${s}\x1b[0m`,
};
const ok = c.g("✓");
const bad = c.r("✗");
const warn = c.y("!");

/** daemon.json. `entry`/`exec` (#495 residual) are the daemon's own
 *  process.argv[1] and process.execPath, recorded at start so a stale pid can
 *  be checked against the exact script it should be running. */
type DaemonState = { token: string; pid: number; port: number; relay?: string; startedAt: number; version: string; entry?: string; exec?: string };

function readState(): DaemonState | null {
  try { return JSON.parse(readFileSync(STATE_FILE, "utf8")) as DaemonState; } catch { return null; }
}

/** The selected relay's daemon control port. daemon.json is authoritative
 *  (non-default relays bind dynamically); $PORT then the fixed 4997 cover the
 *  default relay. A non-default relay with no daemon.json has NO port — never
 *  fall back to 4997 there, that's the DEFAULT daemon's port. */
function daemonPort(): number | null {
  const st = readState();
  if (st?.port) return st.port;
  if (process.env.PORT) return parseInt(process.env.PORT);
  return DEFAULT_PORT;
}

function base(): string | null {
  const port = daemonPort();
  return port ? `http://127.0.0.1:${port}` : null;
}

function authHeaders(): Record<string, string> {
  const st = readState();
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (st?.token) h["X-Joy-Token"] = st.token;
  return h;
}

async function api(method: string, path: string, body?: unknown, init: { signal?: AbortSignal } = {}): Promise<Response> {
  const b = base();
  if (!b) throw new Error("daemon not running (no daemon.json for this relay)");
  return fetch(b + path, {
    method,
    headers: authHeaders(),
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: init.signal,
  });
}

/** Returns the live status JSON if the daemon answers, else null. */
async function probe(): Promise<any | null> {
  const b = base();
  if (!b) return null;
  try {
    const r = await fetch(b + "/status", { headers: authHeaders() });
    if (r.ok) return await r.json();
  } catch { /* not running */ }
  return null;
}

function fmtUptime(ms: number): string {
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

function which(cmd: string): string | null {
  const r = spawnSync("sh", ["-lc", `command -v ${cmd}`], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

// ── commands ────────────────────────────────────────────────────────────────

async function cmdStatus(): Promise<number> {
  const s = await probe();
  if (!s) { console.log(`${bad} joy-daemon daemon not running`); return 1; }
  console.log(`${ok} joy-daemon daemon ${c.b("running")}`);
  console.log(`  version  ${s.version ?? "?"}`);
  console.log(`  pid      ${s.pid ?? "?"}`);
  console.log(`  port     ${daemonPort() ?? "?"}`);
  console.log(`  relay    ${joyRelayUrl()}${isDefaultRelay() ? " (default)" : ""}`);
  if (s.uptimeMs != null) console.log(`  uptime   ${fmtUptime(s.uptimeMs)}`);
  if (s.sessions != null) console.log(`  sessions ${s.sessions} active`);
  if (s.claude) console.log(`  claude   ${s.claude.available ? (s.claude.version ?? "available") : c.r("not found")}`);
  return 0;
}

async function cmdList(): Promise<number> {
  const r = await api("GET", "/sessions").catch(() => null);
  if (!r || !r.ok) { console.log(`${bad} daemon not running (joy start)`); return 1; }
  const sessions = (await r.json()) as any[];
  if (sessions.length === 0) { console.log("no sessions"); return 0; }
  const checks = await Promise.all(sessions.map((s) => checkState(s.id)));
  const ago = (t?: number) => (t ? fmtUptime(Date.now() - t) + " ago" : "");
  for (const [i, s] of sessions.entries()) {
    const ck = checks[i];
    const state = s.status === "ended" ? c.dim("ended") : ck?.state === "needs_input" ? c.y("needs input") : ck?.state === "busy" ? c.y("busy") : ck?.state === "error" ? c.r("error") : c.g("idle");
    const title = s.summary?.text ?? (typeof s.summary === "string" ? s.summary : "");
    console.log(`  ${c.b(s.id)}  ${String(s.agent ?? "claude").padEnd(8)} ${state.padEnd(20)} ${String(title).slice(0, 40).padEnd(40)}  ${s.cwd}${s.last_active_at ? c.dim("  " + ago(s.last_active_at)) : ""}`);
  }
  return 0;
}

async function cmdStart(): Promise<number> {
  if (await probe()) {
    const st = readState();
    console.log(`${ok} already running (pid ${st?.pid ?? "?"})`);
    return 0;
  }
  if (!existsSync(SERVER_TS)) {
    // Never spawn a path we cannot see (#503): the failure would surface as
    // "daemon did not come up" ten seconds later with a node ENOENT in the log.
    console.log(`${bad} daemon source not found at ${SERVER_TS} — reinstall @fny/joy-daemon`);
    return 1;
  }
  mkdirSync(STATE_DIR, { recursive: true });
  const out = openSync(LOG_FILE, "a");
  const child = spawn(NODE, ["--import", "tsx", SERVER_TS], {
    detached: true,
    stdio: ["ignore", out, out],
    cwd: PKG_DIR,
    env: process.env,
  });
  child.unref();
  process.stdout.write("starting joy-daemon daemon");
  for (let i = 0; i < 50; i++) {
    await new Promise(r => setTimeout(r, 200));
    process.stdout.write(".");
    if (await probe()) { console.log(`\n${ok} started (pid ${readState()?.pid})`); return 0; }
  }
  console.log(`\n${bad} daemon did not come up — see ${LOG_FILE}`);
  return 1;
}

/** What the OS says process `pid` is: its command line and, where the kernel
 *  tells us (Linux /proc), when it started and its working directory (to
 *  resolve a relative script operand). null = no such process. */
export interface ProcessIdentity { command: string; startedAt?: number; cwd?: string }
export function processIdentity(pid: number): ProcessIdentity | null {
  if (osPlatform() === "linux") {
    let command: string;
    try {
      command = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean).join(" ");
    } catch { return null; }
    let cwd: string | undefined;
    try { cwd = readlinkSync(`/proc/${pid}/cwd`); } catch { /* a foreign uid's process; the command alone decides */ }
    let startedAt: number | undefined;
    try {
      // /proc/<pid>/stat: "pid (comm) state ppid …"; comm may contain spaces
      // and parens, so split after the LAST ')'. starttime is field 22 overall
      // = index 19 after the comm, in clock ticks since boot (CLK_TCK = 100 on
      // every Linux Node ships for); btime is the boot time in epoch seconds.
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
      const ticks = Number(fields[19]);
      const btimeLine = readFileSync("/proc/stat", "utf8").split("\n").find((l) => l.startsWith("btime "));
      const btime = btimeLine ? Number(btimeLine.slice(6).trim()) : NaN;
      if (Number.isFinite(ticks) && Number.isFinite(btime)) startedAt = (btime + ticks / 100) * 1000;
    } catch { /* command alone still identifies it */ }
    return { command, startedAt, cwd };
  }
  const r = spawnSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" });
  const command = r.status === 0 ? r.stdout.trim() : "";
  return command ? { command } : null;
}

/** The script operand of a `node [flags] <script>` command line, when it is a
 *  server.ts: the first whitespace-separated token ending in `server.ts`. */
export function serverEntryOf(command: string): string | null {
  // The script operand is the first argument after the executable that is
  // neither a flag nor a flag's value — not "any token ending in server.ts":
  // `python3 unrelated.py …/server.ts` named our entry as a trailing argument
  // and passed (Astra on 6d994569, #495).
  const argv = command.trim().split(/\s+/);
  const valued = new Set(["--import", "--require", "-r", "--loader", "--experimental-loader", "--conditions", "-C", "--env-file", "--eval", "-e", "--print", "-p", "--input-type", "--title", "--stack-size", "--max-old-space-size", "--openssl-config", "--icu-data-dir", "--inspect-port", "--report-directory"]);
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("-")) { if (valued.has(a) && !a.includes("=")) i++; continue; }
    return a.endsWith("server.ts") ? a : null; // the first operand IS the script; anything else is another program
  }
  return null;
}

/** Does the live command's executable match the recorded process.execPath?
 *  argv[0] is often a bare `node` or a symlink, so both sides are resolved
 *  through PATH and realpath; an executable that cannot be resolved is not
 *  evidence either way (Astra on 6d994569, #495). */
export function execMatches(command: string, recordedExec: string | undefined): boolean {
  if (!recordedExec) return true;
  const argv0 = command.trim().split(/\s+/)[0] ?? "";
  if (!argv0) return true;
  const resolveExec = (p: string): string | null => {
    try {
      if (p.includes("/")) return realpathSync(p);
      for (const dir of (process.env.PATH ?? "").split(":")) { if (!dir) continue; try { return realpathSync(join(dir, p)); } catch { /* next */ } }
      return null;
    } catch { return null; }
  };
  const a = resolveExec(argv0); const b = resolveExec(recordedExec);
  if (!a || !b) return true;
  return a === b;
}

/** LEGACY identity, for a daemon.json written before `entry` was recorded
 *  (#495 residual): the server.ts must sit under a `joy-daemon/` path segment
 *  — a checkout (packages/joy-daemon/src/server.ts) or an install
 *  (@fny/joy-daemon/src/server.ts). The old rule, "contains server.ts and
 *  tsx", accepted `node --import tsx /home/u/unrelated/server.ts`. */
export function looksLikeJoyDaemon(command: string): boolean {
  const entry = serverEntryOf(command);
  return !!entry && /(^|\/)joy-daemon\//.test(entry);
}

/** daemon.json wrote startedAt a moment after the process started (module
 *  load, then listen). Anything further apart than this is a different
 *  process that inherited the pid. */
const START_SKEW_MS = 120_000;

/** Is `pid` the daemon `state` (daemon.json) describes — not merely a live
 *  process that inherited its number? A pid in a file outlives the process
 *  that wrote it; `joy stop` used to SIGTERM whatever now held it (#495). */
export function verifyDaemonPid(
  pid: number,
  state: { startedAt?: number; entry?: string; exec?: string } | null,
  identity: ProcessIdentity | null,
): { ok: true } | { ok: false; reason: string } {
  if (!identity) return { ok: false, reason: `pid ${pid} is not running` };
  const shown = identity.command.slice(0, 80) || "unknown command";
  if (state?.entry) {
    // The daemon recorded the script it runs (process.argv[1], absolute): the
    // live command line must name EXACTLY that file (#495 residual) — a
    // same-looking joy-daemon from another install, or any other server.ts,
    // is not the process daemon.json describes. A relative operand (`tsx
    // src/server.ts` from the package dir) is resolved against the process's
    // cwd where the kernel reports it. `exec` is recorded for the log but not
    // enforced: process.execPath is the real binary while argv[0] is often a
    // bare `node` or a symlink, so it would only produce false "stale"s.
    const operand = serverEntryOf(identity.command);
    const entry = operand && !isAbsolute(operand) && identity.cwd ? resolve(identity.cwd, operand) : operand;
    if (entry !== state.entry) {
      return { ok: false, reason: `pid ${pid} is not the daemon daemon.json records (expected ${state.entry}; running: ${shown})` };
    }
    if (!execMatches(identity.command, state.exec)) {
      return { ok: false, reason: `pid ${pid} runs a different executable than daemon.json records (${shown})` };
    }
  } else if (!looksLikeJoyDaemon(identity.command)) {
    return { ok: false, reason: `pid ${pid} is not a joy-daemon (${shown})` };
  }
  if (identity.startedAt && state?.startedAt && Math.abs(identity.startedAt - state.startedAt) > START_SKEW_MS) {
    return { ok: false, reason: `pid ${pid} started at a different time than daemon.json records — a reused pid` };
  }
  return { ok: true };
}

/** The installed service that OWNS the daemon process `pid`, if any: the
 *  systemd user unit whose MainPID it is, or the launchd agent whose job
 *  runs it. A daemon `joy start` spawned detached has no supervisor even
 *  when a unit file exists on disk (inactive), and is signalled directly. */
export type Supervisor = { kind: "systemd"; unit: string } | { kind: "launchd"; label: string; plist: string };
export interface StopDeps {
  platform: string;
  run: (cmd: string, args: string[]) => { status: number | null; stdout: string };
  kill: (pid: number, signal: NodeJS.Signals) => void;
}
const defaultStopDeps: StopDeps = {
  platform: osPlatform(),
  run: (cmd, args) => { const r = spawnSync(cmd, args, { encoding: "utf8" }); return { status: r.status, stdout: r.stdout ?? "" }; },
  kill: (pid, signal) => process.kill(pid, signal),
};
export function detectSupervisor(pid: number, deps: Pick<StopDeps, "platform" | "run">): Supervisor | null {
  if (deps.platform === "linux") {
    const unit = `${serviceName()}.service`;
    // MainPID is "0" for an inactive unit and for a unit that is not installed.
    const r = deps.run("systemctl", ["--user", "show", "-p", "MainPID", "--value", unit]);
    return r.status === 0 && Number(r.stdout.trim()) === pid ? { kind: "systemd", unit } : null;
  }
  if (deps.platform === "darwin") {
    const label = launchdLabel();
    // `launchctl list <label>` prints the job's dictionary, `"PID" = <n>;` while it runs.
    const r = deps.run("launchctl", ["list", label]);
    const m = r.status === 0 ? /"PID"\s*=\s*(\d+)/.exec(r.stdout) : null;
    return m && Number(m[1]) === pid ? { kind: "launchd", label, plist: launchdPlistPath() } : null;
  }
  return null;
}

export async function cmdStop(deps: StopDeps = defaultStopDeps): Promise<number> {
  const s = await probe();
  const st = readState();
  // A daemon that answered the token-authenticated /status IS the daemon:
  // its own pid is authoritative. Without an answer the only evidence is
  // daemon.json, which outlives its writer — verify before signalling (#495).
  let pid: number | undefined = s?.pid;
  if (!pid) {
    if (!st?.pid) { console.log("daemon not running"); return 0; }
    const v = verifyDaemonPid(st.pid, st, processIdentity(st.pid));
    if (!v.ok) {
      try { rmSync(STATE_FILE); } catch { /* already gone */ }
      console.log(`${warn} stale daemon.json removed (${v.reason}) — nothing signalled`);
      return 0;
    }
    pid = st.pid;
  }
  // A supervised daemon is stopped THROUGH its supervisor. The unit is
  // Restart=always (the plist KeepAlive=true) by design, so a direct SIGTERM
  // "stopped" it for three seconds and then it was back — `joy stop` reported
  // success while the service restarted the daemon (#502). systemctl stop /
  // launchctl unload leave the service installed: it returns at the next
  // login/boot, and `joy install` re-arms it now.
  const sup = detectSupervisor(pid, deps);
  const via = sup ? (sup.kind === "systemd" ? `systemctl --user stop ${sup.unit}` : `launchctl unload ${sup.plist}`) : null;
  if (sup) {
    const r = sup.kind === "systemd" ? deps.run("systemctl", ["--user", "stop", sup.unit]) : deps.run("launchctl", ["unload", sup.plist]);
    if (r.status !== 0) {
      console.log(`${bad} ${via} failed (exit ${r.status ?? "?"}) — not signalling pid ${pid} directly, the service would restart it`);
      return 1;
    }
  } else {
    try { deps.kill(pid, "SIGTERM"); } catch { /* already gone */ }
  }
  for (let i = 0; i < 25; i++) {
    await new Promise(r => setTimeout(r, 200));
    if (!(await probe())) {
      try { rmSync(STATE_FILE); } catch {}
      console.log(`${ok} stopped (pid ${pid}${via ? `, via ${via}` : ""})`);
      if (sup) console.log(`  ${c.dim("the service stays installed: it returns at the next login/boot; `joy install` re-arms it now, `joy start` runs the daemon unsupervised")}`);
      return 0;
    }
  }
  console.log(`${warn} ${via ?? `sent SIGTERM to ${pid}`} but it's still answering`);
  return 1;
}

async function cmdRestart(): Promise<number> {
  if (await probe()) {
    const r = await api("POST", "/daemon/restart", {});
    if (r.ok) { console.log(`${ok} daemon re-exec requested (running sessions survive)`); return 0; }
    console.log(`${bad} restart failed: HTTP ${r.status}`);
    return 1;
  }
  console.log("daemon not running — starting it");
  return cmdStart();
}

async function cmdDoctor(): Promise<number> {
  console.log(c.b("\n🩺 joy-daemon doctor\n"));
  const line = (good: boolean, label: string, detail: string) =>
    console.log(`  ${good ? ok : bad} ${label.padEnd(10)} ${c.dim(detail)}`);

  line(true, "node", `${process.execPath} (${process.version})`);
  const tsxPath = which("tsx");
  line(!!tsxPath, "tsx", tsxPath ?? "not found — run `pnpm install`");

  const tmuxPath = which("tmux");
  const tmuxVer = tmuxPath ? spawnSync("tmux", ["-V"], { encoding: "utf8" }).stdout.trim() : "";
  line(!!tmuxPath, "tmux", tmuxPath ? `${tmuxPath} (${tmuxVer})` : "not found — required");

  const claudePath = which("claude");
  line(!!claudePath, "claude", claudePath ?? "not found on PATH");

  line(true, "relay", `${joyRelayUrl()}${isDefaultRelay() ? " (default)" : ""}`);
  const accessKey = join(CREDS_DIR, "access.key");
  line(existsSync(accessKey), "auth", existsSync(accessKey) ? accessKey : `no ${accessKey} — run \`joy auth\``);

  line(existsSync(SERVER_TS), "daemon src", SERVER_TS);

  const s = await probe();
  if (s) line(true, "daemon", `running (pid ${s.pid}, up ${s.uptimeMs != null ? fmtUptime(s.uptimeMs) : "?"})`);
  else line(false, "daemon", "not running — `joy start`");

  console.log("");
  return (tmuxPath && existsSync(accessKey)) ? 0 : 1;
}

function cmdAuth(): number {
  const accessKey = join(CREDS_DIR, "access.key");
  if (!existsSync(accessKey)) {
    console.log(`${bad} not authenticated (relay ${joyRelayUrl()})`);
    console.log(`  This relay needs its own pairing in ${c.dim(CREDS_DIR)}`);
    console.log(`  (access.key + settings.json) — run ${c.b("joy auth <relay>")} with your backup code.`);
    return 1;
  }
  let machineId = "?", server = "?";
  try {
    const s = JSON.parse(readFileSync(join(CREDS_DIR, "settings.json"), "utf8")) as any;
    machineId = s.machineId ?? "?";
    server = s.serverUrl ?? "(default)";
  } catch { /* settings optional */ }
  console.log(`${ok} authenticated`);
  console.log(`  credentials ${accessKey}`);
  console.log(`  machineId   ${machineId}`);
  console.log(`  relay       ${joyRelayUrl()}${isDefaultRelay() ? " (default)" : ""}`);
  console.log(`  server      ${server}`);
  return 0;
}

// `joy auth <relay...>` — pair this machine with relays using the account's
// backup code (Settings → Account → Backup in the app). Both sides of the QR
// flow run locally, so no browser approval; the relay auto-creates the account
// on first contact, which is what lets ONE code cover every relay. The secret
// is parsed, used, and dropped — never written to disk.
async function cmdAuthPair(relayArgs: string[]): Promise<number> {
  const targets: { name: string; url: string }[] = [];
  for (const arg of relayArgs) {
    const url = resolveRelayAlias(arg);
    if (!/^https?:\/\//.test(url)) { console.log(`${bad} unknown relay: ${arg}`); return 2; }
    targets.push({ name: arg, url });
  }

  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const entered = await rl.question("Backup code (XXXXX-XXXXX-…): ");
  rl.close();
  let secret: Uint8Array;
  try {
    secret = parseBackupCode(entered);
  } catch (e) {
    console.log(`${bad} ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }

  let failures = 0;
  for (const t of targets) {
    try {
      const machineId = await pairWithRelay(t.url, secret, joyRelayCredsDir(t.url));
      console.log(`${ok} paired with ${t.name} (${t.url}) — machineId ${machineId}`);
    } catch (e) {
      failures++;
      console.log(`${bad} ${t.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  // Perimeter key derived from the same secret (written per relay as
  // perimeter.key): the value a GATED relay must carry in ~/joy-relay.env.
  const perimeter = deriveRelayPerimeterKey(secret);
  secret.fill(0);
  if (failures === 0) {
    console.log(c.dim(`relay perimeter key (JOY_RELAY_ACCESS_KEY on a gated relay box): ${perimeter}`));
    console.log(c.dim(`start a daemon per relay: joy --relay <name> install`));
  }
  return failures === 0 ? 0 : 1;
}

async function cmdNotify(args: string[]): Promise<number> {
  let title = "", message = "";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-t" || args[i] === "--title") title = args[++i] ?? "";
    else if (args[i] === "-p" || args[i] === "--message") message = args[++i] ?? "";
    else if (!message) message = args[i];
  }
  if (!message) { console.log(`${bad} message required: joy notify -p "your message" [-t title]`); return 1; }
  if (!(await probe())) { console.log(`${bad} daemon not running (joy start) — notify goes through the daemon's authed relay`); return 1; }
  const r = await api("POST", "/notify", { title: title || "Joy", body: message });
  const res = (await r.json().catch(() => ({}))) as any;
  if (r.ok && res.ok) { console.log(`${ok} push sent to ${res.sent ?? "?"} device(s)`); return 0; }
  console.log(`${bad} notify failed: ${res.error ?? `HTTP ${r.status}`}`);
  return 1;
}

// ── install (systemd on Linux, launchd on macOS) ────────────────────────────

// One service PER RELAY: the default keeps the historical names, a non-default
// relay's unit gets the relay key appended — so per-relay daemons install,
// start, and uninstall independently.
// ONE unit per machine, whatever relay it serves. The relay is carried by the
// unit's JOY_RELAY_URL, not by its name: a per-relay name invited a second
// daemon to sit alongside the first, which is exactly the confusion this
// removes (two daemons, two accounts, one very long debugging session).
function serviceName(): string { return "joy-daemon"; }
function systemdUnitPath(): string { return join(homedir(), ".config", "systemd", "user", `${serviceName()}.service`); }
const LAUNCHD_LABEL = "vip.faraz.joy-daemon";
function launchdLabel(): string { return LAUNCHD_LABEL; } // one agent per machine, as with systemd
function launchdPlistPath(): string { return join(homedir(), "Library", "LaunchAgents", `${launchdLabel()}.plist`); }
// Historical service names (joy-tmux until 2026-08-13, joy-server for a few
// hours after; per-relay units shipped with a -<relayKey> suffix under both).
// removeService() tears these down too, so a re-install MIGRATES the old unit
// away instead of leaving two daemons supervising the same tmux server.
const LEGACY_SERVICE_BASES = ["joy-tmux", "joy-server", "joy-daemon"];
const LEGACY_LAUNCHD_LABELS = ["vip.voltai.joy-tmux", "party.voltai.joy-tmux", "vip.voltai.joy-server", "vip.voltai.joy-daemon"];

// Every systemd unit name that may exist on this machine: the current name,
// plus each legacy base BOTH bare and with the per-relay suffix the old naming
// used. The suffixed form matters on upgrade — "joy-daemon-<relayKey>.service"
// is what this daemon shipped as until 2026-08-31, and leaving it enabled
// beside the new unit means two daemons supervising one tmux server.
function systemdUnitNamesForCleanup(): string[] {
  const key = joyRelayKey();
  const legacy = LEGACY_SERVICE_BASES.flatMap((b) => [b, `${b}-${key}`]);
  return [...new Set([serviceName(), ...legacy])];
}

function launchdLabelsForCleanup(): string[] {
  const key = joyRelayKey();
  const legacy = [...LEGACY_LAUNCHD_LABELS, LAUNCHD_LABEL].flatMap((l) => [l, `${l}.${key}`]);
  return [...new Set([launchdLabel(), ...legacy])];
}

// Tear down whatever service is currently installed — current OR legacy name —
// quietly. Shared by uninstall (which then reports) and install (which calls it
// first, so install is idempotent: a changed unit actually takes effect, a
// renamed service migrates, and a stale or hand-rolled unit/plist never
// lingers next to the new one).
function removeService(): void {
  const plat = osPlatform();
  if (plat === "linux") {
    for (const name of systemdUnitNamesForCleanup()) {
      spawnSync("systemctl", ["--user", "disable", "--now", `${name}.service`], { stdio: "ignore" });
      try { rmSync(join(homedir(), ".config", "systemd", "user", `${name}.service`)); } catch {}
    }
    spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
  } else if (plat === "darwin") {
    for (const label of launchdLabelsForCleanup()) {
      const path = join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
      spawnSync("launchctl", ["unload", path], { stdio: "ignore" });
      try { rmSync(path); } catch {}
    }
  }
}

/** The systemd user unit `joy install` writes on Linux — pure so its
 *  environment is testable. The relay AND the Joy home are baked in
 *  explicitly: the unit must say which relay it serves and which ~/.joy it
 *  reads, rather than inheriting defaults that may move under it. Installing
 *  with JOY_HOME_DIR=/isolated/joy used to produce a service that started
 *  against ~/.joy — missing the credentials and state the installing CLI was
 *  using (#499). Values are quoted: systemd splits Environment= on
 *  whitespace. */
export interface SystemdUnitValues { node: string; serverTs: string; pkgDir: string; path: string; relayUrl: string; homeDir: string }
export function systemdUnit(v: SystemdUnitValues): string {
  const q = (s: string) => `"${s.replace(/(["\\])/g, "\\$1")}"`;
  return `[Unit]
Description=joy-daemon daemon (relay ${v.relayUrl})
After=network-online.target

[Service]
Type=simple
ExecStart=${v.node} --import tsx ${v.serverTs}
WorkingDirectory=${v.pkgDir}
Environment=${q(`PATH=${v.path}`)}
Environment=${q(`JOY_RELAY_URL=${v.relayUrl}`)}
Environment=${q(`JOY_HOME_DIR=${v.homeDir}`)}

# Restart=always, NOT on-failure: the daemon self-restarts (joy-restart-daemon
# RPC + the update flow) by exiting 0 after spawning a detached replacement.
# Under systemd the default KillMode=control-group reaps that replacement when
# the main process exits, so on-failure would leave the service permanently
# DEAD after any clean self-restart. always makes systemd the supervisor: it
# revives the status-0 exit, the singleton port-lock arbitrates any overlap.
# (macOS launchd already covers this via KeepAlive=true.)
Restart=always
RestartSec=3
# KillMode=process, NOT the default control-group: the tmux server and every
# claude/codex CLI live in this service's cgroup, and a control-group stop
# SIGKILLs them all — a plain restart would nuke every live session with
# nothing left to rebind. process kills only the daemon; recover() rebinds.
KillMode=process

[Install]
WantedBy=default.target
`;
}

function cmdInstall(): number {
  const plat = osPlatform();
  if (!existsSync(SERVER_TS)) {
    // A unit pointing at a missing server.ts crash-loops forever (#503).
    console.log(`${bad} daemon source not found at ${SERVER_TS} — not installing a service that cannot start`);
    return 1;
  }
  removeService(); // idempotent: start from a clean slate so the new config takes effect
  if (plat === "linux") {
    const unit = systemdUnit({ node: NODE, serverTs: SERVER_TS, pkgDir: PKG_DIR, path: process.env.PATH ?? "", relayUrl: joyRelayUrl(), homeDir: joyHomeDir() });
    const path = systemdUnitPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, unit);
    spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "inherit" });
    const r = spawnSync("systemctl", ["--user", "enable", "--now", `${serviceName()}.service`], { stdio: "inherit" });
    if (r.status !== 0) { console.log(`${bad} systemctl enable failed (is lingering enabled? \`loginctl enable-linger $USER\`)`); return 1; }
    console.log(`${ok} installed systemd user service → ${path}`);
    console.log(`  ${c.dim(`logs: journalctl --user -u ${serviceName()} -f`)}`);
    return 0;
  }
  if (plat === "darwin") {
    // Built by a pure, XML-escaping function: a `&` in PATH used to produce a
    // plist launchctl could not parse (#500).
    const plist = launchdPlist({
      label: launchdLabel(),
      node: NODE,
      serverTs: SERVER_TS,
      pkgDir: PKG_DIR,
      path: process.env.PATH ?? "",
      relayUrl: joyRelayUrl(),
      homeDir: joyHomeDir(),
      logFile: LOG_FILE,
    });
    const path = launchdPlistPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, plist);
    const r = spawnSync("launchctl", ["load", "-w", path], { stdio: "inherit" });
    if (r.status !== 0) { console.log(`${bad} launchctl load failed`); return 1; }
    console.log(`${ok} installed launchd agent → ${path}`);
    return 0;
  }
  console.log(`${bad} install not supported on ${plat} (linux/macOS only)`);
  return 1;
}

// Update the global package to the current `release` branch of the repo, then
// reinstall the service so the daemon restarts onto the new code — migrating a
// stale baked path along the way. Deploys are `git push origin main:release`
// (no npm publish); the box needs read access to the repo (ssh key or a stored
// https credential). For pnpm-global installs; a source checkout updates via
// git pull + `joy restart` instead.
const RELEASE_SPEC = "git+https://github.com/fny/joy.git#release&path:packages/joy-daemon";
function cmdUpdate(): number {
  console.log("updating @fny/joy-daemon from release branch…");
  const r = spawnSync("pnpm", ["add", "-g", RELEASE_SPEC], { stdio: "inherit" });
  if (r.status !== 0) { console.log(`${bad} pnpm add -g failed (is pnpm on PATH? repo access?)`); return 1; }
  return cmdInstall();
}

function cmdUninstall(): number {
  const plat = osPlatform();
  if (plat !== "linux" && plat !== "darwin") {
    console.log(`${bad} uninstall not supported on ${plat}`);
    return 1;
  }
  removeService();
  console.log(`${ok} uninstalled ${serviceName()} service`);
  return 0;
}

function expandTilde(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

// Attach (or, when already inside tmux, switch) to a session's tmux window.
//   joy jump            → the session in the current dir (or its nearest ancestor)
//   joy jump <id|pfx>   → by joy session id or a unique prefix of it
//   joy jump <path>     → by the session's cwd, or a full/partial folder name
// Ambiguous matches (e.g. a partial name hitting several dirs) error with the list.
async function cmdJump(rest: string[]): Promise<number> {
  const r = await api("GET", "/sessions").catch(() => null);
  if (!r || !r.ok) { console.log(`${bad} daemon not running (joy start)`); return 1; }
  const sessions = ((await r.json()) as any[]).filter((s) => s.tmux_window);
  if (sessions.length === 0) { console.log("no sessions with a tmux window"); return 1; }

  const arg = rest[0];
  let matches: any[];
  let how: string;
  if (!arg) {
    const here = resolve(process.cwd());
    how = `cwd ${here}`;
    matches = sessions.filter((s) => resolve(s.cwd) === here);
    if (matches.length === 0) {
      // nearest ancestor: the deepest session cwd that contains `here`
      matches = sessions
        .filter((s) => { const cwd = resolve(s.cwd); return here === cwd || here.startsWith(cwd + sep); })
        .sort((a, b) => resolve(b.cwd).length - resolve(a.cwd).length)
        .slice(0, 1);
    }
  } else {
    how = `"${arg}"`;
    const asPath = resolve(expandTilde(arg));
    matches = sessions.filter((s) => s.id === arg);                                      // exact id
    if (!matches.length) matches = sessions.filter((s) => resolve(s.cwd) === asPath);    // exact cwd path
    if (!matches.length) matches = sessions.filter((s) => String(s.id).startsWith(arg)); // id prefix
    if (!matches.length) matches = sessions.filter((s) => basename(resolve(s.cwd)) === arg); // exact folder name
    if (!matches.length) {                                                                   // partial folder name (case-insensitive)
      const q = arg.toLowerCase();
      matches = sessions.filter((s) => basename(resolve(s.cwd)).toLowerCase().includes(q));
    }
  }

  if (matches.length === 0) { console.log(`${bad} no session matching ${how}`); return 1; }
  if (matches.length > 1) {
    console.log(`${bad} ${matches.length} sessions match ${how} — be more specific:`);
    for (const s of matches) console.log(`    ${c.b(s.id)}  ${s.cwd}`);
    return 1;
  }

  // "joy-9214e0a2:agent" (own server), "j-9214e0a2" (older own-server
  // scheme, session == target) or "joy:j-9214e0a2" (legacy shared server).
  const win = String(matches[0].tmux_window);
  const perSessionSocket = matches[0].tmux_socket as string | null | undefined;
  const tmuxSession = win.split(":")[0];
  // Per-session servers (docs/per-session-tmux-design.md): the session lives
  // on its OWN -L socket; otherwise the per-relay (or default) server.
  const [tmuxBin, ...relaySock] = tmuxArgv();
  const sock = perSessionSocket ? ["-L", perSessionSocket] : relaySock;
  // select-window both validates the window still exists and makes it active.
  const sel = spawnSync(tmuxBin, [...sock, "select-window", "-t", win], { stdio: "ignore" });
  if (sel.status !== 0) { console.log(`${bad} tmux window ${win} not found (session ended?)`); return 1; }
  // switch-client only works within ONE tmux server: from inside the default
  // server you can't switch to a namespaced relay's server (and attaching
  // nested fails on $TMUX) — detach first.
  if (process.env.TMUX && sock.length > 0) {
    console.log(`${bad} you're inside another tmux server — detach (C-b d), then: joy --relay ${joyRelayKey()} jump`);
    return 1;
  }
  const sub = process.env.TMUX
    ? spawnSync(tmuxBin, [...sock, "switch-client", "-t", win], { stdio: "inherit" })      // already in tmux
    : spawnSync(tmuxBin, [...sock, "attach-session", "-t", tmuxSession], { stdio: "inherit" });
  return sub.status === 0 ? 0 : 1;
}

// ── session scripting (new/ask/send/wait/log/kill) ──────────────────────────
// The programmatic surface: lets other programs and agents drive joy-daemon
// sessions. Contract (deliberate, do not soften):
//   - sends are EXCLUSIVE: a mid-turn session is a BUSY error (exit 3), never
//     an implicit queue — a script must not line up behind work it can't see.
//   - only bypassPermissions (yolo) or plan (read-only) sessions are
//     scriptable (exit 5 otherwise): any other mode can park on a permission
//     dialog mid-turn, and a blocked `ask` would hang until timeout.
// Exit codes: 0 ok · 1 error · 2 usage · 3 busy · 4 timeout · 5 bad mode.

/** Sleep `ms`, or until `signal` aborts — a wait must never outlive the
 *  loop that owns it. */
const wait = (ms: number, signal?: AbortSignal) => new Promise<void>((r) => {
  if (signal?.aborted) return r();
  const done = () => { clearTimeout(t); r(); };
  const t = setTimeout(() => { signal?.removeEventListener("abort", done); r(); }, ms);
  signal?.addEventListener("abort", done, { once: true });
});

/**
 * Delete a session's transcript log ROBUSTLY. Killing the session tears down
 * claude, and a dying claude flushes a final transcript write — which can
 * re-create the file AFTER a single rmSync, leaving a leak. So delete on a
 * loop and only return once the file has stayed absent across consecutive
 * checks (claude has finished exiting and can't flush again). Bounded so it
 * never hangs if something else keeps re-creating the path.
 */
async function purgeTranscript(tp: string): Promise<void> {
  let goneStreak = 0;
  for (let i = 0; i < 24; i++) { // ~6s ceiling
    if (existsSync(tp)) { try { rmSync(tp); } catch { /* best-effort */ } goneStreak = 0; }
    else if (++goneStreak >= 3) return; // absent 3 checks running → claude done flushing
    await wait(250);
  }
}

/** Resolve a session by exact id, exact claude id, or a unique prefix of either. */
async function resolveSession(idOrPrefix: string): Promise<any | null> {
  const r = await api("GET", "/sessions").catch(() => null);
  if (!r || !r.ok) { console.error(`${bad} daemon not running (joy start)`); return null; }
  const sessions = (await r.json()) as any[];
  let m = sessions.filter((s) => s.id === idOrPrefix || s.claude_session_id === idOrPrefix);
  if (!m.length) m = sessions.filter((s) => String(s.id).startsWith(idOrPrefix) || String(s.claude_session_id ?? "").startsWith(idOrPrefix));
  if (m.length === 1) return m[0];
  if (m.length === 0) console.error(`${bad} no session matching "${idOrPrefix}"`);
  else { console.error(`${bad} ${m.length} sessions match "${idOrPrefix}":`); for (const s of m) console.error(`    ${s.id}  ${s.cwd}`); }
  return null;
}




/** Shared flag parsing: pulls `--flag value` / boolean flags out of argv. */
function takeFlag(rest: string[], name: string): string | undefined {
  const i = rest.indexOf(name);
  if (i < 0) return undefined;
  const v = rest[i + 1];
  rest.splice(i, v !== undefined && !v.startsWith("--") ? 2 : 1);
  return v !== undefined && !v.startsWith("--") ? v : "";
}
function takeBool(rest: string[], name: string): boolean {
  const i = rest.indexOf(name);
  if (i < 0) return false;
  rest.splice(i, 1);
  return true;
}

// joy new <dir> [-m "first message"] [--model m] [--effort e] [--read-only]
//               [--continue | --resume <id>] [--json]
// Creates the directory if missing (scripts are non-interactive). Prints the
// session id (or the full record with --json). A -m message is queued and
// drains once claude is ready — follow with `joy wait` to block on it.
// ── events / turn-wait plumbing (joy events, wait, ask, run, check) ─────────

/** Who is talking: a joy session (JOY_SESSION_ID is exported into every
 *  agent pane / process by the daemon) or a human at a shell. The daemon
 *  writes the <joy-message> wrapper from this — the CLI never does. */
function senderIdentity(): string {
  const sid = process.env.JOY_SESSION_ID;
  return sid && /^[0-9a-f]{8}$/.test(sid) ? `joy:${sid}` : "cli";
}

type LoggedRecord = { seq: number; at: number; localId?: string; record: { role: string; content: any; meta?: any } };

/** Stream a session's NDJSON record log. Yields the hello line first
 *  ({ hello, seq }), then records; ends at EOF (no follow) or on abort. */
async function* streamEvents(id: string, opts: { after?: number; last?: number; follow?: boolean; signal?: AbortSignal }): AsyncGenerator<any> {
  const q = new URLSearchParams();
  if (opts.after !== undefined) q.set("after", String(opts.after));
  if (opts.last !== undefined) q.set("last", String(opts.last));
  if (opts.follow) q.set("follow", "1");
  const res = await fetch(`${base()}/sessions/${id}/events?${q}`, { headers: authHeaders(), signal: opts.signal });
  if (!res.ok || !res.body) throw new Error(`events ${res.status}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try { yield JSON.parse(line); } catch { /* partial */ }
    }
  }
}

const evOf = (r: LoggedRecord): any => r.record?.content?.data?.ev ?? null;
const textOf = (r: LoggedRecord): string | null => {
  if (r.record?.role === "user") { const t = r.record.content?.text; return typeof t === "string" ? t : null; }
  const ev = evOf(r); return ev?.t === "text" && typeof ev.text === "string" ? ev.text : null;
};

/** One human-readable line per record (the old `log` look, every agent). */
function renderRecord(r: LoggedRecord): string | null {
  const when = c.dim(new Date(r.at).toISOString().slice(11, 19));
  if (r.record.role === "user") {
    const from = r.record.meta?.from ? c.dim(` (from ${r.record.meta.from})`) : "";
    const t = String(r.record.content?.text ?? "").replace(/^<joy-message\b[^>]*>\s*/, "").replace(/\s*<\/joy-message>\s*$/, "");
    return `${when} ${c.b("user     ")}${from} ${t.replace(/\s+/g, " ").slice(0, 200)}`;
  }
  const ev = evOf(r);
  if (!ev) return null;
  switch (ev.t) {
    case "text": return `${when} ${c.g("assistant")} ${String(ev.text).replace(/\s+/g, " ").slice(0, 200)}`;
    case "tool-call-start": return `${when} ${c.dim("tool     ")} ${ev.name}${ev.args && Object.keys(ev.args).length ? " " + JSON.stringify(ev.args).slice(0, 120) : ""}`;
    case "tool-call-end": return `${when} ${c.dim("tool-end ")} ${ev.call}`;
    case "turn-start": return `${when} ${c.dim("turn     ")} start`;
    case "turn-end": return `${when} ${c.dim("turn     ")} end ${ev.status ?? ""}${ev.usage ? " " + JSON.stringify(ev.usage).slice(0, 100) : ""}`;
    case "service": return `${when} ${c.dim("service  ")} ${String(ev.text).slice(0, 200)}`;
    default: return null;
  }
}

const CHECK_STATES = new Set(["idle", "busy", "needs_input", "ended"]);
/** The session's /check verdict. null = the daemon did not answer at all
 *  (down, or `signal` fired). A missing session (404 session_not_found)
 *  reads as `ended`; any other failure, or a state the daemon never
 *  advertises, is `{ state: "error", reason }`. Both used to flow through as
 *  `state: undefined`, which waitTurn read as idle and reported answered —
 *  a successful exit for a session that no longer existed (#496). */
async function checkState(id: string, opts: { signal?: AbortSignal } = {}): Promise<any | null> {
  const r = await api("GET", `/sessions/${id}/check`, undefined, opts).catch(() => null);
  if (!r) return null;
  const body = await r.json().catch(() => null) as any;
  if (r.status === 404 || body?.error === "session_not_found") return { state: "ended", reason: "session_not_found" };
  if (!r.ok || !body) return { state: "error", reason: body?.error ?? `HTTP ${r.status}` };
  if (!CHECK_STATES.has(body.state)) return { state: "error", reason: `unexpected check state ${JSON.stringify(body.state)}` };
  return body;
}

/** The daemon-stamped <joy-message …> wrapper off a mirrored user row. */
const stripJoyMessage = (s: string): string => s.replace(/^\s*<joy-message\b[^>]*>\s*/, "").replace(/\s*<\/joy-message>\s*$/, "").trim();

/** Record seq the session's log is at right now (0 when it has none). */
async function currentSeq(id: string): Promise<number> {
  const r = await api("GET", `/sessions/${id}/events?last=0`).catch(() => null);
  if (!r || !r.ok) return 0;
  const first = (await r.text()).split("\n")[0];
  try { return Number(JSON.parse(first).seq) || 0; } catch { return 0; }
}

/** `error` (exit 1): the turn could not be observed to its end — /check
 *  failed, or the reply's records were lost with the event stream — and
 *  `reason` says which. Never reported as `answered`. */
type TurnOutcome = { state: "answered" | "needs_input" | "timeout" | "gone" | "error"; text: string; check: any; records: LoggedRecord[]; reason?: string };
const OUTCOME_EXIT: Record<TurnOutcome["state"], number> = { answered: 0, needs_input: 6, timeout: 4, gone: 1, error: 1 };

/**
 * Block until the turn behind `queuedId` (or, without one, whatever is
 * running) has ended, collecting the records produced meanwhile. Ends when
 * the queue no longer holds the item AND the session reports idle /
 * needs_input — polled, so it holds for every adapter regardless of how it
 * signals turn-end. The assistant text of the turn is the joined text
 * records of THAT turn:
 *   - an exclusive send / a bare `wait`: everything after `afterSeq`;
 *   - a queued item runs behind whatever is in flight, so the rest of the
 *     PREVIOUS answer lands after `afterSeq` too and used to be returned as
 *     this turn's reply (#498). The boundary is the daemon-mirrored user
 *     record carrying `text` (every adapter mirrors the dispatched prompt);
 *     the seq seen when the queue poll noticed the dispatch is the fallback.
 * Every request in here is bounded by the remaining deadline: a daemon that
 * accepts /check and never answers used to hold the wait forever, timeout or
 * not (#501). The record stream resumes from the last consumed seq when it
 * breaks; a tail that cannot be recovered is an `error`, not a short answer
 * (#497).
 */
export async function waitTurn(id: string, opts: { afterSeq: number; queuedId?: string | null; text?: string; timeoutMs: number }): Promise<TurnOutcome> {
  const deadline = Date.now() + opts.timeoutMs;
  const remaining = () => Math.max(1, deadline - Date.now());
  const timedOut = () => Date.now() > deadline;
  const controller = new AbortController();
  const records: LoggedRecord[] = [];
  let boundarySeq: number | null = opts.queuedId ? null : opts.afterSeq;
  let fallbackBoundary: number | null = null;
  let lastSeq = opts.afterSeq;
  let sawActivity = false;
  let connected = false;
  let lastStreamError: string | null = null;
  const sentText = opts.text?.trim() ?? "";
  const consume = (line: any): void => {
    if (typeof line?.seq !== "number") return;
    lastSeq = line.seq;
    records.push(line);
    if (boundarySeq === null && sentText && line.record?.role === "user" && stripJoyMessage(String(line.record.content?.text ?? "")) === sentText) boundarySeq = line.seq;
    const ev = evOf(line);
    const from = boundarySeq ?? fallbackBoundary;
    if (from !== null && line.seq > from && ev && (ev.t === "turn-start" || ev.t === "text" || ev.t === "tool-call-start")) sawActivity = true;
  };
  const pump = (async () => {
    let backoff = 200;
    while (!controller.signal.aborted) {
      try {
        for await (const line of streamEvents(id, { after: lastSeq, follow: true, signal: controller.signal })) {
          if (line?.hello) { connected = true; continue; }
          consume(line);
        }
        lastStreamError = "stream closed"; // a follow stream never ends on its own
      } catch (e) {
        if (controller.signal.aborted) return;
        lastStreamError = e instanceof Error ? e.message : String(e);
      }
      connected = false;
      // Resume from the last consumed seq: nothing in between is lost (#497).
      await wait(backoff, controller.signal);
      backoff = Math.min(backoff * 2, 2000);
    }
  })();
  const finish = async (state: TurnOutcome["state"], check: any, reason?: string): Promise<TurnOutcome> => {
    if (state !== "timeout") await wait(150); // let a trailing text record land before we stop reading
    controller.abort();
    await pump.catch(() => {});
    if (!connected) {
      // The stream was down when the turn ended: whatever landed after the
      // last consumed record is not here. Fetch that tail once, bounded; if
      // even that fails the reply is INCOMPLETE and the outcome says so
      // rather than passing a truncated answer off as the answer (#497).
      try {
        for await (const line of streamEvents(id, { after: lastSeq, follow: false, signal: AbortSignal.timeout(3000) })) { if (!line?.hello) consume(line); }
      } catch (e) {
        if (state === "answered" || state === "needs_input") {
          state = "error";
          reason = `output stream lost after seq ${lastSeq} (${lastStreamError ?? (e instanceof Error ? e.message : String(e))}) — the reply is incomplete; \`joy events ${id} --json\` has the records`;
        }
      }
    }
    const from = boundarySeq ?? fallbackBoundary ?? opts.afterSeq;
    const mine = records.filter((r) => r.seq > from);
    const text = mine.map((r) => (r.record.role !== "user" ? textOf(r) : null)).filter((t): t is string => !!t && t.trim().length > 0).join("\n\n").trim();
    return { state, text, check, records: mine, ...(reason ? { reason } : {}) };
  };
  let startedAt = Date.now();
  let dispatched = !opts.queuedId;
  let lastCheck: any = null;
  for (;;) {
    if (timedOut()) return finish("timeout", lastCheck);
    if (!dispatched) {
      const q = await api("GET", `/sessions/${id}/queue`, undefined, { signal: AbortSignal.timeout(remaining()) }).catch(() => null);
      if (timedOut()) return finish("timeout", lastCheck);
      const qs = q && q.ok ? await q.json().catch(() => null) as any : null;
      const items: any[] = qs?.items ?? qs?.queue ?? [];
      dispatched = !items.some((it) => String(it.id) === String(opts.queuedId));
      if (!dispatched) { await wait(400); continue; }
      fallbackBoundary = lastSeq;
      startedAt = Date.now();
    }
    const ck = await checkState(id, { signal: AbortSignal.timeout(remaining()) });
    if (timedOut()) return finish("timeout", lastCheck);
    if (!ck) return finish("gone", null, "daemon not answering");
    lastCheck = ck;
    if (ck.state === "error") return finish("error", ck, `check failed: ${ck.reason}`);
    if (ck.state === "ended") return finish("gone", ck, ck.reason);
    if (ck.state === "needs_input") return finish("needs_input", ck);
    if (ck.state === "busy") { sawActivity = true; await wait(400); continue; }
    // idle — but a harness that flips busy asynchronously may not have started
    // yet: give it a short grace unless we already saw the turn happen.
    if (sawActivity || Date.now() - startedAt > 3000) return finish("answered", ck);
    await wait(300);
  }
}

/** A send that always leaves an audit trail: the queued id back from the
 *  daemon, or a typed failure (exit code). */
async function sendTo(rec: any, text: string, opts: { exclusive?: boolean; from?: string; replyTo?: string | null }): Promise<{ ok: true; queuedId: string | null; seq: number } | { ok: false; code: number }> {
  const seq = await currentSeq(rec.id);
  // replyTo travels as-is: `null` is the explicit "no reply expected" the
  // daemon honours (#112); `?? undefined` used to erase it from the body.
  const r = await api("POST", "/send", { session_id: rec.id, text, exclusive: opts.exclusive === true, from: opts.from, replyTo: opts.replyTo }).catch(() => null);
  if (!r) { console.error(`${bad} daemon not running`); return { ok: false, code: 1 }; }
  const body = await r.json().catch(() => ({})) as any;
  if (body.error === "busy") { console.error(`${bad} session ${rec.id} is busy (--no-queue)`); return { ok: false, code: 3 }; }
  if (body.error === "mode_not_scriptable") { console.error(`${bad} mode "${body.mode}" not scriptable with --no-queue (need yolo or read-only)`); return { ok: false, code: 5 }; }
  if (body.error === "bad_from") { console.error(`${bad} unknown sender ${body.from} (JOY_SESSION_ID must name a session on this daemon)`); return { ok: false, code: 2 }; }
  if (!r.ok || body.error) { console.error(`${bad} send failed: ${JSON.stringify(body)}`); return { ok: false, code: 1 }; }
  return { ok: true, queuedId: body.queued_id ?? null, seq };
}

// joy check <session> — one line; the exit code IS the answer.
async function cmdCheck(rest: string[]): Promise<number> {
  const json = takeBool(rest, "--json");
  const target = rest[0];
  if (!target) { console.error("usage: joy check <session> [--json]"); return 2; }
  const rec = await resolveSession(target);
  if (!rec) return 1;
  const ck = await checkState(rec.id);
  if (!ck) { console.error(`${bad} daemon not running`); return 1; }
  if (json) { console.log(JSON.stringify({ session: rec.id, ...ck })); }
  else if (ck.state === "idle") console.log(`${ok} ${rec.id} idle${ck.queue ? ` (${ck.queue} queued)` : ""}`);
  else if (ck.state === "busy") console.log(`${c.y("●")} ${rec.id} busy${ck.busySince ? ` for ${fmtUptime(Date.now() - ck.busySince)}` : ""}${ck.queue ? `, ${ck.queue} queued` : ""}`);
  else if (ck.state === "needs_input") {
    const what = ck.approvals?.length ? `approval: ${ck.approvals[0].title}` : `question: ${String(ck.question ?? "").replace(/\s+/g, " ").slice(0, 120)}${ck.options?.length ? ` [${ck.options.join(" | ")}]` : ""}`;
    console.log(`${c.y("?")} ${rec.id} needs input — ${what}`);
  } else console.log(`${bad} ${rec.id} ${ck.state}${ck.reason ? ` (${ck.reason})` : ""}`);
  return ck.state === "idle" ? 0 : ck.state === "busy" ? 3 : ck.state === "needs_input" ? 6 : 1;
}

// joy about <session> — everything about one session.
async function cmdAbout(rest: string[]): Promise<number> {
  const json = takeBool(rest, "--json");
  const target = rest[0];
  if (!target) { console.error("usage: joy about <session> [--json]"); return 2; }
  const rec = await resolveSession(target);
  if (!rec) return 1;
  const [ck, qr, ar, ur, evText] = await Promise.all([
    checkState(rec.id),
    api("GET", `/sessions/${rec.id}/queue`).then((r) => r.json()).catch(() => null),
    api("GET", `/sessions/${rec.id}/approvals`).then((r) => r.json()).catch(() => null),
    rec.claude_session_id ? api("GET", `/usage/sessions?period=all&claudeSessionId=${encodeURIComponent(rec.claude_session_id)}`).then((r) => r.json()).catch(() => null) : Promise.resolve(null),
    api("GET", `/sessions/${rec.id}/events`).then((r) => r.text()).catch(() => ""),
  ]);
  const usage = (ur as any)?.entry ?? null;
  const turns = String(evText).split("\n").filter((l) => l.includes('"turn-end"')).length;
  const q = qr as any;
  const info = {
    id: rec.id, agent: rec.agent ?? "claude", title: rec.summary?.text ?? (typeof rec.summary === "string" ? rec.summary : null),
    status: rec.status, state: ck?.state ?? null, permissionMode: ck?.permissionMode ?? null,
    model: rec.current_model ?? rec.model ?? null, effort: rec.effort ?? null,
    cwd: rec.cwd, pid: rec.pid ?? null, tmux: { target: rec.tmux_window ?? null, socket: rec.tmux_socket ?? null },
    relaySessionId: rec.relay_session_id ?? null, claudeSessionId: rec.claude_session_id ?? null,
    startedAt: rec.started_at ?? null, uptimeMs: rec.started_at ? Date.now() - rec.started_at : null,
    lastActiveAt: rec.last_active_at ?? null, turns, queue: q?.pendingCount ?? (q?.items?.length ?? 0),
    approvals: (ar as any)?.approvals ?? [], usage,
  };
  if (json) { console.log(JSON.stringify(info)); return 0; }
  const row = (k: string, v: unknown) => { if (v !== null && v !== undefined && v !== "") console.log(`  ${k.padEnd(12)} ${v}`); };
  console.log(`${c.b(info.id)}  ${info.agent}${info.title ? `  ${c.dim(String(info.title))}` : ""}`);
  row("state", `${info.status}${info.state ? ` / ${info.state}` : ""}`);
  row("mode", info.permissionMode);
  row("model", `${info.model ?? "?"}${info.effort ? ` (${info.effort})` : ""}`);
  row("cwd", info.cwd);
  row("pid", info.pid);
  row("tmux", info.tmux.socket ? `tmux -L ${info.tmux.socket} attach   (${info.tmux.target})` : info.tmux.target);
  row("uptime", info.uptimeMs != null ? fmtUptime(info.uptimeMs) : null);
  row("last active", info.lastActiveAt ? fmtUptime(Date.now() - info.lastActiveAt) + " ago" : null);
  row("turns", info.turns);
  row("queue", info.queue);
  if (info.approvals.length) row("approvals", info.approvals.map((a: any) => `${a.requestId}: ${a.title}`).join("; "));
  if (usage) row("cost", `$${Number(usage.cost ?? 0).toFixed(2)}  (${usage.calls ?? "?"} calls${usage.models?.length ? ", " + usage.models.map((m: any) => m.name).join(" + ") : ""})`);
  return 0;
}

export async function cmdNew(rest: string[]): Promise<number> {
  const json = takeBool(rest, "--json");
  const readOnly = takeBool(rest, "--read-only");
  const cont = takeBool(rest, "--continue");
  const model = takeFlag(rest, "--model");
  const effort = takeFlag(rest, "--effort");
  const resumeId = takeFlag(rest, "--resume");
  const agent = takeFlag(rest, "--agent") || "claude";
  const msg = takeFlag(rest, "-m") ?? takeFlag(rest, "--message");
  const dir = rest[0];
  if (!dir) { console.error("usage: joy new <dir> [-m msg] [--agent claude|codex|opencode|pi|agy] [--model m] [--effort e] [--read-only] [--continue|--resume id] [--json]"); return 2; }
  const mode = permissionModeFor(agent, readOnly);
  if (!mode.ok) { console.error(`${bad} ${mode.error}`); return 2; }
  const cwd = resolve(expandTilde(dir));
  const r = await api("POST", "/sessions", {
    cwd, createDir: true, model, effort,
    agent,
    permissionMode: mode.mode,
    continue: cont || undefined,
    resume_id: resumeId || undefined,
    forceNew: !cont && !resumeId ? true : undefined, // "new" means new (#41)
  }).catch(() => null);
  if (!r) { console.error(`${bad} daemon not running (joy start)`); return 1; }
  const body = await r.json().catch(() => ({}));
  if (r.status !== 201) { console.error(`${bad} create failed: ${JSON.stringify(body)}`); return 1; }
  const rec = body as any;
  if (json) console.log(JSON.stringify(rec));
  else console.log(rec.id);
  if (msg && msg.trim()) {
    // The first message is the point of -m: a send the daemon did not accept
    // (5xx, not_durable, connection refused) used to be ignored and the
    // command exited 0 with a session that would never start the work (#494).
    // The id is printed either way — the session exists — and the exit code
    // is the send's.
    const sent = await sendTo(rec, msg, { from: senderIdentity() });
    if (!sent.ok) {
      console.error(`${bad} session ${rec.id} was created but its first message was not accepted — retry with: joy send ${rec.id} ${JSON.stringify(msg)}`);
      return sent.code;
    }
  }
  return 0;
}

/** --read-only per agent: claude's plan mode; codex's read-only sandbox
 *  (approvals on request); opencode and pi have no such switch — refuse
 *  loudly rather than pretend. */
function permissionModeFor(agent: string, readOnly: boolean): { ok: true; mode: string } | { ok: false; error: string } {
  if (!readOnly) return { ok: true, mode: "bypassPermissions" };
  if (agent === "claude") return { ok: true, mode: "plan" };
  if (agent === "codex") return { ok: true, mode: "read-only" };
  return { ok: false, error: `--read-only is not available for ${agent} (no read-only mode in that harness)` };
}

// joy ask <session> <text...> [--timeout secs] [--json]
// Exclusive send + wait for the turn to finish + print the response text.
export async function cmdAsk(rest: string[]): Promise<number> {
  const json = takeBool(rest, "--json");
  const noQueue = takeBool(rest, "--no-queue");
  const timeoutS = Number(takeFlag(rest, "--timeout") ?? 600);
  const [target, ...words] = rest;
  const text = words.join(" ").trim();
  if (!target || !text) { console.error("usage: joy ask <session> <text...> [--timeout secs] [--no-queue] [--json]"); return 2; }
  const rec = await resolveSession(target);
  if (!rec) return 1;
  const sent = await sendTo(rec, text, { exclusive: noQueue, from: senderIdentity() });
  if (!sent.ok) return sent.code;
  const out = await waitTurn(rec.id, { afterSeq: sent.seq, queuedId: sent.queuedId, text, timeoutMs: timeoutS * 1000 });
  if (json) {
    console.log(JSON.stringify({ session: rec.id, state: out.state, text: out.text, turn: sent.queuedId,
      question: out.check?.question ?? null, options: out.check?.options ?? null, approval: out.check?.approvals?.[0] ?? null,
      usage: [...out.records].reverse().map((r) => evOf(r)?.usage).find(Boolean) ?? null, ...(out.reason ? { reason: out.reason } : {}) }));
  } else {
    if (out.text) console.log(out.text);
    if (out.state === "needs_input") console.error(`${c.y("?")} ${rec.id} is waiting for input${out.check?.approvals?.length ? ` (approval: ${out.check.approvals[0].title})` : ""}`);
    else if (out.state === "timeout") console.error(`${bad} timed out after ${timeoutS}s (session ${rec.id})`);
    else if (out.state === "gone") console.error(`${bad} session ${rec.id} gone${out.reason ? ` (${out.reason})` : ""}`);
    else if (out.state === "error") console.error(`${bad} ${out.reason ?? "turn could not be observed"} (session ${rec.id})`);
  }
  return OUTCOME_EXIT[out.state];
}

// joy run <prompt...> [--dir d] [--model m] [--effort e] [--read-only]
//                      [--timeout secs] [--json]
// One-shot / EPHEMERAL, the `claude -p` analogue: create a throwaway session,
// run the prompt, print the response, then ALWAYS tear down — kill the session
// (closes its tmux window) AND delete the Claude transcript log, leaving no
// trace. Cleanup runs even on timeout/error so a failed run never strands a
// zombie session or its log. Default cwd is `.`; default mode is yolo
// (bypassPermissions) so tools run without prompting — `--read-only` uses plan.
async function cmdRun(rest: string[]): Promise<number> {
  const json = takeBool(rest, "--json");
  const readOnly = takeBool(rest, "--read-only");
  const timeoutS = Number(takeFlag(rest, "--timeout") ?? 600);
  const dir = takeFlag(rest, "--dir") ?? ".";
  const model = takeFlag(rest, "--model");
  const effort = takeFlag(rest, "--effort");
  const agent = takeFlag(rest, "--agent") || "claude";
  const prompt = rest.join(" ").trim();
  if (!prompt) { console.error("usage: joy run <prompt...> [--dir d] [--agent a] [--model m] [--read-only] [--timeout secs] [--json]"); return 2; }
  const mode = permissionModeFor(agent, readOnly);
  if (!mode.ok) { console.error(`${bad} ${mode.error}`); return 2; }
  const cwd = resolve(expandTilde(dir));

  // forceNew: a one-shot must never revive (and then DELETE + purge) a detached
  // conversation that happens to live in this folder (#41).
  const cr = await api("POST", "/sessions", { cwd, createDir: true, model, effort, agent, permissionMode: mode.mode, forceNew: true }).catch(() => null);
  if (!cr) { console.error(`${bad} daemon not running (joy start)`); return 1; }
  const rec = await cr.json().catch(() => ({})) as any;
  if (cr.status !== 201) { console.error(`${bad} create failed: ${JSON.stringify(rec)}`); return 1; }

  let out: TurnOutcome | null = null;
  let code = 0;
  try {
    const sent = await sendTo(rec, prompt, { from: senderIdentity(), replyTo: null });
    if (!sent.ok) code = sent.code;
    else {
      out = await waitTurn(rec.id, { afterSeq: sent.seq, queuedId: sent.queuedId, text: prompt, timeoutMs: timeoutS * 1000 });
      code = OUTCOME_EXIT[out.state];
      if (out.state === "timeout") console.error(`${bad} timed out after ${timeoutS}s (session ${rec.id})`);
      else if (out.state === "error" || out.state === "gone") console.error(`${bad} ${out.reason ?? out.state} (session ${rec.id})`);
    }
  } finally {
    let pid = rec.pid as number | undefined;
    let tp = rec.transcript_path as string | undefined;
    try {
      const g = await api("GET", `/sessions/${rec.id}`);
      if (g.ok) { const s = await g.json() as any; pid = s.pid ?? pid; tp = s.transcript_path ?? tp; }
    } catch { /* use create-time values */ }
    await api("DELETE", `/sessions/${rec.id}`).catch(() => {});
    if (typeof pid === "number") {
      for (let i = 0; i < 40; i++) { // ~10s ceiling
        try { process.kill(pid, 0); } catch { break; } // ESRCH → dead
        await wait(250);
      }
    }
    if (tp) await purgeTranscript(tp);
  }
  if (json) console.log(JSON.stringify({ ok: code === 0, state: out?.state ?? "error", cwd, response: out?.text ?? "" }));
  else if (out?.text) console.log(out.text);
  return code;
}

// joy send <session> <text...> — exclusive fire-and-forget (no wait).
async function cmdSend(rest: string[]): Promise<number> {
  const noQueue = takeBool(rest, "--no-queue");
  const noReply = takeBool(rest, "--no-reply");
  const from = takeFlag(rest, "--from");
  const json = takeBool(rest, "--json");
  const [target, ...words] = rest;
  const text = words.join(" ").trim();
  if (!target || !text) { console.error("usage: joy send <session> <text...> [--no-queue] [--no-reply] [--json]"); return 2; }
  const rec = await resolveSession(target);
  if (!rec) return 1;
  const sender = from ?? senderIdentity();
  const r = await sendTo(rec, text, { exclusive: noQueue, from: sender, replyTo: noReply ? null : undefined });
  if (!r.ok) return r.code;
  if (json) console.log(JSON.stringify({ ok: true, session: rec.id, turn: r.queuedId, from: sender }));
  else console.log(r.queuedId ? `queued ${r.queuedId}` : "sent");
  return 0;
}

// joy wait <session> [--timeout secs] — block until the session is idle.
export async function cmdWaitIdle(rest: string[]): Promise<number> {
  const timeoutS = Number(takeFlag(rest, "--timeout") ?? 600);
  const turn = takeFlag(rest, "--turn");
  const json = takeBool(rest, "--json");
  const target = rest[0];
  if (!target) { console.error("usage: joy wait <session> [--turn id] [--timeout secs] [--json]"); return 2; }
  const rec = await resolveSession(target);
  if (!rec) return 1;
  const out = await waitTurn(rec.id, { afterSeq: 0, queuedId: turn ?? null, timeoutMs: timeoutS * 1000 });
  if (json) console.log(JSON.stringify({ session: rec.id, state: out.state, check: out.check, ...(out.reason ? { reason: out.reason } : {}) }));
  else if (out.state === "answered") console.log(`${ok} ${rec.id} idle`);
  else if (out.state === "needs_input") console.log(`${c.y("?")} ${rec.id} needs input`);
  else if (out.state === "timeout") console.error(`${bad} timed out after ${timeoutS}s (session ${rec.id} still busy)`);
  else if (out.state === "error") console.error(`${bad} ${out.reason ?? "turn could not be observed"} (session ${rec.id})`);
  else console.error(`${bad} session ${rec.id} gone${out.reason ? ` (${out.reason})` : ""}`);
  return OUTCOME_EXIT[out.state];
}

// joy log <session> [-n count] — recent user/assistant text from the transcript.
async function cmdEvents(rest: string[]): Promise<number> {
  const json = takeBool(rest, "--json");
  const follow = takeBool(rest, "--follow") || takeBool(rest, "-f");
  const last = takeFlag(rest, "--last") ?? takeFlag(rest, "-n");
  const target = rest[0];
  if (!target) { console.error("usage: joy events <session> [--follow] [--last N] [--json]"); return 2; }
  const rec = await resolveSession(target);
  if (!rec) return 1;
  const controller = new AbortController();
  process.on("SIGINT", () => { controller.abort(); process.exit(0); });
  try {
    for await (const line of streamEvents(rec.id, { last: last !== undefined ? Number(last) : (follow ? 0 : 12), follow, signal: controller.signal })) {
      if (line?.hello) continue;
      if (json) console.log(JSON.stringify(line));
      else { const s = renderRecord(line); if (s) console.log(s); }
    }
  } catch (e) {
    if (!controller.signal.aborted) { console.error(`${bad} ${e instanceof Error ? e.message : String(e)}`); return 1; }
  }
  return 0;
}

// joy kill <session> — end the session (kills its tmux window).
// ── controls: the app's session menu, as verbs ──────────────────────────────
async function cmdAbort(rest: string[]): Promise<number> {
  if (!rest[0]) { console.error("usage: joy abort <session>"); return 2; }
  const rec = await resolveSession(rest[0]);
  if (!rec) return 1;
  const r = await api("POST", `/sessions/${rec.id}/abort`).catch(() => null);
  if (!r || !r.ok) { console.error(`${bad} abort failed`); return 1; }
  console.log(`${ok} interrupted ${rec.id}`);
  return 0;
}

async function cmdApprovals(rest: string[]): Promise<number> {
  const json = takeBool(rest, "--json");
  if (!rest[0]) { console.error("usage: joy approvals <session> [--json]"); return 2; }
  const rec = await resolveSession(rest[0]);
  if (!rec) return 1;
  const r = await api("GET", `/sessions/${rec.id}/approvals`).catch(() => null);
  const body = r ? await r.json().catch(() => null) as any : null;
  if (!body) { console.error(`${bad} daemon not running`); return 1; }
  const list: any[] = body.approvals ?? [];
  if (json) { console.log(JSON.stringify(list)); return 0; }
  if (list.length === 0) { console.log("no pending approvals"); return 0; }
  for (const a of list) console.log(`  ${c.b(a.requestId)}  ${String(a.kind).padEnd(8)} ${a.title}${a.detail ? c.dim("  " + String(a.detail).slice(0, 100)) : ""}  ${c.dim(fmtUptime(Date.now() - a.since) + " ago")}`);
  return 0;
}

async function cmdDecide(rest: string[], decision: "allow" | "deny"): Promise<number> {
  const [target, requestId] = rest;
  if (!target) { console.error(`usage: joy ${decision === "allow" ? "approve" : "deny"} <session> [requestId]`); return 2; }
  const rec = await resolveSession(target);
  if (!rec) return 1;
  let id = requestId;
  if (!id) {
    const r = await api("GET", `/sessions/${rec.id}/approvals`).catch(() => null);
    const body = r ? await r.json().catch(() => null) as any : null;
    id = body?.approvals?.[0]?.requestId;
    if (!id) { console.log("no pending approvals"); return 0; }
  }
  const r = await api("POST", `/sessions/${rec.id}/approvals`, { requestId: id, decision }).catch(() => null);
  const body = r ? await r.json().catch(() => ({})) as any : null;
  if (!r || !r.ok || !body?.ok) { console.error(`${bad} ${body?.error ?? "no such approval"}`); return 1; }
  console.log(`${ok} ${decision === "allow" ? "approved" : "denied"} ${id}`);
  return 0;
}

async function cmdQueue(rest: string[]): Promise<number> {
  const target = rest[0];
  if (!target) { console.error("usage: joy queue <session> [cancel <id>]"); return 2; }
  const rec = await resolveSession(target);
  if (!rec) return 1;
  if (rest[1] === "cancel") {
    const qid = rest[2];
    if (!qid) { console.error("usage: joy queue <session> cancel <id>"); return 2; }
    const r = await api("DELETE", `/sessions/${rec.id}/queue/${encodeURIComponent(qid)}`).catch(() => null);
    const body = r ? await r.json().catch(() => ({})) as any : null;
    if (!r || !r.ok || body?.ok === false) { console.error(`${bad} not queued: ${qid}`); return 1; }
    console.log(`${ok} cancelled ${qid}`);
    return 0;
  }
  const r = await api("GET", `/sessions/${rec.id}/queue`).catch(() => null);
  const qs = r ? await r.json().catch(() => null) as any : null;
  if (!qs) { console.error(`${bad} daemon not running`); return 1; }
  const items: any[] = qs.items ?? qs.queue ?? [];
  if (items.length === 0) { console.log(`queue empty${qs.paused ? " (paused)" : ""}`); return 0; }
  for (const it of items) console.log(`  ${c.b(String(it.id))}  ${String(it.state ?? "").padEnd(10)} ${String(it.text ?? "").replace(/\s+/g, " ").slice(0, 100)}`);
  if (qs.paused) console.log(c.y("  (queue paused)"));
  return 0;
}

async function cmdMode(rest: string[]): Promise<number> {
  const [target, mode] = rest;
  if (!target) { console.error("usage: joy mode <session> [<permission mode>]"); return 2; }
  const rec = await resolveSession(target);
  if (!rec) return 1;
  if (!mode) { const ck = await checkState(rec.id); console.log(ck?.permissionMode ?? "unknown"); return 0; }
  const r = await api("POST", `/sessions/${rec.id}/mode`, { mode }).catch(() => null);
  const body = r ? await r.json().catch(() => ({})) as any : null;
  if (!r || !r.ok || body?.ok === false) { console.error(`${bad} ${body?.error ?? "mode change failed"}`); return 1; }
  console.log(`${ok} ${rec.id} mode → ${body?.mode ?? mode}`);
  return 0;
}

async function cmdPane(rest: string[]): Promise<number> {
  const color = takeBool(rest, "--color");
  if (!rest[0]) { console.error("usage: joy pane <session> [--color]"); return 2; }
  const rec = await resolveSession(rest[0]);
  if (!rec) return 1;
  const r = await api("GET", `/sessions/${rec.id}/pane${color ? "?color=1" : ""}`).catch(() => null);
  const body = r ? await r.json().catch(() => null) as any : null;
  if (!body?.ok) { console.error(`${bad} ${body?.error ?? "no pane (this agent has no terminal view)"}`); return 1; }
  process.stdout.write(String(body.text ?? "").replace(/\s+$/, "") + "\n");
  return 0;
}

// joy env ls | set KEY=value | unset KEY — the sealed store every new session inherits.
async function cmdEnv(rest: string[]): Promise<number> {
  const sub = rest[0];
  if (sub === "ls" || sub === "list" || sub === undefined) {
    const r = await api("GET", "/env").catch(() => null);
    const body = r ? await r.json().catch(() => null) as any : null;
    if (!body) { console.error(`${bad} daemon not running`); return 1; }
    if (body.error) { console.error(`${bad} ${body.error === "no_machine_key" ? "not paired (joy auth) — no machine key to seal with" : body.error}`); return 1; }
    if (!body.names?.length) { console.log("no variables (joy env set KEY=value)"); return 0; }
    for (const n of body.names) console.log(`  ${n}`);
    return 0;
  }
  if (sub === "set") {
    const kv = rest.slice(1).join(" ");
    const eq = kv.indexOf("=");
    if (eq <= 0) { console.error("usage: joy env set KEY=value"); return 2; }
    const name = kv.slice(0, eq).trim();
    const r = await api("POST", "/env", { name, value: kv.slice(eq + 1) }).catch(() => null);
    const body = r ? await r.json().catch(() => ({})) as any : null;
    if (!r || !r.ok) { console.error(`${bad} ${body?.error ?? "set failed"}`); return 1; }
    console.log(`${ok} ${name} set — new sessions get it`);
    return 0;
  }
  if (sub === "unset" || sub === "rm") {
    const name = rest[1];
    if (!name) { console.error("usage: joy env unset KEY"); return 2; }
    const r = await api("DELETE", `/env/${encodeURIComponent(name)}`).catch(() => null);
    const body = r ? await r.json().catch(() => ({})) as any : null;
    if (!r || !r.ok) { console.error(`${bad} ${body?.error ?? "unset failed"}`); return 1; }
    console.log(body?.existed ? `${ok} ${name} removed` : `${name} was not set`);
    return 0;
  }
  console.error("usage: joy env [ls] | set KEY=value | unset KEY");
  return 2;
}

async function cmdKill(rest: string[]): Promise<number> {
  const target = rest[0];
  if (!target) { console.error("usage: joy kill <session>"); return 2; }
  const rec = await resolveSession(target);
  if (!rec) return 1;
  const r = await api("DELETE", `/sessions/${rec.id}`).catch(() => null);
  if (!r) { console.error(`${bad} daemon not running`); return 1; }
  const body = await r.json().catch(() => ({})) as any;
  if (!body.ok) { console.error(`${bad} kill failed`); return 1; }
  console.log(`killed ${rec.id}`);
  return 0;
}

function help(): void {
  console.log(`${c.b("joy")} — joy-daemon daemon control

${c.b("Usage:")} joy [--relay <joy|joy-dev|url>] <command>

  ${c.dim("--relay selects which relay's daemon the command addresses (default:")}
  ${c.dim("$JOY_RELAY_URL / ~/.joy/relay.json / the joy relay). Per-relay daemons run")}
  ${c.dim("side by side — own state, own tmux server, own service unit.")}

  ${c.b("start")}        Start the daemon (detached)
  ${c.b("stop")}         Stop the daemon (tmux sessions stay alive; an installed service is stopped via systemctl/launchctl)
  ${c.b("restart")}      Restart the daemon (re-exec; running sessions survive)
  ${c.b("status")}       Show daemon status
  ${c.b("ls")}           List sessions: id, agent, state (idle / busy / needs input), title, cwd
  ${c.b("about")}        Everything about one session:  joy about <session> [--json]
  ${c.b("check")}        Can it be talked to right now?  joy check <session>  → exit 0 idle · 3 busy · 6 needs input · 1 gone
  ${c.b("jump")}         Attach/switch to a session's tmux window [id|prefix|path; default cwd]
  ${c.b("new")}          Create a session:  joy new <dir> [-m msg] [--agent claude|codex|opencode|pi|agy] [--model m]
                 [--effort e] [--read-only] [--continue|--resume <id>] [--json]  → prints session id
                 (a -m message the daemon did not accept fails the command with the send's exit code; the id is still printed)
  ${c.b("run")}          One-shot (ephemeral, like claude -p): create → prompt → print response → kill session.
                 joy run <prompt...> [--dir d] [--agent a] [--model m] [--read-only] [--timeout s] [--json]
  ${c.b("ask")}          Send + wait + print:  joy ask <session> <text...> [--timeout s] [--json]
                 --json → { state: answered | needs_input | timeout | gone | error, text, question?, approval?, usage, reason? }
                 (error, exit 1: the turn could not be observed — /check failed or the reply's records were lost)
  ${c.b("send")}         Send without waiting (queued behind a running turn):  joy send <session> <text...>
                 [--no-queue: fail with exit 3 if busy] [--no-reply] [--json → turn id]
  ${c.b("wait")}         Block until a turn ends:  joy wait <session> [--turn <id>] [--timeout s]
  ${c.b("events")}       The session's records — text, tool calls, turn lifecycle, usage:
                 joy events <session> [--follow] [--last N] [--json]
  ${c.b("abort")}        Interrupt the running turn:  joy abort <session>
  ${c.b("approvals")}    Held tool-call approvals (codex):  joy approvals <session> · joy approve|deny <session> [id]
  ${c.b("queue")}        Queued messages:  joy queue <session> [cancel <id>]
  ${c.b("mode")}         Show or set the permission mode:  joy mode <session> [<mode>]
  ${c.b("pane")}         The terminal view as text:  joy pane <session> [--color]
  ${c.b("kill")}         End a session:  joy kill <session>
               Messages sent from inside a joy session carry <joy-message from="joy:<id>" reply-to=…> — the
               daemon stamps it from JOY_SESSION_ID and the app shows who sent it. Exit codes:
               0 ok · 1 error · 2 usage · 3 busy · 4 timeout · 5 mode · 6 needs input.
  ${c.b("env")}          Sealed provider keys every new session inherits:  joy env [ls] | set KEY=value | unset KEY
  ${c.b("doctor")}       Diagnose the environment (node, tmux, claude, auth, daemon)
  ${c.b("auth")}         Show authentication status for the selected relay
               joy auth <relay...>: pair this machine with relays using your
               account backup code (one code works on every relay) — e.g.
               ${c.dim("joy auth joy joy-dev")}
  ${c.b("notify")}       Push a notification:  joy notify -p "message" [-t title]
  ${c.b("update")}       Update @fny/joy-daemon from the repo's release branch, then reinstall + restart
  ${c.b("install")}      Install autostart service (systemd on Linux, launchd on macOS)
  ${c.b("uninstall")}    Remove the autostart service
`);
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  let code = 0;
  switch (cmd) {
    case "status": code = await cmdStatus(); break;
    case "list": case "ls": code = await cmdList(); break;
    case "about": code = await cmdAbout(rest); break;
    case "check": code = await cmdCheck(rest); break;
    case "events": code = await cmdEvents(rest); break;
    case "abort": code = await cmdAbort(rest); break;
    case "approvals": code = await cmdApprovals(rest); break;
    case "approve": code = await cmdDecide(rest, "allow"); break;
    case "deny": code = await cmdDecide(rest, "deny"); break;
    case "queue": code = await cmdQueue(rest); break;
    case "mode": code = await cmdMode(rest); break;
    case "pane": code = await cmdPane(rest); break;
    case "env": code = await cmdEnv(rest); break;
    case "jump": case "j": code = await cmdJump(rest); break;
    case "run": code = await cmdRun(rest); break;
    case "new": code = await cmdNew(rest); break;
    case "ask": code = await cmdAsk(rest); break;
    case "send": code = await cmdSend(rest); break;
    case "wait": code = await cmdWaitIdle(rest); break;
    case "kill": code = await cmdKill(rest); break;
    case "start": code = await cmdStart(); break;
    case "stop": code = await cmdStop(); break;
    case "restart": code = await cmdRestart(); break;
    case "doctor": code = await cmdDoctor(); break;
    case "auth": code = rest.length > 0 ? await cmdAuthPair(rest) : cmdAuth(); break;
    case "notify": code = await cmdNotify(rest); break;
    case "update": code = cmdUpdate(); break;
    case "install": code = cmdInstall(); break;
    case "uninstall": code = cmdUninstall(); break;
    case undefined: case "help": case "-h": case "--help": help(); break;
    default: console.log(`unknown command: ${cmd}\n`); help(); code = 1;
  }
  process.exit(code);
}

// Under vitest this module is imported for its exported helpers, not run.
if (!process.env.VITEST) void main();
