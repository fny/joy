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

import { readFileSync, readdirSync, existsSync, statSync } from "fs";
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

/** Every rollout file under sessions/, with its mtime — the ONE index the
 *  reader ranks by. The previous walk enumerated the newest-CREATED day
 *  directories (60 files / 7 days) and only then sorted by mtime, so a
 *  long-running session from an older day — the one actually recording fresh
 *  quota — fell off the candidate list after a week of newer sessions;
 *  raising the cutoff only postponed the same defect (#543). A file's mtime
 *  says nothing about its creation directory, so the index must cover the
 *  whole store: a few thousand readdir/stat calls, milliseconds. */
function indexRollouts(root: string): Array<{ file: string; mtime: number }> {
  const out: Array<{ file: string; mtime: number }> = [];
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
          try { out.push({ file, mtime: statSync(file).mtimeMs }); } catch { /* vanished mid-walk */ }
        }
      }
    }
  }
  return out;
}

/** The last rate_limits event in one rollout, or null. */
function lastRateLimitEvent(file: string): { limits: CodexLimits; at: number } | null {
  let text: string;
  try { text = readFileSync(file, "utf-8"); } catch { return null; }
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"rate_limits"')) continue;
    try {
      const e = JSON.parse(lines[i]);
      const rl = e?.payload?.rate_limits ?? e?.rate_limits;
      if (rl && typeof rl === "object") {
        const ts = typeof e?.timestamp === "string" ? Date.parse(e.timestamp) : NaN;
        return {
          limits: { primary: rl.primary, secondary: rl.secondary, observedAt: e?.timestamp },
          // No usable timestamp → the file's mtime is the best bound on when it was written.
          at: Number.isFinite(ts) ? ts : (() => { try { return statSync(file).mtimeMs; } catch { return 0; } })(),
        };
      }
    } catch { /* keep scanning */ }
  }
  return null;
}

/** How many recently-MODIFIED rollouts to read. The newest observation must
 *  live in one of the most recently written files (a file's mtime is never
 *  older than its last event), so this only needs to cover the number of
 *  codex sessions plausibly writing at once. */
const CODEX_READ_MAX = 8;

/** Default root honours $CODEX_HOME — the store the running codex writes (#546).
 *  Picks the newest OBSERVATION across the most recently MODIFIED rollouts
 *  in the whole store, not the first event in the newest-created file: a
 *  long-running session from an earlier day keeps recording fresh quota
 *  while a session created today may have gone quiet hours ago, and the old
 *  walk returned the stale figure — or, past a few newer files (or days),
 *  never looked at the live rollout at all (#543). */
export function readCodexLimits(root = codexSessionsDir()): { ok: true; limits: CodexLimits } | { ok: false; error: string } {
  if (!existsSync(root)) return { ok: false, error: `no ${root} on this machine` };
  const candidates = indexRollouts(root)
    .sort((a, b) => b.mtime - a.mtime || (a.file < b.file ? 1 : a.file > b.file ? -1 : 0))
    .slice(0, CODEX_READ_MAX);
  let best: { limits: CodexLimits; at: number } | null = null;
  for (const { file } of candidates) {
    const obs = lastRateLimitEvent(file);
    if (obs && (!best || obs.at > best.at)) best = obs;
  }
  return best ? { ok: true, limits: best.limits } : { ok: false, error: "no rate_limits events in recent codex sessions" };
}
