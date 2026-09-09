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
import { joyHomeDir, joySessionDir, joyStateDir } from "../paths";
import { deleteWindowRecord, listWindowRecords, type WindowRecord } from "./windowRecord";

export interface SessionFootprint {
  id: string;
  v2SessionId: string | null;
  cwd: string;
  title: string | null;
  /** A live process in the registry right now (active or detached). */
  live: boolean;
  status: string | null;
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
  totalBytes: number;
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
    sessions.push({
      id, v2SessionId: v2,
      cwd: l?.cwd ?? record?.launchCwd ?? "",
      title: l?.title ?? (record as { lastAiTitle?: string } | undefined)?.lastAiTitle ?? (record as { agentTitle?: string } | undefined)?.agentTitle ?? null,
      live: !!l, status: l?.status ?? null,
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
  return { homeDir, sessions, shared, totalBytes };
}

export interface NukeResult { id: string; ok: boolean; bytesFreed: number; removed: string[]; error?: string }

/** Remove everything the scan attributed to one session. The record goes
 *  through deleteWindowRecord so a refused unlink is tombstoned, never
 *  silently kept. Shared files are never touched. */
export function nukeSessionStorage(id: string, deps: { homeDir?: string; stateDir?: string; records?: WindowRecord[]; ledger: LedgerLike | null }): NukeResult {
  const homeDir = deps.homeDir ?? joyHomeDir();
  const stateDir = deps.stateDir ?? joyStateDir();
  const record = (deps.records ?? listWindowRecords(stateDir)).find((r) => r.id === id);
  const removed: string[] = [];
  let bytesFreed = 0;
  let error: string | undefined;
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
