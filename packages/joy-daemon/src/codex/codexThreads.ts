// Codex thread discovery for "continue": resolve the NEWEST codex thread that
// ran in a given cwd by scanning the rollout files codex writes under
// $CODEX_HOME/sessions/<y>/<m>/<d>/rollout-*.jsonl. Each rollout's first line
// is a session_meta payload carrying {cwd, id} — id IS the thread id that
// thread/resume accepts. Newest-mtime-first, capped so a huge history can't
// stall session creation.

import { closeSync, openSync, readSync, readdirSync, statSync } from "fs";
import { promptTitle } from "../domain/pastSessions";
import { join } from "path";
import { codexHome as resolveCodexHome, codexSessionsDir as sessionsDirUnder } from "./codexHome";
import { withFd } from "../domain/bounded";
import fs from "fs";

const SCAN_CAP = 200;
// The session_meta line is a few hundred bytes; anything past this is not a
// rollout head we can use.
const FIRST_LINE_MAX = 64 * 1024;

/** The rollout's first line, read through a descriptor with a hard byte
 *  bound — never the whole file (#521). readFileSync decoded the ENTIRE
 *  transcript just to split off line one: a rollout past Node's string /
 *  2 GiB read limits threw, the catch skipped it, and "continue" resumed an
 *  OLDER conversation (or none) although the newest one was right there;
 *  smaller multi-hundred-MB histories blocked the daemon for the full read.
 *  Returns null when no complete line fits in the bound. */
function readFirstLine(path: string): string | null {
  return withFd(path, "r", (fd) => {
    const buf = Buffer.alloc(FIRST_LINE_MAX);
    // A read may legally return FEWER bytes than asked (a short read) without
    // being at EOF; taking one as the whole head made a valid rollout look
    // like a newline-less line and "continue" skipped every matching thread
    // (Astra on 81386fd0). Keep reading into the same bound until a newline,
    // a real EOF (0 bytes) or the bound is full.
    let n = 0;
    while (n < buf.length) {
      const got = fs.readSync(fd, buf, n, buf.length - n, n);
      if (got <= 0) break;
      const nl = buf.subarray(n, n + got).indexOf(0x0a);
      if (nl >= 0) return buf.subarray(0, n + nl).toString("utf8");
      n += got;
    }
    // No newline in the bound: a one-line file (EOF before the cap) is that
    // line; a longer head is not a session_meta line.
    return n < buf.length ? buf.subarray(0, n).toString("utf8") : null;
  });
}

/** The rollout store — the shared resolver (#524 #541 #546) unless a home is given. */
export function codexSessionsDir(codexHome?: string): string {
  return sessionsDirUnder(codexHome ?? resolveCodexHome());
}

/** The newest thread id whose rollout ran in `cwd`, or null. */
export function findLatestCodexThreadForCwd(cwd: string, codexHome?: string): string | null {
  const files: { path: string; mtimeMs: number }[] = [];
  const walk = (dir: string, depth: number): void => {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const e of entries) {
      const p = join(dir, e);
      try {
        const st = statSync(p);
        if (st.isDirectory() && depth < 3) walk(p, depth + 1);
        else if (st.isFile() && /^rollout-.*\.jsonl$/.test(e)) files.push({ path: p, mtimeMs: st.mtimeMs });
      } catch { /* skip */ }
    }
  };
  walk(codexSessionsDir(codexHome), 0);
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const f of files.slice(0, SCAN_CAP)) {
    try {
      const firstLine = readFirstLine(f.path);
      if (firstLine === null) continue;
      const meta = JSON.parse(firstLine) as { payload?: { cwd?: string; id?: string } };
      const p = meta.payload ?? (meta as { cwd?: string; id?: string });
      if (p.cwd === cwd && typeof p.id === "string" && p.id) return p.id;
    } catch { /* unreadable rollout — skip */ }
  }
  return null;
}

/** Every thread whose rollout ran in `cwd`, newest first, with a title from
 *  the rollout head: the first user text that is not an <environment_context>
 *  or other "<…" wrapper (the real first prompt), clipped. Bounded head reads
 *  only — a rollout can be gigabytes (#521). */
export function listCodexThreadsForCwd(cwd: string, codexHome?: string): Array<{ id: string; title: string | null; updatedAt: number; sizeBytes: number | null }> {
  const files: { path: string; mtimeMs: number; size: number }[] = [];
  const walk = (dir: string, depth: number): void => {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const e of entries) {
      const p = join(dir, e);
      try {
        const st = statSync(p);
        if (st.isDirectory() && depth < 3) walk(p, depth + 1);
        else if (st.isFile() && /^rollout-.*\.jsonl$/.test(e)) files.push({ path: p, mtimeMs: st.mtimeMs, size: st.size });
      } catch { /* skip */ }
    }
  };
  walk(codexSessionsDir(codexHome), 0);
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const out: Array<{ id: string; title: string | null; updatedAt: number; sizeBytes: number | null }> = [];
  for (const f of files.slice(0, SCAN_CAP)) {
    try {
      const firstLine = readFirstLine(f.path);
      if (firstLine === null) continue;
      const meta = JSON.parse(firstLine) as { payload?: { cwd?: string; id?: string } };
      const p = meta.payload ?? (meta as { cwd?: string; id?: string });
      if (p.cwd !== cwd || typeof p.id !== "string" || !p.id) continue;
      out.push({ id: p.id, title: codexRolloutTitle(f.path), updatedAt: f.mtimeMs, sizeBytes: f.size });
    } catch { /* unreadable rollout — skip */ }
  }
  return out;
}

/** First real prompt in a rollout, or null. Codex writes the prompt both as
 *  a response_item message (content[].text) and as an event_msg
 *  user_message. The first user message is the harness's own preamble —
 *  recommended plugins, AGENTS.md, environment_context, each a part that
 *  starts with "<" or "#" — and a `world_state` line carrying the whole
 *  AGENTS.md can push the real prompt past 16KB, which a single head read
 *  missed: every joy-driven thread listed untitled. The file is read in
 *  chunks up to `maxBytes`, line by line, and the scan stops at the first
 *  part that reads as a prompt; results are cached by size+mtime. */
const ROLLOUT_TITLE_CHUNK = 64 * 1024;
const ROLLOUT_TITLE_MAX = 1024 * 1024;
const rolloutTitleCache = new Map<string, { key: string; title: string | null }>();
const ROLLOUT_TITLE_CACHE_MAX = 1000;

export function codexRolloutTitle(path: string, maxBytes = ROLLOUT_TITLE_MAX): string | null {
  let size: number;
  let key: string;
  try { const st = statSync(path); size = st.size; key = `${st.size}:${st.mtimeMs}`; } catch { return null; }
  const hit = rolloutTitleCache.get(path);
  if (hit && hit.key === key) return hit.title;
  let title: string | null = null;
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    let offset = 0;
    let carry = "";
    scan: while (offset < size && offset < maxBytes) {
      const buf = Buffer.alloc(Math.min(ROLLOUT_TITLE_CHUNK, size - offset, maxBytes - offset));
      const n = readSync(fd, buf, 0, buf.length, offset);
      if (n <= 0) break;
      offset += n;
      const text = carry + buf.subarray(0, n).toString("utf8");
      const lines = text.split("\n");
      // The last piece is complete only at EOF.
      carry = offset < size ? (lines.pop() ?? "") : "";
      for (const line of lines) {
        const t = rolloutLineTitle(line);
        if (t) { title = t; break scan; }
      }
    }
    if (title === null && carry) title = rolloutLineTitle(carry);
  } catch { title = null; }
  finally { if (fd !== null) closeSync(fd); }
  if (!rolloutTitleCache.has(path) && rolloutTitleCache.size >= ROLLOUT_TITLE_CACHE_MAX) {
    const oldest = rolloutTitleCache.keys().next().value;
    if (oldest !== undefined) rolloutTitleCache.delete(oldest);
  }
  rolloutTitleCache.set(path, { key, title });
  return title;
}

/** Test seam. */
export function clearCodexRolloutTitleCache(): void { rolloutTitleCache.clear(); }

function rolloutLineTitle(line: string): string | null {
  if (!line.includes('"user"') && !line.includes("user_message")) return null;
  let e: { type?: string; payload?: Record<string, unknown> };
  try { e = JSON.parse(line); } catch { return null; }
  const pl = e.payload ?? {};
  if (e.type === "response_item" && pl.type === "message" && pl.role === "user" && Array.isArray(pl.content)) {
    // Every part: the preamble parts (plugins, AGENTS.md, environment) sit
    // in the SAME message as nothing else, but a later message may carry a
    // wrapper part before the prompt.
    for (const part of pl.content as Array<{ type?: string; text?: string }>) {
      if (typeof part?.text !== "string" || (part.type !== "input_text" && part.type !== "text")) continue;
      // The AGENTS.md part of the preamble is the one that does not start
      // with "<"; it is never the prompt.
      if (/^\s*#\s*AGENTS\.md/i.test(part.text)) continue;
      const t = promptTitle(part.text);
      if (t) return t;
    }
    return null;
  }
  if (e.type === "event_msg" && pl.type === "user_message" && typeof pl.message === "string") return promptTitle(pl.message);
  return null;
}

/** Parse a user-supplied codex config-override string ("key=value key2=value2",
 *  the -c form) into a config map. Values may be quoted to contain spaces. */
export function parseCodexConfigArgs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([\w.\-]+)=("(?:[^"\\]|\\.)*"|'[^']*'|\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}
