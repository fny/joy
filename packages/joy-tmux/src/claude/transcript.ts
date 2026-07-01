// Transcript file mechanics: locate Claude Code JSONL transcripts and tail
// them as parsed entries. No session semantics here — what an entry *means*
// (turns, receipts, relay events) lives in session.ts; this module only
// knows how to find the file and stream its lines.

import { openSync, readSync, closeSync, statSync, readdirSync, readFileSync, watch } from "fs";
import { join } from "path";
import { homedir } from "os";

/** True for a real user prompt (turn boundary) — not a tool_result, meta, or CLI wrapper. */
function isUserPromptLine(line: string): boolean {
  if (!line.trim()) return false;
  try {
    const o = JSON.parse(line);
    if (o.type !== "user" || o.isMeta) return false;
    const c = o.message?.content;
    return typeof c === "string" && c.trim().length > 0 && !c.startsWith("<");
  } catch { return false; }
}

/**
 * Byte offset to start tailing so the backfill is at most ~capBytes, snapped
 * BACK to a clean turn boundary (a user-prompt line) so we never replay a
 * partial turn. Returns 0 if the file fits within the cap or has no turns. If
 * the final turn alone exceeds the cap, we include that whole turn.
 */
export function cappedTailOffset(path: string, capBytes: number): number {
  try {
    const size = statSync(path).size;
    if (capBytes <= 0 || size <= capBytes) return 0;
    const target = size - capBytes;
    const text = readFileSync(path, "utf-8");
    let off = 0;
    let lastPromptBeforeTarget = 0;
    let firstPromptAtOrAfter = -1;
    for (const line of text.split("\n")) {
      if (isUserPromptLine(line)) {
        if (off < target) lastPromptBeforeTarget = off;
        else if (firstPromptAtOrAfter < 0) firstPromptAtOrAfter = off;
      }
      off += Buffer.byteLength(line, "utf-8") + 1; // + newline
    }
    return firstPromptAtOrAfter >= 0 ? firstPromptAtOrAfter : lastPromptBeforeTarget;
  } catch { return 0; }
}

/**
 * Claude Code writes transcripts under ~/.claude/projects/<sanitized-cwd>/, where
 * the cwd is sanitized by replacing every character that is NOT [a-zA-Z0-9-] with
 * a dash. So slashes, dots, underscores, and spaces all collapse to "-" (case is
 * preserved). Slash-only replacement was wrong for any path with a dot/underscore/
 * space in it (e.g. "…/agenttherapy.org" → …-agenttherapy-org), which left the
 * daemon looking in a directory that never exists → transcript never binds.
 * Verified empirically against Claude 2.1.x: "/tmp/x/a_b.c-d e" → "-tmp-x-a-b-c-d-e".
 */
export function cwdToTranscriptDir(cwd: string): string {
  return join(homedir(), ".claude", "projects", cwd.replace(/[^a-zA-Z0-9-]/g, "-"));
}

/**
 * Resolve a possibly-short session id against a cwd's transcript dir. Claude's
 * --resume needs the full session uuid, so callers accept a short id and expand
 * it here: returns the full id for an exact transcript or a unique prefix of one;
 * returns the input unchanged when nothing matches (callers then report
 * "not found"); throws when a prefix is ambiguous, so we never resume the wrong
 * conversation. An exact match wins even when it's also a prefix of a longer id.
 */
export function resolveTranscriptId(dir: string, id: string): string {
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return id; // dir missing → nothing to resolve; caller reports not-found
  }
  const ids = files
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => f.slice(0, -".jsonl".length));
  if (ids.includes(id)) return id;
  const matches = ids.filter((x) => x.startsWith(id));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new Error(`Session id "${id}" is ambiguous (${matches.length} matches) — provide more characters`);
  }
  return id;
}

/** Newest .jsonl in dir modified at/after minMtime, or null. */
export function findLatestTranscript(dir: string, minMtime: number): string | null {
  try {
    let latest: { path: string; mtime: number } | null = null;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".jsonl")) continue;
      try {
        const p = join(dir, f);
        const mtime = statSync(p).mtimeMs;
        if (mtime >= minMtime && (!latest || mtime > latest.mtime)) latest = { path: p, mtime };
      } catch {}
    }
    return latest?.path ?? null;
  } catch { return null; }
}

export interface TranscriptTailer {
  close(): void;
}

/**
 * Tail a JSONL file, invoking onEntry for each complete parsed line as it is
 * appended. Reads incrementally from a byte offset, carrying incomplete
 * trailing lines across reads. If the file can't be watched yet (e.g. it is
 * still being created), retries every 500ms until shouldRetry() returns false.
 */
export function tailJsonl(
  path: string,
  onEntry: (entry: Record<string, unknown>) => void,
  shouldRetry: () => boolean = () => true,
  startOffset = 0,
): TranscriptTailer {
  let byteOffset = startOffset;
  let leftover = ""; // incomplete line carried across reads
  let fsWatcher: ReturnType<typeof watch> | null = null;
  let closed = false;

  function readNew() {
    try {
      const { size } = statSync(path);
      if (size <= byteOffset) return;
      const fd = openSync(path, "r");
      const buf = Buffer.allocUnsafe(size - byteOffset);
      const bytesRead = readSync(fd, buf, 0, buf.length, byteOffset);
      closeSync(fd);
      byteOffset += bytesRead;
      const chunk = leftover + buf.subarray(0, bytesRead).toString("utf-8");
      const parts = chunk.split("\n");
      leftover = parts.pop() ?? ""; // last part is incomplete if no trailing \n
      for (const line of parts) {
        if (!line.trim()) continue;
        try {
          onEntry(JSON.parse(line));
        } catch {}
      }
    } catch {}
  }

  function attach() {
    if (closed || !shouldRetry()) return;
    try {
      fsWatcher = watch(path, () => readNew());
      readNew();
    } catch {
      setTimeout(attach, 500);
    }
  }

  attach();
  return {
    close() {
      closed = true;
      fsWatcher?.close();
    },
  };
}
