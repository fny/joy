// A title for a transcript on disk, for the lists that used to show only the
// first eight characters of a UUID (session logs, the projects pages, the
// past-sessions picker on the new-session page).
//
// Where a title can come from, in the order a live session ranks them
// (claude/session.ts): the agent's own `<joy-title value="…"/>` tag in an
// assistant message, then Claude's `{"type":"ai-title"}` entry. A user's
// `/title` lives only in the window record, which the caller joins on
// (domain/operations.ts listLogs). When a transcript has neither — Claude
// titles maybe two conversations in three — the first prompt is better than
// a UUID.
//
// Cost: one bounded read from the END (the newest title wins, and Claude
// re-emits its title on every resume, so the last few hundred KB carry it)
// and, only when that finds nothing, one from the START (the first ai-title
// sits in the first dozen lines; so does the first prompt). Never the whole
// file: transcripts run to many MB and the projects page lists dozens at
// once. Results are cached by size+mtime, so a re-list is free.
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { joyTitleValue } from "./session";

export type LogTitleSource = "agent" | "ai" | "prompt";
export interface LogTitle { title: string; source: LogTitleSource }

export const LOG_TITLE_TAIL_BYTES = 64 * 1024;
export const LOG_TITLE_HEAD_BYTES = 16 * 1024;
/** A prompt used as a title is cut here; real titles are short already. */
export const LOG_TITLE_MAX = 60;
const CACHE_MAX = 500;

const cache = new Map<string, { key: string; value: LogTitle | null }>();

function remember(file: string, key: string, value: LogTitle | null): LogTitle | null {
  if (!cache.has(file) && cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(file, { key, value });
  return value;
}

/** Test seam. */
export function clearLogTitleCache(): void { cache.clear(); }

function parse(line: string): Record<string, unknown> | null {
  try { return JSON.parse(line) as Record<string, unknown>; } catch { return null; }
}

function clip(text: string, max: number): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? one.slice(0, max - 1).trimEnd() + "…" : one;
}

function agentTitleOf(line: string): string | null {
  if (!line.includes("<joy-title")) return null;
  const e = parse(line);
  return e ? joyTitleValue(e) : null;
}

function aiTitleOf(line: string): string | null {
  if (!line.includes('"ai-title"')) return null;
  const e = parse(line);
  if (!e || e.type !== "ai-title" || typeof e.aiTitle !== "string") return null;
  const t = e.aiTitle.trim();
  return t ? clip(t, LOG_TITLE_MAX) : null;
}

/** The text of a real user prompt — not a tool result, meta or CLI wrapper. */
function promptOf(line: string): string | null {
  if (!line.includes('"user"')) return null;
  const e = parse(line);
  if (!e || e.type !== "user" || e.isMeta) return null;
  const c = (e.message as { content?: unknown } | undefined)?.content;
  let text = "";
  if (typeof c === "string") text = c;
  else if (Array.isArray(c)) {
    for (const p of c) if (p && typeof p === "object" && (p as { type?: unknown }).type === "text" && typeof (p as { text?: unknown }).text === "string") text += "\n" + (p as { text: string }).text;
  }
  text = text.trim();
  if (!text || text.startsWith("<")) return null;
  return clip(text, LOG_TITLE_MAX);
}

/** Complete lines of `[start, end)`. A chunk that does not begin at the file
 *  start drops its first line (partial); one that does not reach the file end
 *  drops its last. A multi-byte character split at a boundary can only sit
 *  in a dropped line. */
function linesOf(fd: number, start: number, end: number, size: number): string[] {
  if (end <= start) return [];
  const buf = Buffer.alloc(end - start);
  readSync(fd, buf, 0, buf.length, start);
  let lines = buf.toString("utf8").split("\n");
  if (start > 0) lines = lines.slice(1);
  if (end < size) lines = lines.slice(0, -1);
  return lines;
}

function scan(file: string, size: number, tailBytes: number, headBytes: number): LogTitle | null {
  const fd = openSync(file, "r");
  try {
    const tailStart = Math.max(0, size - tailBytes);
    const tail = linesOf(fd, tailStart, size, size);
    // Newest first. The agent's tag outranks Claude's title, as it does live:
    // once the agent has named the work, an ai-title re-emitted on resume
    // must not take the name back.
    let ai: string | null = null;
    for (let i = tail.length - 1; i >= 0; i--) {
      const agent = agentTitleOf(tail[i]);
      if (agent) return { title: agent, source: "agent" };
      if (ai === null) ai = aiTitleOf(tail[i]);
    }
    if (ai) return { title: ai, source: "ai" };
    // Nothing in the tail. The head has the first ai-title, if Claude ever
    // wrote one, and the first prompt.
    const head = tailStart === 0 ? tail : linesOf(fd, 0, Math.min(headBytes, tailStart), size);
    let prompt: string | null = null;
    for (const line of head) {
      const t = aiTitleOf(line);
      if (t) return { title: t, source: "ai" };
      if (prompt === null) prompt = promptOf(line);
    }
    return prompt ? { title: prompt, source: "prompt" } : null;
  } finally {
    closeSync(fd);
  }
}

/** Title for one transcript file, or null when it has none derivable.
 *  Never throws: an unreadable file is simply untitled. */
export function readLogTitle(
  file: string,
  opts: { tailBytes?: number; headBytes?: number } = {},
): LogTitle | null {
  let size: number;
  let key: string;
  try {
    const st = statSync(file);
    size = st.size;
    key = `${st.size}:${st.mtimeMs}`;
  } catch { return null; }
  const hit = cache.get(file);
  if (hit && hit.key === key) return hit.value;
  let value: LogTitle | null = null;
  try {
    value = scan(file, size, opts.tailBytes ?? LOG_TITLE_TAIL_BYTES, opts.headBytes ?? LOG_TITLE_HEAD_BYTES);
  } catch { value = null; }
  return remember(file, key, value);
}
