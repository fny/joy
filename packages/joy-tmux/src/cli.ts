#!/usr/bin/env -S node --import tsx
// joy — CLI for the joy-tmux daemon. Mirrors happy-cli's surface (start/stop/
// restart/status/list/doctor/install/auth/notify) but drives the joy-tmux
// daemon over its localhost HTTP API. The daemon writes ~/.happy/joy-tmux-state/
// daemon.json (token+pid+port) on startup, which is how this CLI finds and
// authenticates to it.

import { existsSync, readFileSync, writeFileSync, mkdirSync, openSync, rmSync } from "fs";
import { join, dirname } from "path";
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
const PKG_DIR = moduleDir(import.meta.url);
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
    console.log(`  joy-tmux shares Happy's credentials (${c.dim(accessKey)}).`);
    console.log(`  Run ${c.b("happy auth login")} (or set up the Happy app) to create them.`);
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

function cmdInstall(): number {
  const plat = osPlatform();
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
    spawnSync("launchctl", ["unload", path], { stdio: "ignore" });
    const r = spawnSync("launchctl", ["load", "-w", path], { stdio: "inherit" });
    if (r.status !== 0) { console.log(`${bad} launchctl load failed`); return 1; }
    console.log(`${ok} installed launchd agent → ${path}`);
    return 0;
  }
  console.log(`${bad} install not supported on ${plat} (linux/macOS only)`);
  return 1;
}

function cmdUninstall(): number {
  const plat = osPlatform();
  if (plat === "linux") {
    spawnSync("systemctl", ["--user", "disable", "--now", "joy-tmux.service"], { stdio: "inherit" });
    try { rmSync(systemdUnitPath()); } catch {}
    spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
    console.log(`${ok} uninstalled systemd user service`);
    return 0;
  }
  if (plat === "darwin") {
    spawnSync("launchctl", ["unload", launchdPlistPath()], { stdio: "ignore" });
    try { rmSync(launchdPlistPath()); } catch {}
    console.log(`${ok} uninstalled launchd agent`);
    return 0;
  }
  console.log(`${bad} uninstall not supported on ${plat}`);
  return 1;
}

function help(): void {
  console.log(`${c.b("joy")} — joy-tmux daemon control

${c.b("Usage:")} joy <command>

  ${c.b("start")}        Start the daemon (detached)
  ${c.b("stop")}         Stop the daemon (tmux sessions stay alive)
  ${c.b("restart")}      Restart the daemon (re-exec; running sessions survive)
  ${c.b("status")}       Show daemon status
  ${c.b("list")}         List sessions the daemon is tracking
  ${c.b("doctor")}       Diagnose the environment (node, tmux, claude, auth, daemon)
  ${c.b("auth")}         Show authentication status (shared with Happy)
  ${c.b("notify")}       Push a notification:  joy notify -p "message" [-t title]
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
    case "start": code = await cmdStart(); break;
    case "stop": code = await cmdStop(); break;
    case "restart": code = await cmdRestart(); break;
    case "doctor": code = await cmdDoctor(); break;
    case "auth": code = cmdAuth(); break;
    case "notify": code = await cmdNotify(rest); break;
    case "install": code = cmdInstall(); break;
    case "uninstall": code = cmdUninstall(); break;
    case undefined: case "help": case "-h": case "--help": help(); break;
    default: console.log(`unknown command: ${cmd}\n`); help(); code = 1;
  }
  process.exit(code);
}

void main();
