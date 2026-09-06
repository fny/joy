// Account rate-limit / quota windows — SERVER truth, unlike usage.ts which
// derives cost stats from local transcripts. This is the data source the
// "Claude Code Usage" / ccusage-style ecosystem apps converged on:
//
//   claude — GET https://api.anthropic.com/api/oauth/usage using the LOCAL
//     Claude Code OAuth token (env CLAUDE_CODE_OAUTH_TOKEN, then
//     ~/.claude/.credentials.json, then the macOS Keychain). Requires the
//     `anthropic-beta: oauth-2025-04-20` header and a claude-code User-Agent
//     (anonymous UAs land in an aggressively rate-limited bucket). Response:
//     five_hour / seven_day / seven_day_opus / seven_day_sonnet buckets of
//     { utilization: 0-100, resets_at: ISO } (null when inactive) + extra_usage.
//     No credential prompt needed — the daemon sits next to the credentials.
//
//   codex — the newest ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl carries
//     token_count events with a rate_limits object ({ primary, secondary }
//     windows: used_percent + window_minutes + resets_in_seconds/resets_at);
//     exactly what the /status TUI renders. Read locally, no API call.

import { readFileSync, readdirSync, existsSync, statSync, openSync, readSync, closeSync } from "fs";
import { join } from "path";
import { homedir, platform } from "os";
import { execSync } from "child_process";
import { codexSessionsDir } from "../codex/codexHome";

// ── claude ───────────────────────────────────────────────────────────────────

function claudeOauthToken(): string | null {
  const env = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (env) return env;
  try {
    const raw = JSON.parse(readFileSync(join(homedir(), ".claude", ".credentials.json"), "utf-8"));
    const tok = raw?.claudeAiOauth?.accessToken;
    if (typeof tok === "string" && tok) return tok;
  } catch { /* fall through */ }
  if (platform() === "darwin") {
    try {
      const out = execSync('security find-generic-password -s "Claude Code-credentials" -w', { encoding: "utf8", timeout: 3000 });
      const tok = JSON.parse(out.trim())?.claudeAiOauth?.accessToken;
      if (typeof tok === "string" && tok) return tok;
    } catch { /* no keychain entry */ }
  }
  return null;
}

let claudeVersionCache: string | null = null;
function claudeUserAgent(): string {
  if (!claudeVersionCache) {
    try {
      // "2.1.3 (Claude Code)" → "2.1.3"
      const v = execSync("claude --version", { encoding: "utf8", timeout: 8000 }).trim().split(/\s/)[0];
      claudeVersionCache = /^\d/.test(v) ? v : "2.0.0";
    } catch {
      claudeVersionCache = "2.0.0";
    }
  }
  return `claude-code/${claudeVersionCache}`;
}

export interface ClaudeLimitBucket { utilization: number; resets_at: string }
export interface ClaudeLimits {
  five_hour?: ClaudeLimitBucket | null;
  seven_day?: ClaudeLimitBucket | null;
  seven_day_opus?: ClaudeLimitBucket | null;
  seven_day_sonnet?: ClaudeLimitBucket | null;
  extra_usage?: Record<string, unknown> | null;
}

// The endpoint rate-limits aggressively; poll ~3min max. Cache both success
// and failure (a 429 retried every tap makes it worse).
type ClaudeLimitsResult = { ok: true; limits: ClaudeLimits } | { ok: false; error: string };
let claudeCache: { at: number; result: ClaudeLimitsResult } | null = null;
// The ONE refresh in flight. Callers arriving while it runs await the same
// promise: two taps after the cache expired used to hit the endpoint twice,
// and the later one's 429 overwrote the success and was served for three
// minutes (#545). One refresh → one cache update.
let claudeInflight: Promise<ClaudeLimitsResult> | null = null;
const CLAUDE_CACHE_MS = 3 * 60 * 1000;

export async function fetchClaudeLimits(): Promise<ClaudeLimitsResult> {
  if (claudeCache && Date.now() - claudeCache.at < CLAUDE_CACHE_MS) return claudeCache.result;
  if (claudeInflight) return claudeInflight;
  const compute = async (): Promise<ClaudeLimitsResult> => {
    const token = claudeOauthToken();
    if (!token) return { ok: false, error: "no Claude Code OAuth credentials on this machine (~/.claude/.credentials.json)" };
    const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
      headers: {
        "Authorization": `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
        "User-Agent": claudeUserAgent(),
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return { ok: false, error: `usage endpoint HTTP ${res.status}` };
    return { ok: true, limits: await res.json() as ClaudeLimits };
  };
  claudeInflight = compute()
    .catch((e) => ({ ok: false as const, error: String(e) }))
    .then((result) => { claudeCache = { at: Date.now(), result }; return result; })
    .finally(() => { claudeInflight = null; });
  return claudeInflight;
}

/** One normalized quota row for the app (see joy-app settings/limits). */
export interface ClaudeLimitRow {
  id: string;
  kind: "window";
  usedPercent: number;
  resetsAt: string | null;
  /** Model scope for a scoped window ("Fable", "Opus"), else undefined. */
  scope?: string;
  unit: "percent";
}

const CLAUDE_BUCKETS = ["five_hour", "seven_day", "seven_day_opus", "seven_day_sonnet"] as const;

/**
 * Rows from the usage API response. Two sources, combined:
 *  - the KNOWN top-level buckets (five_hour, seven_day, …) — never the
 *    codenamed experiments beside them (nimbus_quill, tangelo, …), which
 *    used to render as bare ids at 0%;
 *  - the structured `limits` array, the only place a MODEL-SCOPED window
 *    lives: `{kind:"weekly_scoped", percent, scope:{model:{display_name}}}`.
 *    Fable's weekly limit is one of these (68% on 2026-09-03 while the app
 *    showed only the two unscoped bars). Unscoped entries there (session,
 *    weekly_all) duplicate the buckets and are skipped.
 */
export function claudeLimitRows(raw: unknown): ClaudeLimitRow[] {
  const r = (raw ?? {}) as Record<string, unknown>;
  const rows: ClaudeLimitRow[] = [];
  for (const id of CLAUDE_BUCKETS) {
    const w = r[id] as { utilization?: number; resets_at?: string } | null | undefined;
    if (!w || typeof w !== "object" || typeof w.utilization !== "number") continue;
    rows.push({ id, kind: "window", usedPercent: w.utilization, resetsAt: w.resets_at ?? null, scope: id.includes("opus") ? "Opus" : id.includes("sonnet") ? "Sonnet" : undefined, unit: "percent" });
  }
  const list = Array.isArray(r.limits) ? (r.limits as unknown[]) : [];
  for (const raw of list) {
    // Every entry is server data: a null row or a numeric display_name used
    // to throw here and lose the whole response's valid rows (#544).
    if (!raw || typeof raw !== "object") continue;
    const e = raw as Record<string, unknown>;
    const scope = (e.scope as { model?: { display_name?: unknown } | null } | null | undefined)?.model?.display_name;
    if (typeof scope !== "string" || !scope.trim() || typeof e.percent !== "number") continue;
    rows.push({
      id: `${String(e.kind ?? "scoped")}:${scope.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
      kind: "window", usedPercent: e.percent,
      resetsAt: typeof e.resets_at === "string" ? e.resets_at : null,
      scope, unit: "percent",
    });
  }
  return rows;
}

// ── codex ────────────────────────────────────────────────────────────────────

export interface CodexLimitWindow {
  used_percent?: number;
  window_minutes?: number;
  resets_in_seconds?: number;
  resets_at?: number;
}
export interface CodexLimits {
  primary?: CodexLimitWindow;
  secondary?: CodexLimitWindow;
  /** Timestamp of the rollout event the data came from (staleness signal). */
  observedAt?: string;
}

/** Every rollout file under sessions/, with its mtime and size — the ONE
 *  listing the reader ranks by. The previous walk enumerated the newest-
 *  CREATED day directories (60 files / 7 days) and only then sorted by
 *  mtime, so a long-running session from an older day — the one actually
 *  recording fresh quota — fell off the candidate list after a week of newer
 *  sessions; raising the cutoff only postponed the same defect (#543). A
 *  file's mtime says nothing about its creation directory, so the listing
 *  must cover the whole store: a few thousand readdir/stat calls,
 *  milliseconds — and no file CONTENT is read here. */
function listRollouts(root: string): Array<{ file: string; mtime: number; size: number }> {
  const out: Array<{ file: string; mtime: number; size: number }> = [];
  const list = (dir: string) => { try { return readdirSync(dir, { withFileTypes: true }); } catch { return []; } };
  for (const y of list(root)) {
    if (!y.isDirectory()) continue;
    for (const m of list(join(root, y.name))) {
      if (!m.isDirectory()) continue;
      for (const d of list(join(root, y.name, m.name))) {
        if (!d.isDirectory()) continue;
        const dayDir = join(root, y.name, m.name, d.name);
        for (const f of list(dayDir)) {
          if (!f.isFile() || !f.name.endsWith(".jsonl")) continue;
          const file = join(dayDir, f.name);
          try { const st = statSync(file); out.push({ file, mtime: st.mtimeMs, size: st.size }); } catch { /* vanished mid-walk */ }
        }
      }
    }
  }
  return out;
}

type CodexObservation = { limits: CodexLimits; at: number };

/** Parse one rollout line as a rate_limits event, or null. */
function rateLimitEvent(line: string, mtime: number): CodexObservation | null {
  if (!line.includes('"rate_limits"')) return null;
  try {
    const e = JSON.parse(line);
    const rl = e?.payload?.rate_limits ?? e?.rate_limits;
    if (!rl || typeof rl !== "object") return null;
    const ts = typeof e?.timestamp === "string" ? Date.parse(e.timestamp) : NaN;
    return {
      limits: { primary: rl.primary, secondary: rl.secondary, observedAt: e?.timestamp },
      // No usable timestamp → the file's mtime is the best bound on when it was written.
      at: Number.isFinite(ts) ? ts : mtime,
    };
  } catch { return null; }
}

/** Bytes read per step of the backward scan, and the most a single refresh
 *  reads from one file. Codex writes a rate_limits event with every
 *  token_count, so the newest one sits within the last few KiB of a live
 *  rollout; the cap keeps a pathological file from being read whole. */
const TAIL_CHUNK = 256 * 1024;
const TAIL_MAX = 4 * 1024 * 1024;
const NL = 0x0a;

/** The LAST rate_limits event in `file` between byte offsets `from` and
 *  `size`, found by reading the region backward in chunks, plus how far the
 *  complete lines reach (`scannedTo`): a trailing partial line — codex mid-
 *  append — is not consumed, so the next refresh re-reads it whole. */
function scanTail(file: string, from: number, size: number, mtime: number): { obs: CodexObservation | null; scannedTo: number } {
  let fd: number;
  try { fd = openSync(file, "r"); } catch { return { obs: null, scannedTo: from }; }
  try {
    let pos = size;
    let carry = Buffer.alloc(0);       // the partial line straddling the chunk boundary
    let scannedTo = from;
    let read = 0;
    let first = true;
    while (pos > from && read < TAIL_MAX) {
      const chunkStart = Math.max(from, pos - TAIL_CHUNK);
      const chunk = Buffer.alloc(pos - chunkStart);
      let n: number;
      try { n = readSync(fd, chunk, 0, chunk.length, chunkStart); } catch { return { obs: null, scannedTo: from }; }
      read += n;
      let buf = Buffer.concat([chunk.subarray(0, n), carry]);
      if (first) {
        first = false;
        const lastNl = buf.lastIndexOf(NL);
        if (lastNl < 0) { carry = buf; pos = chunkStart; continue; }
        scannedTo = chunkStart + lastNl + 1;
        buf = buf.subarray(0, lastNl + 1);
      }
      let lineStart = 0;
      if (chunkStart > from) {
        const nl = buf.indexOf(NL);
        if (nl < 0) { carry = buf; pos = chunkStart; continue; }
        carry = buf.subarray(0, nl);
        lineStart = nl + 1;
      } else {
        carry = Buffer.alloc(0);
      }
      const text = buf.subarray(lineStart).toString("utf8");
      const lines = text.split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        const obs = rateLimitEvent(lines[i], mtime);
        if (obs) return { obs, scannedTo };
      }
      pos = chunkStart;
    }
    return { obs: null, scannedTo };
  } finally {
    try { closeSync(fd); } catch { /* best effort */ }
  }
}

/** Per-file observation index: what the file last reported and how much of
 *  it has been read, keyed by path and refreshed when mtime/size move. A
 *  request only READS files whose mtime says they changed — and, of those,
 *  only the bytes appended since the last read (rollouts are append-only) —
 *  so the historical store is never re-read per request. Evicted when the
 *  file disappears from the listing. */
interface CodexIndexEntry { mtime: number; size: number; scannedTo: number; obs: CodexObservation | null }

/** A filesystem with coarse timestamps (HFS+ 1 s, FAT 2 s) can report an
 *  mtime slightly BEFORE the event that produced it; the stop rule allows
 *  this much so such a file is still read. Costs at most a few extra reads
 *  of files written within the same seconds as the best observation — the
 *  ones worth reading anyway, and cached by the index. */
const MTIME_SLACK_MS = 2000;
const codexIndex = new Map<string, CodexIndexEntry>();

function refreshIndex(f: { file: string; mtime: number; size: number }): CodexIndexEntry {
  const prev = codexIndex.get(f.file);
  if (prev && prev.mtime === f.mtime && prev.size === f.size) return prev;
  // Grown in place → only the appended bytes can hold a newer event; the
  // previous observation stands unless one of them beats it. Shrunk or
  // rewritten → start over from the tail.
  const appended = prev && f.size >= prev.size ? prev.scannedTo : 0;
  const { obs, scannedTo } = scanTail(f.file, appended, f.size, f.mtime);
  const entry: CodexIndexEntry = {
    mtime: f.mtime,
    size: f.size,
    scannedTo,
    obs: obs ?? (prev && f.size >= prev.size ? prev.obs : null),
  };
  codexIndex.set(f.file, entry);
  return entry;
}

/** Default root honours $CODEX_HOME — the store the running codex writes (#546).
 *  Picks the newest OBSERVATION in the whole store, not the first event in
 *  the newest-created file: a long-running session from an earlier day keeps
 *  recording fresh quota while a session created today may have gone quiet
 *  hours ago, and the old walk returned the stale figure — or, past a few
 *  newer files (or days), never looked at the live rollout at all (#543).
 *
 *  Files are visited in descending mtime order and the scan stops as soon as
 *  the remaining files cannot beat the best observation seen: a file's mtime
 *  is never older than its last event, so once every unvisited file was
 *  modified at or before the best observation's timestamp, none of them can
 *  hold a newer one. A fixed candidate count could not establish that — eight
 *  rollouts receiving ordinary message appends after the live session's last
 *  quota event pushed it off the list (#543 residual). */
export function readCodexLimits(root = codexSessionsDir()): { ok: true; limits: CodexLimits } | { ok: false; error: string } {
  if (!existsSync(root)) return { ok: false, error: `no ${root} on this machine` };
  const files = listRollouts(root)
    .sort((a, b) => b.mtime - a.mtime || (a.file < b.file ? 1 : a.file > b.file ? -1 : 0));
  const live = new Set(files.map((f) => f.file));
  for (const path of codexIndex.keys()) if (!live.has(path)) codexIndex.delete(path);
  let best: CodexObservation | null = null;
  for (const f of files) {
    if (best && f.mtime + MTIME_SLACK_MS <= best.at) break;
    const { obs } = refreshIndex(f);
    if (obs && (!best || obs.at > best.at)) best = obs;
  }
  return best ? { ok: true, limits: best.limits } : { ok: false, error: "no rate_limits events in recent codex sessions" };
}
