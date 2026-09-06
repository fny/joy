// Self-contained usage/cost stats computed straight from Claude Code's
// transcript JSONL — no external tools. This is the backbone behind the
// joy-usage / joy-session-usage ops.
//
// Methodology (validated against LiteLLM on 2026-06-10 — totals
// matched within clock drift):
//   - Walk ~/.claude/projects/**/*.jsonl, including <session>/subagents/
//     agent-*.jsonl (subagent burn is attributed to the parent session).
//   - Dedup assistant entries by message.id, last entry wins — one API call
//     emits one entry per content block, each repeating the same usage.
//   - Price 5m and 1h cache writes separately (1h costs 2x input, 5m 1.25x).
//   - costUSD is not present in current transcripts; rates below are a
//     snapshot of LiteLLM's model_prices table (matched by family prefix so
//     point releases inherit their family's pricing).

import { readFile } from "fs/promises";
import { readdirSync, statSync, existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { joyStateDir } from "../paths";

/** USD per 1M tokens. */
export interface Rates {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

// Ordered: first match wins. Opus split at 4-5 where Anthropic dropped the
// price from $15/$75 to $5/$25.
const MODEL_RATES: Array<[RegExp, Rates]> = [
  [/^claude-fable/, { input: 10, output: 50, cacheRead: 1, cacheWrite5m: 12.5, cacheWrite1h: 20 }],
  [/^claude-opus-4-[5-9]/, { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 }],
  [/^claude-opus/, { input: 15, output: 75, cacheRead: 1.5, cacheWrite5m: 18.75, cacheWrite1h: 30 }],
  [/^claude-sonnet/, { input: 3, output: 15, cacheRead: 0.3, cacheWrite5m: 3.75, cacheWrite1h: 6 }],
  [/^claude-haiku/, { input: 1, output: 5, cacheRead: 0.1, cacheWrite5m: 1.25, cacheWrite1h: 2 }],
];

export function ratesFor(model: string): Rates | null {
  for (const [re, rates] of MODEL_RATES) if (re.test(model)) return rates;
  return null;
}

/** 'claude-fable-5' → 'Fable 5', 'claude-haiku-4-5-20251001' → 'Haiku 4.5' */
export function prettyModelName(model: string): string {
  const m = /^claude-([a-z]+)-([\d-]+)/.exec(model);
  if (!m) return model;
  const version = m[2].replace(/-\d{8}$/, "").replace(/-/g, ".");
  return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${version}`;
}

interface Tok {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  calls: number;
}

const zeroTok = (): Tok => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, calls: 0 });

function addUsage(t: Tok, model: string, u: Record<string, any>): void {
  const cc = (u.cache_creation ?? {}) as Record<string, number>;
  const input = u.input_tokens ?? 0;
  const output = u.output_tokens ?? 0;
  const cacheRead = u.cache_read_input_tokens ?? 0;
  // Older transcripts only have the combined cache_creation_input_tokens;
  // treat it as 5m (the default TTL) when the split is absent.
  const cw5 = cc.ephemeral_5m_input_tokens ?? (cc.ephemeral_1h_input_tokens != null ? 0 : (u.cache_creation_input_tokens ?? 0));
  const cw1 = cc.ephemeral_1h_input_tokens ?? 0;
  t.input += input;
  t.output += output;
  t.cacheRead += cacheRead;
  t.cacheWrite += cw5 + cw1;
  t.calls += 1;
  const r = ratesFor(model);
  if (r) {
    t.cost += (input * r.input + output * r.output + cacheRead * r.cacheRead + cw5 * r.cacheWrite5m + cw1 * r.cacheWrite1h) / 1e6;
  }
}

function addTok(dst: Tok, src: Tok): void {
  dst.input += src.input;
  dst.output += src.output;
  dst.cacheRead += src.cacheRead;
  dst.cacheWrite += src.cacheWrite;
  dst.cost += src.cost;
  dst.calls += src.calls;
}

/** One API call: the assistant message.id with its FINAL usage, priced. */
interface Msg {
  id: string;
  /** YYYY-MM-DD local, "" when the entry had no parseable timestamp. */
  day: string;
  model: string;
  tok: Tok;
}

interface FileAgg {
  path: string;
  mtimeMs: number;
  size: number;
  /** File creation time (0 where the filesystem has none) — the ownership
   *  order for history shared across files (#491). */
  birthtimeMs: number;
  /** Parent session id — directory name for subagents/, filename otherwise. */
  sessionId: string;
  /** <session>/subagents/agent-*.jsonl — carries no cwd of its own (#493). */
  subagent: boolean;
  project: string;
  firstTs: number;
  lastTs: number;
  /** One per distinct message.id in this file. The identity is KEPT (not
   *  folded into per-day totals at parse time) so computeUsage can dedupe the
   *  same API call appearing in several files (#491). */
  msgs: Msg[];
  /** YYYY-MM-DD → user prompt count */
  perDayTurns: Map<string, number>;
  /** Every tool_use block, with its day so a date-ranged query can drop the
   *  out-of-range ones (#490) and its block id so a call copied into another
   *  transcript along with its message is counted once (#491). */
  tools: ToolCall[];
}

interface ToolCall {
  /** The tool_use block id (null when the transcript carries none). */
  id: string | null;
  day: string;
  name: string;
}

function localDay(ts: string): string {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Claude Code's own envelopes around user-role entries: slash-command
 *  machinery, `!cmd` capture, hook/system injections, background-task
 *  completions. Matched by NAME — a bare "starts with <" test also rejected a
 *  person pasting HTML/XML (`<div>Explain this HTML</div>` counted zero turns). */
const SYNTHETIC_WRAPPERS = [
  "command-name", "command-message", "command-args",
  "local-command-stdout", "local-command-stderr", "local-command-caveat",
  "bash-input", "bash-stdout", "bash-stderr",
  "system-reminder", "task-notification", "user-prompt-submit-hook",
];
const SYNTHETIC_RE = new RegExp(`^\\s*<(?:${SYNTHETIC_WRAPPERS.join("|")})(?=[\\s>/])`, "i");

/** Is this user entry a prompt the person typed (or pasted), as opposed to a
 *  tool_result, an entry flagged synthetic by its metadata (isMeta, the
 *  compaction summary), or a CLI/system envelope whose text opens with one of
 *  the KNOWN wrapper tags above? Those were counted as turns and inflated the
 *  prompt totals (#492); ordinary HTML/XML a person typed is a prompt. */
function isRealPrompt(e: Record<string, any>): boolean {
  if (e.isMeta || e.isCompactSummary) return false;
  const c = e.message?.content;
  const realText = (s: unknown) => typeof s === "string" && s.trim().length > 0 && !SYNTHETIC_RE.test(s);
  if (typeof c === "string") return realText(c);
  if (!Array.isArray(c)) return false;
  return c.some((b: any) => b?.type === "image" || (b?.type === "text" && realText(b.text)));
}

async function parseFile(path: string, sessionId: string, subagent: boolean): Promise<FileAgg> {
  const st = statSync(path);
  const agg: FileAgg = {
    path,
    mtimeMs: st.mtimeMs,
    size: st.size,
    birthtimeMs: st.birthtimeMs,
    sessionId,
    subagent,
    project: "",
    firstTs: Infinity,
    lastTs: 0,
    msgs: [],
    perDayTurns: new Map(),
    tools: [],
  };

  // message.id → final usage (entries for the same message repeat usage;
  // the last one carries the final token counts).
  const messages = new Map<string, { model: string; usage: Record<string, unknown>; day: string }>();

  const text = await readFile(path, "utf-8");
  for (const line of text.split("\n")) {
    if (!line) continue;
    const isAssistant = line.includes('"assistant"');
    const isUser = line.includes('"user"');
    if (!isAssistant && !isUser) continue;
    let e: Record<string, any>;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    const ts = typeof e.timestamp === "string" ? e.timestamp : "";
    const msg = e.message ?? {};

    if (e.type === "assistant") {
      const t = Date.parse(ts);
      if (!isNaN(t)) {
        if (t < agg.firstTs) agg.firstTs = t;
        if (t > agg.lastTs) agg.lastTs = t;
      }
      if (!agg.project && typeof e.cwd === "string" && e.cwd) agg.project = e.cwd;
      // Tool calls are collected across ALL entries — each entry carries the
      // message's new content block, so blocks never repeat within a file.
      // Kept with their day (#490) and block id (#491) for computeUsage.
      if (Array.isArray(msg.content)) {
        const day = localDay(ts);
        for (const block of msg.content) {
          if (block?.type !== "tool_use" || typeof block.name !== "string") continue;
          agg.tools.push({ id: typeof block.id === "string" && block.id ? block.id : null, day, name: block.name });
        }
      }
      if (msg.usage && typeof msg.id === "string" && typeof msg.model === "string" && msg.model !== "<synthetic>") {
        messages.set(msg.id, { model: msg.model, usage: msg.usage, day: localDay(ts) });
      }
    } else if (e.type === "user" && e.isSidechain !== true && msg.role === "user") {
      if (isRealPrompt(e)) {
        const day = localDay(ts);
        if (day) agg.perDayTurns.set(day, (agg.perDayTurns.get(day) ?? 0) + 1);
      }
    }
  }

  for (const [id, { model, usage, day }] of messages) {
    const tok = zeroTok();
    addUsage(tok, model, usage as Record<string, any>);
    agg.msgs.push({ id, day, model, tok });
  }

  return agg;
}

// Per-file cache keyed by path; reparse only when mtime/size move. Transcripts
// are append-only, so this makes every query after the first one cheap.
const fileCache = new Map<string, FileAgg>();

// ── disk persistence ─────────────────────────────────────────────────────────
// The in-memory cache dies with the daemon, so the first usage query after a
// restart used to re-parse EVERY transcript (seconds of wall time on months of
// history — the reason a native binary was considered; the persistent cache
// makes it moot). The cache round-trips to ~/.joy/usage-cache.json: loaded
// lazily on the first computeUsage, saved whenever a compute actually parsed
// files. A background refresh (see server.ts) recomputes every 2h so the cache
// is warm before anyone asks.
// 2: per-message identities + per-day tools/mcp + subagent/birthtime fields
//    (#490 #491 #493) — an older cache is simply discarded and re-parsed.
// 3: tool calls keep their block ids so copied history dedupes (#491).
const CACHE_FORMAT = 3;

type FileAggJson = Omit<FileAgg, "perDayTurns"> & {
  perDayTurns: Array<[string, number]>;
};

function usageCachePath(): string {
  return join(joyStateDir(), "usage-cache.json");
}

let diskCacheLoaded = false;
function loadDiskCacheOnce(): void {
  if (diskCacheLoaded) return;
  diskCacheLoaded = true;
  try {
    const raw = JSON.parse(readFileSync(usageCachePath(), "utf-8")) as { format?: number; files?: Record<string, FileAggJson> };
    if (raw.format !== CACHE_FORMAT || !raw.files) return;
    for (const [path, j] of Object.entries(raw.files)) {
      fileCache.set(path, {
        ...j,
        path,
        perDayTurns: new Map(j.perDayTurns),
      });
    }
  } catch { /* no cache yet, or unreadable — cold parse repopulates it */ }
}

function saveDiskCache(): void {
  try {
    const files: Record<string, FileAggJson> = {};
    for (const [path, agg] of fileCache) {
      files[path] = {
        ...agg,
        perDayTurns: [...agg.perDayTurns],
      };
    }
    mkdirSync(joyStateDir(), { recursive: true });
    // Atomic-ish: write a sibling then rename, so a crash mid-write never
    // leaves a truncated cache that poisons the next boot.
    const tmp = usageCachePath() + ".tmp";
    writeFileSync(tmp, JSON.stringify({ format: CACHE_FORMAT, files }));
    renameSync(tmp, usageCachePath());
  } catch (e) {
    process.stderr.write(`[usage] cache save failed: ${e}\n`);
  }
}

function listTranscripts(root: string): Array<{ path: string; sessionId: string; subagent: boolean }> {
  const out: Array<{ path: string; sessionId: string; subagent: boolean }> = [];
  if (!existsSync(root)) return out;
  for (const proj of readdirSync(root)) {
    const projDir = join(root, proj);
    let entries: string[];
    try {
      entries = readdirSync(projDir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const p = join(projDir, entry);
      if (entry.endsWith(".jsonl")) {
        out.push({ path: p, sessionId: entry.slice(0, -6), subagent: false });
      } else {
        // <sessionId>/subagents/agent-*.jsonl — attribute to the parent session
        const subDir = join(p, "subagents");
        if (!existsSync(subDir)) continue;
        for (const sub of readdirSync(subDir)) {
          if (sub.endsWith(".jsonl")) out.push({ path: join(subDir, sub), sessionId: entry, subagent: true });
        }
      }
    }
  }
  return out;
}

export interface UsageQuery {
  /** Inclusive day bounds, YYYY-MM-DD local. */
  fromDay: string;
  toDay: string;
  /** Override for tests; defaults to ~/.claude/projects. */
  root?: string;
}

export interface UsageReport {
  generated: string;
  currency: "USD";
  overview: {
    cost: number;
    netCost: number;
    savings: number;
    calls: number;
    sessions: number;
    cacheHitPercent: number;
    tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  };
  daily: Array<{ date: string; cost: number; calls: number }>;
  projects: Array<{ name: string; path: string; cost: number; calls: number; sessions: number; avgCostPerSession: number }>;
  models: Array<{ name: string; cost: number; calls: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; oneShotRate: null }>;
  sessions: Array<{ id: string; project: string; startedAt: string; cost: number; calls: number; turns: number; models: Array<{ name: string; cost: number }> }>;
  tools: Array<{ name: string; calls: number }>;
  mcpServers: Array<{ name: string; calls: number }>;
}

export async function computeUsage(q: UsageQuery): Promise<UsageReport> {
  const root = q.root ?? join(homedir(), ".claude", "projects");
  // Tests pass their own root — keep their runs off the real disk cache.
  if (!q.root) loadDiskCacheOnce();

  const files = listTranscripts(root);
  // Evict cache entries whose files vanished (deleted/rotated transcripts) so
  // the per-file agg cache tracks the on-disk set instead of growing forever.
  const live = new Set(files.map((f) => f.path));
  for (const path of fileCache.keys()) {
    if (!live.has(path)) fileCache.delete(path);
  }
  const aggs: FileAgg[] = [];
  let parsed = 0;
  for (const { path, sessionId, subagent } of files) {
    let st;
    try {
      st = statSync(path);
    } catch {
      continue;
    }
    const cached = fileCache.get(path);
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
      aggs.push(cached);
      continue;
    }
    const agg = await parseFile(path, sessionId, subagent);
    fileCache.set(path, agg);
    aggs.push(agg);
    parsed++;
  }
  // Persist only when something actually re-parsed (real runs, not tests) —
  // an all-cache-hits query costs a stat sweep, no rewrite.
  if (parsed > 0 && !q.root) saveDiskCache();

  // Project per SESSION, resolved before any per-file aggregation (#493): a
  // subagent transcript has no cwd, so keyed on its own file it landed in a
  // blank "" project with half the session's cost while the parent's project
  // stayed undercounted. The main file's cwd wins; any file's cwd is the
  // fallback; the file's own (empty) value is never used when the session
  // has a better answer.
  const sessionProject = new Map<string, string>();
  for (const agg of aggs) if (!agg.subagent && agg.project) sessionProject.set(agg.sessionId, agg.project);
  for (const agg of aggs) if (agg.project && !sessionProject.has(agg.sessionId)) sessionProject.set(agg.sessionId, agg.project);

  // OWNERSHIP of a message.id shared by several files (#491): a fork,
  // --resume into a new file, or an imported transcript carries a copy of the
  // history it started from, message ids and usage included — one API call,
  // two files. Global totals count it once. For per-session attribution the
  // OLDEST file (creation time, then mtime where the filesystem keeps no
  // birthtime, then path for determinism) owns the message: that is the
  // conversation that actually paid for the call, and a fork is charged only
  // for what it added. Turns have no API identity and stay per file.
  const created = (a: FileAgg) => (a.birthtimeMs > 0 ? a.birthtimeMs : a.mtimeMs);
  aggs.sort((a, b) => created(a) - created(b) || a.mtimeMs - b.mtimeMs || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const owned = new Set<string>();
  // WHICH observation of a shared message is charged is a separate question
  // from who owns it: the owning (oldest) file may hold an early streaming
  // snapshot of the call (1 output token) while the copy carries the final
  // count (100). The most complete observation across every file wins — the
  // one with the most output tokens, then the most tokens overall.
  const completeness = (t: Tok) => [t.output, t.input + t.cacheRead + t.cacheWrite] as const;
  const finalMsg = new Map<string, Msg>();
  for (const agg of aggs) {
    for (const m of agg.msgs) {
      const cur = finalMsg.get(m.id);
      if (!cur) { finalMsg.set(m.id, m); continue; }
      const [o1, t1] = completeness(cur.tok);
      const [o2, t2] = completeness(m.tok);
      if (o2 > o1 || (o2 === o1 && t2 > t1)) finalMsg.set(m.id, m);
    }
  }
  // Tool calls copied along with their message carry the same block id;
  // the same ownership rule counts each once.
  const ownedTools = new Set<string>();

  const total = zeroTok();
  const daily = new Map<string, { cost: number; calls: number }>();
  const models = new Map<string, Tok>();
  const projects = new Map<string, { cost: number; calls: number; sessions: Set<string> }>();
  const sessions = new Map<string, UsageReport["sessions"][number] & { _models: Map<string, number>; _firstTs: number }>();
  const tools = new Map<string, number>();
  const mcp = new Map<string, number>();
  const inRange = (day: string) => day >= q.fromDay && day <= q.toDay;

  for (const agg of aggs) {
    const project = sessionProject.get(agg.sessionId) ?? "";
    let inRangeCost = 0;
    let inRangeCalls = 0;
    const sessionModels = new Map<string, number>();

    for (const own of agg.msgs) {
      if (owned.has(own.id)) continue; // already charged to an older file (#491)
      owned.add(own.id);
      const { id, day, model, tok } = finalMsg.get(own.id) ?? own;
      if (!day || !inRange(day)) continue;

      addTok(total, tok);
      inRangeCost += tok.cost;
      inRangeCalls += tok.calls;

      const d = daily.get(day) ?? { cost: 0, calls: 0 };
      d.cost += tok.cost;
      d.calls += tok.calls;
      daily.set(day, d);

      let mt = models.get(model);
      if (!mt) {
        mt = zeroTok();
        models.set(model, mt);
      }
      addTok(mt, tok);

      sessionModels.set(model, (sessionModels.get(model) ?? 0) + tok.cost);
    }

    if (inRangeCalls === 0) continue;

    const proj = projects.get(project) ?? { cost: 0, calls: 0, sessions: new Set<string>() };
    proj.cost += inRangeCost;
    proj.calls += inRangeCalls;
    proj.sessions.add(agg.sessionId);
    projects.set(project, proj);

    let turns = 0;
    for (const [day, n] of agg.perDayTurns) {
      if (inRange(day)) turns += n;
    }

    let s = sessions.get(agg.sessionId);
    if (!s) {
      s = {
        id: agg.sessionId,
        project,
        startedAt: "",
        cost: 0,
        calls: 0,
        turns: 0,
        models: [],
        _models: new Map(),
        _firstTs: Infinity,
      };
      sessions.set(agg.sessionId, s);
    }
    s.cost += inRangeCost;
    s.calls += inRangeCalls;
    s.turns += turns;
    if (agg.firstTs < s._firstTs) s._firstTs = agg.firstTs;
    for (const [m, c] of sessionModels) s._models.set(m, (s._models.get(m) ?? 0) + c);

    // Tools/MCP obey the same day range as the tokens (#490): they used to be
    // lifetime-per-file, so "today" reported every tool the session ever ran.
    // A block id seen in an older file is that file's call (#491); a block
    // without an id has no identity to share and counts where it is.
    for (const { id, day, name } of agg.tools) {
      if (id) {
        if (ownedTools.has(id)) continue;
        ownedTools.add(id);
      }
      if (!inRange(day)) continue;
      const mcpMatch = /^mcp__([^_]+(?:_[^_]+)*?)__/.exec(name);
      if (mcpMatch) mcp.set(mcpMatch[1], (mcp.get(mcpMatch[1]) ?? 0) + 1);
      else tools.set(name, (tools.get(name) ?? 0) + 1);
    }
  }

  const sessionList = [...sessions.values()].map(s => ({
    id: s.id,
    project: s.project,
    startedAt: isFinite(s._firstTs) ? new Date(s._firstTs).toISOString() : "",
    cost: s.cost,
    calls: s.calls,
    turns: s.turns,
    models: [...s._models.entries()]
      .map(([m, cost]) => ({ name: prettyModelName(m), cost }))
      .sort((a, b) => b.cost - a.cost),
  })).sort((a, b) => b.cost - a.cost);

  return {
    generated: new Date().toISOString(),
    currency: "USD",
    overview: {
      cost: total.cost,
      netCost: total.cost,
      savings: 0,
      calls: total.calls,
      sessions: sessionList.length,
      cacheHitPercent: total.cacheRead + total.input > 0
        ? Math.round((total.cacheRead / (total.cacheRead + total.input)) * 1000) / 10
        : 0,
      tokens: { input: total.input, output: total.output, cacheRead: total.cacheRead, cacheWrite: total.cacheWrite },
    },
    daily: [...daily.entries()]
      .map(([date, d]) => ({ date, cost: d.cost, calls: d.calls }))
      .sort((a, b) => a.date.localeCompare(b.date)),
    projects: [...projects.entries()]
      .map(([path, p]) => ({
        name: path.split("/").filter(Boolean).pop() || path,
        path,
        cost: p.cost,
        calls: p.calls,
        sessions: p.sessions.size,
        avgCostPerSession: p.sessions.size ? p.cost / p.sessions.size : 0,
      }))
      .sort((a, b) => b.cost - a.cost),
    models: [...models.entries()]
      .map(([model, t]) => ({
        name: prettyModelName(model),
        cost: t.cost,
        calls: t.calls,
        inputTokens: t.input,
        outputTokens: t.output,
        cacheReadTokens: t.cacheRead,
        cacheWriteTokens: t.cacheWrite,
        oneShotRate: null as null,
      }))
      .sort((a, b) => b.cost - a.cost),
    sessions: sessionList,
    tools: [...tools.entries()].map(([name, calls]) => ({ name, calls })).sort((a, b) => b.calls - a.calls),
    mcpServers: [...mcp.entries()].map(([name, calls]) => ({ name, calls })).sort((a, b) => b.calls - a.calls),
  };
}

/** Period keyword (today/week/30days/90days/6months/all) → inclusive day range. */
export function periodToRange(period: string): { fromDay: string; toDay: string; label: string } {
  const today = localDay(new Date().toISOString());
  const back = (days: number) => {
    const d = new Date();
    d.setDate(d.getDate() - days);
    return localDay(d.toISOString());
  };
  switch (period) {
    case "today": return { fromDay: today, toDay: today, label: `Today (${today})` };
    case "week": return { fromDay: back(6), toDay: today, label: `${back(6)} to today` };
    case "90days": return { fromDay: back(89), toDay: today, label: `${back(89)} to today` };
    case "6months": return { fromDay: back(182), toDay: today, label: `${back(182)} to today` };
    case "all": return { fromDay: "1970-01-01", toDay: today, label: "All time" };
    default: return { fromDay: back(29), toDay: today, label: `Last 30 Days` };
  }
}
