// What each session leaves on THIS machine's disk, and how to take it away.
//
// A session's footprint under ~/.joy is scattered by design: its window record
// and queue file in the relay state dir, its relay receipts under the v2 id,
// its media under sessions/<id>, its rows across the ledger's tables, and — on
// a machine that predates the relay-scoped layout — a queue/receipts pair in
// the legacy ~/.joy/state. Nothing ever listed that per session, so the only
// way to know what a machine was carrying was to ssh in and du.
//
// The scan attributes every byte it can to a session id and reports the rest
// as shared (the ledger file, the usage cache, the v1 import) or orphaned (a
// file whose session no record names any more). The nuke removes exactly the
// attributed pieces; shared files are never touched here.

import * as fs from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { joyHomeDir, joySessionDir, joyStateDir, joyRelayKey } from "../paths";
import { deleteWindowRecord, listWindowRecords, type WindowRecord } from "./windowRecord";

export type SessionKind =
  /** The registry holds it and its agent is up. */
  | "running"
  /** The registry holds it but the agent process is gone (the red "detached"). */
  | "detached"
  /** Only files: no registry entry. A tmux server may still be up for it. */
  | "record";

export interface TmuxPane { pid: number | null; command: string; title: string }
export interface TmuxServerInfo {
  label: string;
  alive: boolean;
  windows: number;
  panes: TmuxPane[];
  createdAt: number | null;
  activityAt: number | null;
}

/** A tmux server on the joy socket dir that no session or record owns. */
export interface LooseTmux extends TmuxServerInfo {
  /** The session id the label names, if it parses as one. */
  sessionId: string | null;
  socketPath: string;
}

export interface SessionFootprint {
  id: string;
  v2SessionId: string | null;
  cwd: string;
  title: string | null;
  kind: SessionKind;
  /** A live process in the registry right now (running or detached). */
  live: boolean;
  status: string | null;
  /** This session's own tmux server, when one is up (or its socket lingers). */
  tmux: TmuxServerInfo | null;
  bytes: number;
  files: number;
  ledgerRows: number;
  /** Newest mtime across its files (and the record's updatedAt), epoch ms. */
  newestAt: number | null;
  oldestAt: number | null;
  /** What was found, for the row's detail line. */
  parts: string[];
}

export interface SharedFootprint {
  ledgerBytes: number;
  usageCacheBytes: number;
  importedBytes: number;
  /** Files under the state dirs whose session no record names. */
  orphanBytes: number;
  orphanFiles: number;
}

export interface StorageReport {
  homeDir: string;
  sessions: SessionFootprint[];
  shared: SharedFootprint;
  /** Servers and stale sockets under the tmux socket dir that nothing owns. */
  looseTmux: LooseTmux[];
  totalBytes: number;
}

/** `tmux <args>` — injectable so the scan is testable without tmux. */
export type TmuxRunner = (args: string[]) => { ok: boolean; out: string; err: string };

export const realTmux: TmuxRunner = (args) => {
  const r = spawnSync("tmux", args, { encoding: "utf8", timeout: 5_000 });
  return { ok: r.status === 0, out: r.stdout ?? "", err: r.stderr ?? "" };
};

/** Where tmux keeps its sockets for this user (`-L` labels live here). */
export function tmuxSocketDir(): string {
  const base = process.env.TMUX_TMPDIR || "/tmp";
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  return join(base, `tmux-${uid}`);
}

/** The socket labels a session's server may carry: current and legacy schemes. */
export function tmuxLabelsFor(sessionId: string, relayKey = joyRelayKey()): string[] {
  return [`joy-${sessionId}`, `joy-${relayKey}-s-${sessionId}`];
}

function sessionIdFromLabel(label: string, relayKey: string): string | null {
  let m = /^joy-([0-9a-f]{8})$/.exec(label);
  if (m) return m[1];
  m = new RegExp(`^joy-${relayKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-s-([0-9a-f]{8})$`).exec(label);
  return m ? m[1] : null;
}

/** What one server holds. `alive:false` means the socket file is there but
 *  nothing answers on it — a leftover to unlink, not a session. */
export function inspectTmuxServer(label: string, tmux: TmuxRunner): TmuxServerInfo {
  const ls = tmux(["-L", label, "list-sessions", "-F", "#{session_created}\t#{session_activity}\t#{session_windows}"]);
  if (!ls.ok) return { label, alive: false, windows: 0, panes: [], createdAt: null, activityAt: null };
  let createdAt: number | null = null, activityAt: number | null = null, windows = 0;
  for (const line of ls.out.split("\n").filter(Boolean)) {
    const [c, a, w] = line.split("\t");
    const cs = Number(c) * 1000, as = Number(a) * 1000;
    if (Number.isFinite(cs) && cs > 0) createdAt = createdAt === null ? cs : Math.min(createdAt, cs);
    if (Number.isFinite(as) && as > 0) activityAt = activityAt === null ? as : Math.max(activityAt, as);
    windows += Number(w) || 0;
  }
  const lp = tmux(["-L", label, "list-panes", "-a", "-F", "#{pane_pid}\t#{pane_current_command}\t#{pane_title}"]);
  const panes: TmuxPane[] = lp.ok
    ? lp.out.split("\n").filter(Boolean).map((line) => { const [pid, command, ...title] = line.split("\t"); return { pid: Number(pid) || null, command: command ?? "", title: title.join("\t") }; })
    : [];
  return { label, alive: true, windows, panes, createdAt, activityAt };
}

/** Every joy-labelled socket in the tmux dir: known ids get their server
 *  attached to the session row; the rest are loose. */
export function scanTmux(deps: { socketDir?: string; relayKey?: string; known: Set<string>; tmux?: TmuxRunner }): { byId: Map<string, TmuxServerInfo>; loose: LooseTmux[] } {
  const dir = deps.socketDir ?? tmuxSocketDir();
  const relayKey = deps.relayKey ?? joyRelayKey();
  const tmux = deps.tmux ?? realTmux;
  const byId = new Map<string, TmuxServerInfo>();
  const loose: LooseTmux[] = [];
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return { byId, loose }; }
  for (const label of names) {
    if (!label.startsWith("joy-")) continue;
    const info = inspectTmuxServer(label, tmux);
    const sessionId = sessionIdFromLabel(label, relayKey);
    if (sessionId && deps.known.has(sessionId)) byId.set(sessionId, info);
    else loose.push({ ...info, sessionId, socketPath: join(dir, label) });
  }
  loose.sort((a, b) => Number(b.alive) - Number(a.alive) || (b.activityAt ?? 0) - (a.activityAt ?? 0));
  return { byId, loose };
}

/** Kill a server (if answering) and remove its socket file. Best effort:
 *  a socket that was already gone is not a failure. */
export function killTmuxServer(label: string, deps: { socketDir?: string; tmux?: TmuxRunner } = {}): { label: string; killed: boolean; unlinked: boolean; error?: string } {
  const tmux = deps.tmux ?? realTmux;
  const dir = deps.socketDir ?? tmuxSocketDir();
  const alive = tmux(["-L", label, "list-sessions"]).ok;
  let killed = false, error: string | undefined;
  if (alive) {
    const r = tmux(["-L", label, "kill-server"]);
    killed = r.ok;
    if (!r.ok) error = `kill-server: ${r.err.trim() || "failed"}`;
  }
  let unlinked = false;
  const p = join(dir, label);
  if (fs.existsSync(p)) { try { fs.rmSync(p, { force: true }); unlinked = true; } catch (e) { error = error ?? `unlink: ${e instanceof Error ? e.message : String(e)}`; } }
  return { label, killed, unlinked, ...(error ? { error } : {}) };
}

export interface LedgerLike {
  sessionRowCount(sessionId: string): number;
  forgetSession(sessionId: string): void;
}

export interface LiveSession { id: string; status: string; cwd: string; title?: string | null }

export interface ScanDeps {
  homeDir?: string;
  stateDir?: string;
  legacyStateDir?: string;
  records?: WindowRecord[];
  live: LiveSession[];
  ledger: LedgerLike | null;
  now?: () => number;
  /** tmux socket dir + runner; omit `tmux` to skip the tmux scan entirely (tests without it). */
  tmuxSocketDir?: string;
  tmux?: TmuxRunner | null;
  relayKey?: string;
}

interface DirStat { bytes: number; files: number; newest: number | null; oldest: number | null }

function statPath(p: string): DirStat {
  const out: DirStat = { bytes: 0, files: 0, newest: null, oldest: null };
  const note = (st: fs.Stats) => {
    out.bytes += st.size; out.files += 1;
    const m = st.mtimeMs;
    out.newest = out.newest === null ? m : Math.max(out.newest, m);
    out.oldest = out.oldest === null ? m : Math.min(out.oldest, m);
  };
  let st: fs.Stats;
  try { st = fs.lstatSync(p); } catch { return out; }
  if (st.isFile()) { note(st); return out; }
  if (!st.isDirectory()) return out;
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) { try { note(fs.lstatSync(full)); } catch { /* raced */ } }
    }
  };
  walk(p);
  return out;
}

function merge(into: DirStat, from: DirStat): void {
  into.bytes += from.bytes; into.files += from.files;
  if (from.newest !== null) into.newest = into.newest === null ? from.newest : Math.max(into.newest, from.newest);
  if (from.oldest !== null) into.oldest = into.oldest === null ? from.oldest : Math.min(into.oldest, from.oldest);
}

/** The state-dir files that belong to one session, by its ids. */
function stateFilesFor(stateDir: string, id: string, v2: string | null): Array<{ path: string; label: string }> {
  const out = [
    { path: join(stateDir, `window-${id}.json`), label: "record" },
    { path: join(stateDir, `queue-st-${id}.json`), label: "queue" },
  ];
  if (v2) out.push({ path: join(stateDir, `${v2}.receipts.json`), label: "receipts" });
  return out;
}

export function scanStorage(deps: ScanDeps): StorageReport {
  const homeDir = deps.homeDir ?? joyHomeDir();
  const stateDir = deps.stateDir ?? joyStateDir();
  const legacyStateDir = deps.legacyStateDir ?? join(homeDir, "state");
  const records = deps.records ?? listWindowRecords(stateDir);
  const live = new Map(deps.live.map((s) => [s.id, s]));

  // Every id we can name: live sessions, window records, and media dirs —
  // a media dir with no record is a session whose record was deleted but
  // whose images were not (the pre-#nuke kill never touched sessions/<id>).
  const ids = new Set<string>();
  const byId = new Map<string, { record?: WindowRecord; live?: LiveSession }>();
  for (const r of records) { ids.add(r.id); byId.set(r.id, { ...byId.get(r.id), record: r }); }
  for (const s of deps.live) { ids.add(s.id); byId.set(s.id, { ...byId.get(s.id), live: s }); }
  const sessionsRoot = join(homeDir, "sessions");
  try {
    for (const d of fs.readdirSync(sessionsRoot)) if (/^[0-9a-f]{8}$/.test(d)) { ids.add(d); if (!byId.has(d)) byId.set(d, {}); }
  } catch { /* no media yet */ }

  // tmux: which known ids have a server up, and what is loose.
  const tmuxScan = deps.tmux === null ? { byId: new Map<string, TmuxServerInfo>(), loose: [] as LooseTmux[] }
    : scanTmux({ socketDir: deps.tmuxSocketDir, relayKey: deps.relayKey, known: ids, tmux: deps.tmux });

  const claimed = new Set<string>();
  const sessions: SessionFootprint[] = [];
  for (const id of ids) {
    const { record, live: l } = byId.get(id) ?? {};
    const v2 = record?.v2SessionId ?? null;
    const acc: DirStat = { bytes: 0, files: 0, newest: null, oldest: null };
    const parts: string[] = [];
    const media = statPath(joySessionDir(id) === join(homeDir, "sessions", id) ? join(homeDir, "sessions", id) : join(homeDir, "sessions", id));
    if (media.files > 0) { merge(acc, media); parts.push(`media ${media.files}`); }
    for (const f of stateFilesFor(stateDir, id, v2)) {
      const st = statPath(f.path);
      if (st.files > 0) { merge(acc, st); parts.push(f.label); claimed.add(f.path); }
    }
    const ledgerRows = deps.ledger ? deps.ledger.sessionRowCount(id) : 0;
    if (ledgerRows > 0) parts.push(`ledger ${ledgerRows}`);
    if (record?.updatedAt) acc.newest = acc.newest === null ? record.updatedAt : Math.max(acc.newest, record.updatedAt);
    const tmux = tmuxScan.byId.get(id) ?? null;
    if (tmux?.activityAt) acc.newest = acc.newest === null ? tmux.activityAt : Math.max(acc.newest, tmux.activityAt);
    if (tmux) parts.push(tmux.alive ? `tmux ${tmux.panes.length} pane${tmux.panes.length === 1 ? "" : "s"}` : "stale socket");
    // ended in the registry = the agent process is gone: the red "detached".
    const kind: SessionKind = l ? (l.status === "ended" ? "detached" : "running") : "record";
    sessions.push({
      id, v2SessionId: v2,
      cwd: l?.cwd ?? record?.launchCwd ?? "",
      title: l?.title ?? (record as { lastAiTitle?: string } | undefined)?.lastAiTitle ?? (record as { agentTitle?: string } | undefined)?.agentTitle ?? null,
      kind, live: !!l, status: l?.status ?? null, tmux,
      bytes: acc.bytes, files: acc.files, ledgerRows,
      newestAt: acc.newest, oldestAt: acc.oldest, parts,
    });
  }

  // Shared and orphaned: whatever in the state dirs no session claimed.
  const shared: SharedFootprint = { ledgerBytes: 0, usageCacheBytes: 0, importedBytes: 0, orphanBytes: 0, orphanFiles: 0 };
  const sweep = (dir: string) => {
    let names: string[];
    try { names = fs.readdirSync(dir); } catch { return; }
    for (const name of names) {
      const p = join(dir, name);
      if (claimed.has(p)) continue;
      const st = statPath(p);
      if (st.files === 0) continue;
      if (/^ledger\.sqlite/.test(name)) shared.ledgerBytes += st.bytes;
      else if (name === "usage-cache.json") shared.usageCacheBytes += st.bytes;
      else if (name === "imported-v1") shared.importedBytes += st.bytes;
      else if (/\.(receipts|queue)\.json$|^queue-st-|^window-/.test(name)) { shared.orphanBytes += st.bytes; shared.orphanFiles += st.files; }
      // anything else (settings, keys, locks) is the daemon's own and not counted
    }
  };
  sweep(stateDir);
  if (legacyStateDir !== stateDir) sweep(legacyStateDir);

  sessions.sort((a, b) => b.bytes - a.bytes || (b.newestAt ?? 0) - (a.newestAt ?? 0));
  const totalBytes = sessions.reduce((n, s) => n + s.bytes, 0) + shared.ledgerBytes + shared.usageCacheBytes + shared.importedBytes + shared.orphanBytes;
  return { homeDir, sessions, shared, looseTmux: tmuxScan.loose, totalBytes };
}

export interface NukeResult { id: string; ok: boolean; bytesFreed: number; removed: string[]; error?: string }

/** Remove everything the scan attributed to one session. The record goes
 *  through deleteWindowRecord so a refused unlink is tombstoned, never
 *  silently kept. Shared files are never touched.
 *
 *  The session's own tmux server goes FIRST: a record-only session (nothing
 *  in the registry, so no forceKill ran) can still have its server up, and
 *  deleting the record while it runs would manufacture a loose server. */
export function nukeSessionStorage(id: string, deps: { homeDir?: string; stateDir?: string; records?: WindowRecord[]; ledger: LedgerLike | null; tmux?: TmuxRunner | null; tmuxSocketDir?: string; relayKey?: string }): NukeResult {
  const homeDir = deps.homeDir ?? joyHomeDir();
  const stateDir = deps.stateDir ?? joyStateDir();
  const record = (deps.records ?? listWindowRecords(stateDir)).find((r) => r.id === id);
  const removed: string[] = [];
  let bytesFreed = 0;
  let error: string | undefined;
  if (deps.tmux !== null) {
    for (const label of tmuxLabelsFor(id, deps.relayKey)) {
      const k = killTmuxServer(label, { socketDir: deps.tmuxSocketDir, tmux: deps.tmux });
      if (k.killed) removed.push("tmux");
      else if (k.unlinked) removed.push("socket");
      if (k.error) error = error ?? `tmux ${label}: ${k.error}`;
    }
  }
  const rm = (p: string, label: string) => {
    const st = statPath(p);
    if (st.files === 0) return;
    try { fs.rmSync(p, { recursive: true, force: true }); bytesFreed += st.bytes; removed.push(label); }
    catch (e) { error = `${label}: ${e instanceof Error ? e.message : String(e)}`; }
  };
  rm(join(homeDir, "sessions", id), "media");
  rm(join(stateDir, `queue-st-${id}.json`), "queue");
  if (record?.v2SessionId) rm(join(stateDir, `${record.v2SessionId}.receipts.json`), "receipts");
  // The record last: while it exists a crashed nuke is re-runnable from the page.
  if (fs.existsSync(join(stateDir, `window-${id}.json`))) {
    const st = statPath(join(stateDir, `window-${id}.json`));
    if (deleteWindowRecord(id, stateDir)) { bytesFreed += st.bytes; removed.push("record"); }
    else error = error ?? "record: delete refused (tombstoned)";
  }
  if (deps.ledger) { try { deps.ledger.forgetSession(id); removed.push("ledger"); } catch (e) { error = error ?? `ledger: ${e instanceof Error ? e.message : String(e)}`; } }
  return { id, ok: !error, bytesFreed, removed, ...(error ? { error } : {}) };
}
