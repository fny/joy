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
import { readdirSync, statSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

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

interface FileAgg {
  mtimeMs: number;
  size: number;
  /** Parent session id — directory name for subagents/, filename otherwise. */
  sessionId: string;
  project: string;
  firstTs: number;
  lastTs: number;
  /** `${YYYY-MM-DD} ${model}` → tokens */
  perDayModel: Map<string, Tok>;
  /** YYYY-MM-DD → user prompt count */
  perDayTurns: Map<string, number>;
  tools: Map<string, number>;
  mcp: Map<string, number>;
}

function localDay(ts: string): string {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

async function parseFile(path: string, sessionId: string): Promise<FileAgg> {
  const st = statSync(path);
  const agg: FileAgg = {
    mtimeMs: st.mtimeMs,
    size: st.size,
    sessionId,
    project: "",
    firstTs: Infinity,
    lastTs: 0,
    perDayModel: new Map(),
    perDayTurns: new Map(),
    tools: new Map(),
    mcp: new Map(),
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
      if (!agg.project && typeof e.cwd === "string") agg.project = e.cwd;
      // Tool calls are counted across ALL entries — each entry carries the
      // message's new content block, so blocks never repeat.
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block?.type !== "tool_use" || typeof block.name !== "string") continue;
          const mcpMatch = /^mcp__([^_]+(?:_[^_]+)*?)__/.exec(block.name);
          if (mcpMatch) agg.mcp.set(mcpMatch[1], (agg.mcp.get(mcpMatch[1]) ?? 0) + 1);
          else agg.tools.set(block.name, (agg.tools.get(block.name) ?? 0) + 1);
        }
      }
      if (msg.usage && typeof msg.id === "string" && typeof msg.model === "string" && msg.model !== "<synthetic>") {
        messages.set(msg.id, { model: msg.model, usage: msg.usage, day: localDay(ts) });
      }
    } else if (e.type === "user" && e.isSidechain !== true && msg.role === "user") {
      // Real prompts have string content (or a text block); tool results are
      // arrays of tool_result blocks.
      const c = msg.content;
      const isPrompt = typeof c === "string" || (Array.isArray(c) && c.some((b: any) => b?.type === "text"));
      if (isPrompt) {
        const day = localDay(ts);
        if (day) agg.perDayTurns.set(day, (agg.perDayTurns.get(day) ?? 0) + 1);
      }
    }
  }

  for (const { model, usage, day } of messages.values()) {
    if (!day) continue;
    const key = `${day} ${model}`;
    let t = agg.perDayModel.get(key);
    if (!t) {
      t = zeroTok();
      agg.perDayModel.set(key, t);
    }
    addUsage(t, model, usage as Record<string, any>);
  }

  return agg;
}

// Per-file cache keyed by path; reparse only when mtime/size move. Transcripts
// are append-only, so this makes every query after the first one cheap.
const fileCache = new Map<string, FileAgg>();

function listTranscripts(root: string): Array<{ path: string; sessionId: string }> {
  const out: Array<{ path: string; sessionId: string }> = [];
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
        out.push({ path: p, sessionId: entry.slice(0, -6) });
      } else {
        // <sessionId>/subagents/agent-*.jsonl — attribute to the parent session
        const subDir = join(p, "subagents");
        if (!existsSync(subDir)) continue;
        for (const sub of readdirSync(subDir)) {
          if (sub.endsWith(".jsonl")) out.push({ path: join(subDir, sub), sessionId: entry });
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

  const files = listTranscripts(root);
  const aggs: FileAgg[] = [];
  for (const { path, sessionId } of files) {
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
    const agg = await parseFile(path, sessionId);
    fileCache.set(path, agg);
    aggs.push(agg);
  }

  const total = zeroTok();
  const daily = new Map<string, { cost: number; calls: number }>();
  const models = new Map<string, Tok>();
  const projects = new Map<string, { cost: number; calls: number; sessions: Set<string> }>();
  const sessions = new Map<string, UsageReport["sessions"][number] & { _models: Map<string, number>; _firstTs: number }>();
  const tools = new Map<string, number>();
  const mcp = new Map<string, number>();

  for (const agg of aggs) {
    let inRangeCost = 0;
    let inRangeCalls = 0;
    const sessionModels = new Map<string, number>();

    for (const [key, tok] of agg.perDayModel) {
      const day = key.slice(0, key.indexOf(" "));
      const model = key.slice(key.indexOf(" ") + 1);
      if (day < q.fromDay || day > q.toDay) continue;

      total.input += tok.input;
      total.output += tok.output;
      total.cacheRead += tok.cacheRead;
      total.cacheWrite += tok.cacheWrite;
      total.cost += tok.cost;
      total.calls += tok.calls;
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
      mt.input += tok.input;
      mt.output += tok.output;
      mt.cacheRead += tok.cacheRead;
      mt.cacheWrite += tok.cacheWrite;
      mt.cost += tok.cost;
      mt.calls += tok.calls;

      sessionModels.set(model, (sessionModels.get(model) ?? 0) + tok.cost);
    }

    if (inRangeCalls === 0) continue;

    const proj = projects.get(agg.project) ?? { cost: 0, calls: 0, sessions: new Set<string>() };
    proj.cost += inRangeCost;
    proj.calls += inRangeCalls;
    proj.sessions.add(agg.sessionId);
    projects.set(agg.project, proj);

    let turns = 0;
    for (const [day, n] of agg.perDayTurns) {
      if (day >= q.fromDay && day <= q.toDay) turns += n;
    }

    let s = sessions.get(agg.sessionId);
    if (!s) {
      s = {
        id: agg.sessionId,
        project: agg.project,
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
    // Subagent files carry no real project/start; let the main file win.
    if (agg.firstTs < s._firstTs) s._firstTs = agg.firstTs;
    if (!s.project && agg.project) s.project = agg.project;
    for (const [m, c] of sessionModels) s._models.set(m, (s._models.get(m) ?? 0) + c);

    for (const [name, n] of agg.tools) tools.set(name, (tools.get(name) ?? 0) + n);
    for (const [name, n] of agg.mcp) mcp.set(name, (mcp.get(name) ?? 0) + n);
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
