#!/usr/bin/env -S node --import tsx
// joy — CLI for the joy-tmux daemon. Mirrors happy-cli's surface (start/stop/
// restart/status/list/doctor/install/auth/notify) but drives the joy-tmux
// daemon over its localhost HTTP API. The daemon writes ~/.happy/joy-tmux-state/
// daemon.json (token+pid+port) on startup, which is how this CLI finds and
// authenticates to it.

import { existsSync, readFileSync, writeFileSync, mkdirSync, openSync, rmSync } from "fs";
import { join, dirname, resolve, basename, sep } from "path";
import { homedir, platform as osPlatform } from "os";
import { spawn, spawnSync } from "child_process";
import { moduleDir } from "./esm";
import { happyHomeDir, joyStateDir } from "./paths";

const PORT = parseInt(process.env.PORT ?? "4997");
const BASE = `http://127.0.0.1:${PORT}`;
const HAPPY_HOME = happyHomeDir();
const STATE_DIR = joyStateDir();
const STATE_FILE = join(STATE_DIR, "daemon.json");
const LOG_FILE = join(STATE_DIR, "daemon.log");
// pnpm global installs resolve import.meta.url into pnpm's versioned content-addressed
// store (…/.pnpm/@fny+joy-tmux@1.0.15_…/node_modules/@fny/joy-tmux). Baking THAT into a
// launchd/systemd service breaks on the next `pnpm add -g`: pnpm makes a fresh store dir
// for the new version and deletes the old one, so the service's server.ts path vanishes
// and the daemon crash-loops. Collapse it to pnpm's stable top-level node_modules symlink
// (always repointed at the current version). No-op for source checkouts / npm-global,
// which have no .pnpm segment. (NODE = process.execPath is already a stable, canonical
// version-install path — verified — so it needs no such treatment.)
const PKG_DIR = moduleDir(import.meta.url).replace(/\/\.pnpm\/[^/]+\/node_modules\//, "/node_modules/");
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

type DaemonState = { token: string; pid: number; port: number; startedAt: number; version: string };

function readState(): DaemonState | null {
  try { return JSON.parse(readFileSync(STATE_FILE, "utf8")) as DaemonState; } catch { return null; }
}

function authHeaders(): Record<string, string> {
  const st = readState();
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (st?.token) h["X-Joy-Token"] = st.token;
  return h;
}

async function api(method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(BASE + path, {
    method,
    headers: authHeaders(),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

/** Returns the live status JSON if the daemon answers, else null. */
async function probe(): Promise<any | null> {
  try {
    const r = await fetch(BASE + "/status", { headers: authHeaders() });
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
  if (!s) { console.log(`${bad} joy-tmux daemon not running`); return 1; }
  console.log(`${ok} joy-tmux daemon ${c.b("running")}`);
  console.log(`  version  ${s.version ?? "?"}`);
  console.log(`  pid      ${s.pid ?? "?"}`);
  console.log(`  port     ${PORT}`);
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
  for (const s of sessions) {
    const st = s.status === "active" ? c.g(s.status)
      : s.status === "ended" ? c.dim("detached/ended") : s.status;
    console.log(`  ${s.id}  ${st.padEnd(20)}  ${s.cwd}`);
  }
  return 0;
}

async function cmdStart(): Promise<number> {
  if (await probe()) {
    const st = readState();
    console.log(`${ok} already running (pid ${st?.pid ?? "?"})`);
    return 0;
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
  process.stdout.write("starting joy-tmux daemon");
  for (let i = 0; i < 50; i++) {
    await new Promise(r => setTimeout(r, 200));
    process.stdout.write(".");
    if (await probe()) { console.log(`\n${ok} started (pid ${readState()?.pid})`); return 0; }
  }
  console.log(`\n${bad} daemon did not come up — see ${LOG_FILE}`);
  return 1;
}

async function cmdStop(): Promise<number> {
  const s = await probe();
  const pid = s?.pid ?? readState()?.pid;
  if (!pid) { console.log("daemon not running"); return 0; }
  try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
  for (let i = 0; i < 25; i++) {
    await new Promise(r => setTimeout(r, 200));
    if (!(await probe())) { try { rmSync(STATE_FILE); } catch {} console.log(`${ok} stopped (pid ${pid})`); return 0; }
  }
  console.log(`${warn} sent SIGTERM to ${pid} but it's still answering`);
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
  console.log(c.b("\n🩺 joy-tmux doctor\n"));
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

  const accessKey = join(HAPPY_HOME, "access.key");
  line(existsSync(accessKey), "auth", existsSync(accessKey) ? accessKey : "no ~/.happy/access.key — run `joy auth`");

  line(existsSync(SERVER_TS), "daemon src", SERVER_TS);

  const s = await probe();
  if (s) line(true, "daemon", `running (pid ${s.pid}, up ${s.uptimeMs != null ? fmtUptime(s.uptimeMs) : "?"})`);
  else line(false, "daemon", "not running — `joy start`");

  console.log("");
  return (tmuxPath && existsSync(accessKey)) ? 0 : 1;
}

function cmdAuth(): number {
  const accessKey = join(HAPPY_HOME, "access.key");
  if (!existsSync(accessKey)) {
    console.log(`${bad} not authenticated`);
    console.log(`  joy-tmux shares the Joy app's credentials (${c.dim(accessKey)}).`);
    console.log(`  Run ${c.b("happy auth login")} (or set up the Joy app) to create them.`);
    return 1;
  }
  let machineId = "?", server = "?";
  try {
    const s = JSON.parse(readFileSync(join(HAPPY_HOME, "settings.json"), "utf8")) as any;
    machineId = s.machineId ?? "?";
    server = s.serverUrl ?? "(default)";
  } catch { /* settings optional */ }
  console.log(`${ok} authenticated`);
  console.log(`  credentials ${accessKey}`);
  console.log(`  machineId   ${machineId}`);
  console.log(`  server      ${server}`);
  return 0;
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

function systemdUnitPath(): string { return join(homedir(), ".config", "systemd", "user", "joy-tmux.service"); }
function launchdPlistPath(): string { return join(homedir(), "Library", "LaunchAgents", "party.voltai.joy-tmux.plist"); }

// Tear down whatever service is currently installed, quietly. Shared by uninstall
// (which then reports) and install (which calls it first, so install is idempotent:
// a changed unit actually takes effect, and a stale or hand-rolled plist migrates
// cleanly instead of lingering next to the new one).
function removeService(): void {
  const plat = osPlatform();
  if (plat === "linux") {
    spawnSync("systemctl", ["--user", "disable", "--now", "joy-tmux.service"], { stdio: "ignore" });
    try { rmSync(systemdUnitPath()); } catch {}
    spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
  } else if (plat === "darwin") {
    spawnSync("launchctl", ["unload", launchdPlistPath()], { stdio: "ignore" });
    try { rmSync(launchdPlistPath()); } catch {}
  }
}

function cmdInstall(): number {
  const plat = osPlatform();
  removeService(); // idempotent: start from a clean slate so the new config takes effect
  if (plat === "linux") {
    const unit = `[Unit]
Description=joy-tmux daemon
After=network-online.target

[Service]
Type=simple
ExecStart=${NODE} --import tsx ${SERVER_TS}
WorkingDirectory=${PKG_DIR}
Environment=PATH=${process.env.PATH ?? ""}
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
`;
    const path = systemdUnitPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, unit);
    spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "inherit" });
    const r = spawnSync("systemctl", ["--user", "enable", "--now", "joy-tmux.service"], { stdio: "inherit" });
    if (r.status !== 0) { console.log(`${bad} systemctl enable failed (is lingering enabled? \`loginctl enable-linger $USER\`)`); return 1; }
    console.log(`${ok} installed systemd user service → ${path}`);
    console.log(`  ${c.dim("logs: journalctl --user -u joy-tmux -f")}`);
    return 0;
  }
  if (plat === "darwin") {
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>party.voltai.joy-tmux</string>
  <key>ProgramArguments</key>
  <array><string>${NODE}</string><string>--import</string><string>tsx</string><string>${SERVER_TS}</string></array>
  <key>WorkingDirectory</key><string>${PKG_DIR}</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>${process.env.PATH ?? ""}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${LOG_FILE}</string>
  <key>StandardErrorPath</key><string>${LOG_FILE}</string>
</dict>
</plist>
`;
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

// Update the global package to the latest published version, then reinstall the
// service so the daemon restarts onto the new code — migrating a stale baked path
// along the way. For pnpm-global installs; a source checkout updates via git pull
// + `joy restart` instead.
function cmdUpdate(): number {
  console.log("updating @fny/joy-tmux…");
  const r = spawnSync("pnpm", ["add", "-g", "@fny/joy-tmux@latest"], { stdio: "inherit" });
  if (r.status !== 0) { console.log(`${bad} pnpm add -g failed (is pnpm on PATH?)`); return 1; }
  return cmdInstall();
}

function cmdUninstall(): number {
  const plat = osPlatform();
  if (plat !== "linux" && plat !== "darwin") {
    console.log(`${bad} uninstall not supported on ${plat}`);
    return 1;
  }
  removeService();
  console.log(`${ok} uninstalled joy-tmux service`);
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
//   joy jump <path>     → by the session's cwd (also matches a bare folder name)
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
    if (!matches.length) matches = sessions.filter((s) => basename(resolve(s.cwd)) === arg); // folder name
  }

  if (matches.length === 0) { console.log(`${bad} no session matching ${how}`); return 1; }
  if (matches.length > 1) {
    console.log(`${bad} ${matches.length} sessions match ${how} — be more specific:`);
    for (const s of matches) console.log(`    ${c.b(s.id)}  ${s.cwd}`);
    return 1;
  }

  const win = String(matches[0].tmux_window);   // e.g. "joy:j-9214e0a2"
  const tmuxSession = win.split(":")[0];
  // select-window both validates the window still exists and makes it active.
  const sel = spawnSync("tmux", ["select-window", "-t", win], { stdio: "ignore" });
  if (sel.status !== 0) { console.log(`${bad} tmux window ${win} not found (session ended?)`); return 1; }
  const sub = process.env.TMUX
    ? spawnSync("tmux", ["switch-client", "-t", win], { stdio: "inherit" })      // already in tmux
    : spawnSync("tmux", ["attach-session", "-t", tmuxSession], { stdio: "inherit" });
  return sub.status === 0 ? 0 : 1;
}

function help(): void {
  console.log(`${c.b("joy")} — joy-tmux daemon control

${c.b("Usage:")} joy <command>

  ${c.b("start")}        Start the daemon (detached)
  ${c.b("stop")}         Stop the daemon (tmux sessions stay alive)
  ${c.b("restart")}      Restart the daemon (re-exec; running sessions survive)
  ${c.b("status")}       Show daemon status
  ${c.b("list")}         List sessions the daemon is tracking
  ${c.b("jump")}         Attach/switch to a session's tmux window [id|prefix|path; default cwd]
  ${c.b("doctor")}       Diagnose the environment (node, tmux, claude, auth, daemon)
  ${c.b("auth")}         Show authentication status (shared with the Joy app)
  ${c.b("notify")}       Push a notification:  joy notify -p "message" [-t title]
  ${c.b("update")}       Update @fny/joy-tmux to latest, then reinstall + restart
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
    case "jump": case "j": code = await cmdJump(rest); break;
    case "start": code = await cmdStart(); break;
    case "stop": code = await cmdStop(); break;
    case "restart": code = await cmdRestart(); break;
    case "doctor": code = await cmdDoctor(); break;
    case "auth": code = cmdAuth(); break;
    case "notify": code = await cmdNotify(rest); break;
    case "update": code = cmdUpdate(); break;
    case "install": code = cmdInstall(); break;
    case "uninstall": code = cmdUninstall(); break;
    case undefined: case "help": case "-h": case "--help": help(); break;
    default: console.log(`unknown command: ${cmd}\n`); help(); code = 1;
  }
  process.exit(code);
}

void main();
