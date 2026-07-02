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
const LAUNCHD_LABEL = "vip.voltai.joy-tmux";
function launchdPlistPath(): string { return join(homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`); }
// Earlier builds shipped this label; removeService() tears it down too so a
// re-install migrates cleanly instead of leaving two launchd agents running.
const LEGACY_LAUNCHD_LABELS = ["party.voltai.joy-tmux"];

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
    // Current label + any legacy labels (migration), so re-install never leaves
    // a stale agent loaded alongside the new one.
    for (const label of [LAUNCHD_LABEL, ...LEGACY_LAUNCHD_LABELS]) {
      const path = join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
      spawnSync("launchctl", ["unload", path], { stdio: "ignore" });
      try { rmSync(path); } catch {}
    }
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
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
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

// ── session scripting (new/ask/send/wait/log/kill) ──────────────────────────
// The programmatic surface: lets other programs and agents drive joy-tmux
// sessions. Contract (deliberate, do not soften):
//   - sends are EXCLUSIVE: a mid-turn session is a BUSY error (exit 3), never
//     an implicit queue — a script must not line up behind work it can't see.
//   - only bypassPermissions (yolo) or plan (read-only) sessions are
//     scriptable (exit 5 otherwise): any other mode can park on a permission
//     dialog mid-turn, and a blocked `ask` would hang until timeout.
// Exit codes: 0 ok · 1 error · 2 usage · 3 busy · 4 timeout · 5 bad mode.

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

/**
 * Wait on the daemon's SSE stream (/events) for a `stop` event belonging to
 * the session — fired at every turn end. Returns two promises: `ready` resolves
 * once the stream is actually CONNECTED (its first frame decoded — the daemon
 * always opens with a `history` event), and `done` resolves true on the stop /
 * false on timeout. The caller must `await ready` BEFORE sending, or a fast
 * turn's stop can fire in the gap before the stream is listening and be missed.
 */
function sseWaitForStop(rec: any, timeoutMs: number, controller: AbortController): { ready: Promise<void>; done: Promise<boolean> } {
  let markReady: () => void;
  const ready = new Promise<void>((r) => { markReady = r; });
  const done = new Promise<boolean>((resolveWait) => {
    const timer = setTimeout(() => { controller.abort(); resolveWait(false); }, timeoutMs);
    (async () => {
      try {
        const res = await fetch(BASE + "/events", { headers: authHeaders(), signal: controller.signal });
        if (!res.ok || !res.body) { clearTimeout(timer); markReady(); resolveWait(false); return; }
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        let event = "";
        let readyFired = false;
        for (;;) {
          const { done: streamDone, value } = await reader.read();
          if (streamDone) break;
          if (!readyFired) { readyFired = true; markReady(); } // first bytes → connected
          buf += dec.decode(value, { stream: true });
          let nl: number;
          while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl).trimEnd();
            buf = buf.slice(nl + 1);
            if (line.startsWith("event: ")) { event = line.slice(7); continue; }
            if (line.startsWith("data: ") && event === "stop") {
              try {
                const d = JSON.parse(line.slice(6));
                if (d.session_id === rec.claude_session_id || d.session_id === rec.id) {
                  clearTimeout(timer); controller.abort(); resolveWait(true); return;
                }
              } catch { /* ignore malformed frame */ }
            }
            if (line === "") event = "";
          }
        }
      } catch { /* aborted or connection lost */ }
      clearTimeout(timer);
      markReady();
      resolveWait(false);
    })();
  });
  return { ready, done };
}

/** Assistant text blocks from transcript lines[from..] joined as the response. */
function assistantTextFromLines(lines: any[], from: number): string {
  const parts: string[] = [];
  for (const e of lines.slice(from)) {
    if (e?.message?.role !== "assistant") continue;
    const content = e.message.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (b?.type === "text" && typeof b.text === "string" && b.text.trim()) parts.push(b.text.trim());
    }
  }
  return parts.join("\n\n");
}

async function transcriptLines(id: string): Promise<any[]> {
  const r = await api("GET", `/sessions/${id}/transcript`).catch(() => null);
  if (!r || !r.ok) return [];
  const j = await r.json().catch(() => null) as { lines?: any[] } | null;
  return Array.isArray(j?.lines) ? j!.lines! : [];
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
async function cmdNew(rest: string[]): Promise<number> {
  const json = takeBool(rest, "--json");
  const readOnly = takeBool(rest, "--read-only");
  const cont = takeBool(rest, "--continue");
  const model = takeFlag(rest, "--model");
  const effort = takeFlag(rest, "--effort");
  const resumeId = takeFlag(rest, "--resume");
  const msg = takeFlag(rest, "-m") ?? takeFlag(rest, "--message");
  const dir = rest[0];
  if (!dir) { console.error("usage: joy new <dir> [-m msg] [--model m] [--read-only] [--continue|--resume id] [--json]"); return 2; }
  const cwd = resolve(expandTilde(dir));
  const r = await api("POST", "/sessions", {
    cwd, createDir: true, model, effort,
    permissionMode: readOnly ? "plan" : "bypassPermissions",
    continue: cont || undefined,
    resume_id: resumeId || undefined,
  }).catch(() => null);
  if (!r) { console.error(`${bad} daemon not running (joy start)`); return 1; }
  const body = await r.json().catch(() => ({}));
  if (r.status !== 201) { console.error(`${bad} create failed: ${JSON.stringify(body)}`); return 1; }
  const rec = body as any;
  if (msg && msg.trim()) {
    // Bootstrap message: NOT exclusive — the session is still starting and the
    // dispatch queue owns delivering it once the pane is ready.
    await api("POST", "/send", { session_id: rec.id, text: msg }).catch(() => null);
  }
  if (json) console.log(JSON.stringify(rec));
  else console.log(rec.id);
  return 0;
}

// joy ask <session> <text...> [--timeout secs] [--json]
// Exclusive send + wait for the turn to finish + print the response text.
async function cmdAsk(rest: string[]): Promise<number> {
  const json = takeBool(rest, "--json");
  const timeoutS = Number(takeFlag(rest, "--timeout") ?? 600);
  const [target, ...words] = rest;
  const text = words.join(" ").trim();
  if (!target || !text) { console.error("usage: joy ask <session> <text...> [--timeout secs] [--json]"); return 2; }
  const rec = await resolveSession(target);
  if (!rec) return 1;

  const baseline = (await transcriptLines(rec.id)).length;
  // Open the stop-listener and WAIT for it to connect BEFORE sending, so a fast
  // turn's stop event can't fire in the gap before the stream is listening.
  const controller = new AbortController();
  const { ready, done: stopped } = sseWaitForStop(rec, timeoutS * 1000, controller);
  await ready;

  const r = await api("POST", "/send", { session_id: rec.id, text, exclusive: true }).catch(() => null);
  if (!r) { controller.abort(); console.error(`${bad} daemon not running`); return 1; }
  const body = await r.json().catch(() => ({})) as any;
  if (body.error === "busy") { controller.abort(); console.error(`${bad} session ${rec.id} is busy (mid-turn or queued work)`); return 3; }
  if (body.error === "mode_not_scriptable") {
    controller.abort();
    console.error(`${bad} session ${rec.id} is in "${body.mode}" mode — scripting needs yolo (bypassPermissions) or read-only (plan)`);
    return 5;
  }
  if (!r.ok) { controller.abort(); console.error(`${bad} send failed: ${JSON.stringify(body)}`); return 1; }

  if (!(await stopped)) {
    console.error(`${bad} timed out after ${timeoutS}s waiting for the turn to finish (session ${rec.id})`);
    return 4;
  }
  const response = assistantTextFromLines(await transcriptLines(rec.id), baseline);
  if (json) console.log(JSON.stringify({ ok: true, session: rec.id, response }));
  else console.log(response);
  return 0;
}

// joy send <session> <text...> — exclusive fire-and-forget (no wait).
async function cmdSend(rest: string[]): Promise<number> {
  const [target, ...words] = rest;
  const text = words.join(" ").trim();
  if (!target || !text) { console.error("usage: joy send <session> <text...>"); return 2; }
  const rec = await resolveSession(target);
  if (!rec) return 1;
  const r = await api("POST", "/send", { session_id: rec.id, text, exclusive: true }).catch(() => null);
  if (!r) { console.error(`${bad} daemon not running`); return 1; }
  const body = await r.json().catch(() => ({})) as any;
  if (body.error === "busy") { console.error(`${bad} session ${rec.id} is busy`); return 3; }
  if (body.error === "mode_not_scriptable") { console.error(`${bad} mode "${body.mode}" not scriptable (need yolo or read-only)`); return 5; }
  if (!r.ok) { console.error(`${bad} send failed: ${JSON.stringify(body)}`); return 1; }
  console.log("sent");
  return 0;
}

// joy wait <session> [--timeout secs] — block until the session is idle.
async function cmdWaitIdle(rest: string[]): Promise<number> {
  const timeoutS = Number(takeFlag(rest, "--timeout") ?? 600);
  const target = rest[0];
  if (!target) { console.error("usage: joy wait <session> [--timeout secs]"); return 2; }
  const rec = await resolveSession(target);
  if (!rec) return 1;
  const deadline = Date.now() + timeoutS * 1000;
  for (;;) {
    const r = await api("GET", `/sessions/${rec.id}`).catch(() => null);
    if (!r || !r.ok) { console.error(`${bad} session ${rec.id} gone`); return 1; }
    const s = await r.json() as any;
    if (s.busy === false) return 0;
    const left = deadline - Date.now();
    if (left <= 0) { console.error(`${bad} timed out after ${timeoutS}s (session still busy)`); return 4; }
    // Ride the SSE stop for the next turn end (cheap), bounded by the deadline;
    // then loop to RE-CHECK busy — a stop is per-turn, not "fully idle". Cap the
    // window at 5s so a stop that fired just before we connected (idle already)
    // doesn't stall the loop — the re-check catches it promptly either way.
    const controller = new AbortController();
    await sseWaitForStop(rec, Math.min(left, 5_000), controller).done;
  }
}

// joy log <session> [-n count] — recent user/assistant text from the transcript.
async function cmdLogTail(rest: string[]): Promise<number> {
  const n = Number(takeFlag(rest, "-n") ?? 12);
  const target = rest[0];
  if (!target) { console.error("usage: joy log <session> [-n count]"); return 2; }
  const rec = await resolveSession(target);
  if (!rec) return 1;
  const lines = await transcriptLines(rec.id);
  const out: string[] = [];
  for (const e of lines) {
    const role = e?.message?.role;
    if (role !== "user" && role !== "assistant") continue;
    const content = e.message.content;
    let txt = "";
    if (typeof content === "string") txt = content;
    else if (Array.isArray(content)) txt = content.filter((b: any) => b?.type === "text").map((b: any) => b.text).join(" ");
    txt = txt.trim();
    if (!txt || txt.startsWith("<task-notification>")) continue;
    out.push(`${role === "user" ? c.b("user     ") : c.g("assistant")} ${txt.replace(/\s+/g, " ").slice(0, 200)}`);
  }
  for (const l of out.slice(-n)) console.log(l);
  return 0;
}

// joy kill <session> — end the session (kills its tmux window).
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
  console.log(`${c.b("joy")} — joy-tmux daemon control

${c.b("Usage:")} joy <command>

  ${c.b("start")}        Start the daemon (detached)
  ${c.b("stop")}         Stop the daemon (tmux sessions stay alive)
  ${c.b("restart")}      Restart the daemon (re-exec; running sessions survive)
  ${c.b("status")}       Show daemon status
  ${c.b("list")}         List sessions the daemon is tracking
  ${c.b("jump")}         Attach/switch to a session's tmux window [id|prefix|path; default cwd]

  ${c.b("new")}          Create a session:  joy new <dir> [-m msg] [--model m] [--effort e]
                 [--read-only] [--continue|--resume <id>] [--json]  → prints session id
  ${c.b("ask")}          Send + wait + print the response:  joy ask <session> <text...> [--timeout s] [--json]
  ${c.b("send")}         Send without waiting:  joy send <session> <text...>
  ${c.b("wait")}         Block until the session is idle:  joy wait <session> [--timeout s]
  ${c.b("log")}          Recent conversation:  joy log <session> [-n 12]
  ${c.b("kill")}         End a session:  joy kill <session>
               Scripting contract: sends error when the session is BUSY (exit 3) —
               they never queue — and only yolo / read-only sessions are scriptable
               (exit 5). Exit codes: 0 ok · 1 error · 2 usage · 3 busy · 4 timeout · 5 mode.
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
    case "new": code = await cmdNew(rest); break;
    case "ask": code = await cmdAsk(rest); break;
    case "send": code = await cmdSend(rest); break;
    case "wait": code = await cmdWaitIdle(rest); break;
    case "log": code = await cmdLogTail(rest); break;
    case "kill": code = await cmdKill(rest); break;
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
