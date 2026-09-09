// Resumable past conversations of ONE harness in ONE directory — the rows the
// new-session page's picker and the projects pages show. Each harness keeps
// its history somewhere else; this is the one place that knows where:
//
//   claude   ~/.claude/projects/<cwd key>/<id>.jsonl      (listLogs + logTitleFor)
//   codex    ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl  (session_meta.cwd)
//   opencode inside its server: GET /api/session filtered by location.directory
//   pi       ~/.pi/agent/sessions/<cwd key>/<ts>_<id>.jsonl (header {"type":"session",cwd})
//   agy      ~/.gemini/antigravity-cli/conversation_summaries.db (SQLite,
//            workspace_uris carries file://<cwd>)
//
// Every lister is best-effort: a store that is absent or unreadable is an
// empty list, never an error the picker has to explain.
import { existsSync, openSync, readSync, closeSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { cwdToTranscriptDir } from "../claude/transcript";
import { logTitleFor } from "../claude/logTitle";
import { listWindowRecords, type WindowRecord } from "./windowRecord";
import type { Harness } from "./harnessCapabilities";

export interface PastSession {
  id: string;
  title: string | null;
  updatedAt: number;
  sizeBytes: number | null;
}

export const PAST_TITLE_MAX = 60;

/** A prompt as a title: a joy peer message is unwrapped to its body; any
 *  other "<…" text is a tool result or CLI wrapper and yields nothing. */
export function promptTitle(text: unknown): string | null {
  if (typeof text !== "string") return null;
  let t = text.trim();
  const wrapped = /^<joy-message\b[^>]*>([\s\S]*?)<\/joy-message>\s*$/.exec(t);
  if (wrapped) t = wrapped[1].trim();
  if (!t || t.startsWith("<")) return null;
  t = t.replace(/\s+/g, " ");
  return t.length > PAST_TITLE_MAX ? t.slice(0, PAST_TITLE_MAX - 1).trimEnd() + "…" : t;
}

/** The complete lines in the first `bytes` of a file. */
export function headLines(file: string, bytes = 16 * 1024): string[] {
  let fd: number | null = null;
  try {
    const size = statSync(file).size;
    fd = openSync(file, "r");
    const buf = Buffer.alloc(Math.min(bytes, size));
    const n = readSync(fd, buf, 0, buf.length, 0);
    const lines = buf.subarray(0, n).toString("utf8").split("\n");
    if (n < size) lines.pop(); // partial last line
    return lines;
  } catch { return []; }
  finally { if (fd !== null) closeSync(fd); }
}

function parse(line: string): Record<string, unknown> | null {
  try { return JSON.parse(line) as Record<string, unknown>; } catch { return null; }
}

// ── claude ──────────────────────────────────────────────────────────────────

export function listClaudePastSessions(cwd: string): PastSession[] {
  const dir = cwdToTranscriptDir(cwd);
  const records = new Map<string, WindowRecord>();
  for (const r of listWindowRecords()) if (r.claudeSessionId) records.set(r.claudeSessionId, r);
  const out: PastSession[] = [];
  try {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".jsonl")) continue;
      try {
        const file = join(dir, f);
        const st = statSync(file);
        const id = f.slice(0, -".jsonl".length);
        out.push({ id, title: logTitleFor(file, records.get(id)).title, updatedAt: st.mtimeMs, sizeBytes: st.size });
      } catch { /* vanished mid-scan */ }
    }
  } catch { /* no transcript dir yet */ }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

// ── pi ──────────────────────────────────────────────────────────────────────

export function piSessionsRoot(): string { return join(homedir(), ".pi", "agent", "sessions"); }

/** pi's per-cwd directory name: "/tmp/joy-smoke" → "--tmp-joy-smoke--". */
export function piCwdKey(cwd: string): string {
  return "-" + cwd.replace(/\//g, "-") + "--";
}

export function listPiPastSessions(cwd: string, root = piSessionsRoot()): PastSession[] {
  const dir = join(root, piCwdKey(cwd));
  const out: PastSession[] = [];
  let files: string[];
  try { files = readdirSync(dir); } catch { return out; }
  for (const f of files) {
    if (!f.endsWith(".jsonl")) continue;
    const file = join(dir, f);
    let st;
    try { st = statSync(file); } catch { continue; }
    const lines = headLines(file);
    const header = lines.length ? parse(lines[0]) : null;
    if (!header || header.type !== "session" || typeof header.id !== "string") continue;
    // The key is derived; the header is authoritative (a key collision
    // between "/a/b-c" and "/a/b/c" must not list the wrong cwd).
    if (typeof header.cwd === "string" && header.cwd !== cwd) continue;
    let title: string | null = null;
    for (const line of lines) {
      const e = parse(line);
      if (!e) continue;
      if (e.type === "session_name" && typeof (e as { name?: unknown }).name === "string") { title = promptTitle((e as { name: string }).name) ?? title; break; }
      if (e.type !== "message") continue;
      const msg = e.message as { role?: string; content?: unknown } | undefined;
      if (msg?.role !== "user") continue;
      const c = msg.content;
      let text = "";
      if (typeof c === "string") text = c;
      else if (Array.isArray(c)) for (const p of c) if (p && typeof p === "object" && (p as { type?: unknown }).type === "text" && typeof (p as { text?: unknown }).text === "string") text += "\n" + (p as { text: string }).text;
      const t = promptTitle(text);
      if (t) { title = t; break; }
    }
    out.push({ id: header.id, title, updatedAt: st.mtimeMs, sizeBytes: st.size });
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

// ── agy ─────────────────────────────────────────────────────────────────────

export function agyCliDir(home = homedir()): string { return join(home, ".gemini", "antigravity-cli"); }

/** agy's "2026-06-26 00:57:24.674405115+00:00" → ms epoch (Date.parse cannot
 *  take a nine-digit fraction). */
export function parseAgyTime(s: unknown): number {
  if (typeof s !== "string") return 0;
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d+))?\s*(Z|[+-]\d{2}:?\d{2})?$/.exec(s.trim());
  if (!m) { const t = Date.parse(s); return Number.isNaN(t) ? 0 : t; }
  const frac = (m[3] ?? "").slice(0, 3).padEnd(3, "0");
  const tz = m[4] ? m[4].replace(/^([+-]\d{2})(\d{2})$/, "$1:$2") : "Z";
  const t = Date.parse(`${m[1]}T${m[2]}.${frac}${tz}`);
  return Number.isNaN(t) ? 0 : t;
}

export function listAgyPastSessions(cwd: string, dir = agyCliDir()): PastSession[] {
  const db = join(dir, "conversation_summaries.db");
  if (!existsSync(db)) return [];
  type Row = { conversation_id: string; title: string; preview: string; last_modified_time: string; workspace_uris: string };
  let rows: Row[];
  try {
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as { DatabaseSync: new (p: string, o?: { readOnly?: boolean }) => { prepare(sql: string): { all(...a: unknown[]): unknown[] }; close(): void } };
    const conn = new DatabaseSync(db, { readOnly: true });
    try {
      rows = conn.prepare(
        "select conversation_id, title, preview, last_modified_time, workspace_uris from conversation_summaries where workspace_uris like ? order by last_modified_time desc limit 500",
      ).all(`%"file://${cwd}"%`) as Row[];
    } finally { conn.close(); }
  } catch { return []; }
  const out: PastSession[] = [];
  for (const r of rows) {
    // LIKE matched a substring: confirm the exact uri (a parent dir would match its children).
    let uris: unknown;
    try { uris = JSON.parse(r.workspace_uris); } catch { uris = null; }
    if (!Array.isArray(uris) || !uris.includes(`file://${cwd}`)) continue;
    const title = promptTitle(r.title) ?? promptTitle(r.preview);
    let sizeBytes: number | null = null;
    try { sizeBytes = statSync(join(dir, "conversations", `${r.conversation_id}.db`)).size; } catch { /* summary only */ }
    out.push({ id: r.conversation_id, title, updatedAt: parseAgyTime(r.last_modified_time), sizeBytes });
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

// ── dispatch ────────────────────────────────────────────────────────────────

export async function listPastSessions(harness: Harness, cwd: string): Promise<PastSession[]> {
  switch (harness) {
    case "claude": return listClaudePastSessions(cwd);
    case "pi": return listPiPastSessions(cwd);
    case "agy": return listAgyPastSessions(cwd);
    case "codex": {
      const { listCodexThreadsForCwd } = await import("../codex/codexThreads");
      return listCodexThreadsForCwd(cwd);
    }
    case "opencode": {
      const { listOpencodeSessionsForCwd } = await import("../opencode/opencodeClient");
      const rows = await listOpencodeSessionsForCwd(cwd);
      return rows.map((r) => ({ id: r.id, title: promptTitle(r.title) ?? (r.title || null), updatedAt: r.updatedAt, sizeBytes: null }));
    }
  }
}
