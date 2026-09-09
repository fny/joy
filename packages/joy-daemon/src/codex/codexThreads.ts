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

/** First real prompt in a rollout head. Codex writes the prompt both as a
 *  response_item message (content[].text) and as an event_msg user_message;
 *  the environment_context message precedes it and starts with "<". */
export function codexRolloutTitle(path: string, bytes = 16 * 1024): string | null {
  let fd: number | null = null;
  let text = "";
  try {
    const size = statSync(path).size;
    fd = openSync(path, "r");
    const buf = Buffer.alloc(Math.min(bytes, size));
    const n = readSync(fd, buf, 0, buf.length, 0);
    text = buf.subarray(0, n).toString("utf8");
    if (n < size) text = text.slice(0, text.lastIndexOf("\n") + 1);
  } catch { return null; }
  finally { if (fd !== null) closeSync(fd); }
  for (const line of text.split("\n")) {
    if (!line.includes('"user"') && !line.includes("user_message")) continue;
    let e: { type?: string; payload?: Record<string, unknown> };
    try { e = JSON.parse(line); } catch { continue; }
    const pl = e.payload ?? {};
    let candidate: string | null = null;
    if (e.type === "response_item" && pl.type === "message" && pl.role === "user" && Array.isArray(pl.content)) {
      for (const part of pl.content as Array<{ type?: string; text?: string }>) {
        if (typeof part?.text === "string" && (part.type === "input_text" || part.type === "text")) { candidate = part.text; break; }
      }
    } else if (e.type === "event_msg" && pl.type === "user_message" && typeof pl.message === "string") {
      candidate = pl.message;
    }
    const t = candidate ? promptTitle(candidate) : null;
    if (t) return t;
  }
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
