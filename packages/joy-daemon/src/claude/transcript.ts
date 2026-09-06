// Transcript file mechanics: locate Claude Code JSONL transcripts and tail
// them as parsed entries. No session semantics here — what an entry *means*
// (turns, receipts, relay events) lives in session.ts; this module only
// knows how to find the file and stream its lines.

import { readSync, statSync, readdirSync, readFileSync, watch } from "fs";
import { join } from "path";
import { homedir } from "os";
import { withFd } from "../domain/bounded";

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
 * Byte offset to cut a transcript for TELEPORT (copy to another machine and
 * `--resume` it there): prefer the last `compact_boundary` line — the summary
 * that follows it is the context Claude actually holds, so nothing earlier is
 * needed to continue — as long as that tail fits `capBytes`; otherwise the
 * turn-snapped tail cappedTailOffset gives. 0 = the whole file fits.
 */
export function teleportTailOffset(path: string, capBytes: number): number {
  try {
    const size = statSync(path).size;
    if (capBytes <= 0 || size <= capBytes) return 0;
    const text = readFileSync(path, "utf-8");
    let off = 0; let lastBoundary = -1;
    for (const line of text.split("\n")) {
      if (line.includes('"compact_boundary"') && line.includes('"type":"system"')) lastBoundary = off;
      off += Buffer.byteLength(line, "utf-8") + 1;
    }
    if (lastBoundary >= 0 && size - lastBoundary <= capBytes) return lastBoundary;
    return cappedTailOffset(path, capBytes);
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
  /** Current byte offset AFTER the last fully-consumed line — the replay
   *  checkpoint persisted by the session (codex review finding 8). */
  offset(): number;
}

/** Tailer health counters (codex review finding 6): an upstream format change
 *  that breaks every line — or a persistent read error — used to look
 *  IDENTICAL to an idle session. The tailer counts failures and reports
 *  threshold crossings via onHealth; consumers surface them (agent note,
 *  health flag). Parse health (schema/content degraded) is tracked separately
 *  from read health (fs degraded). */
export interface TailerHealth {
  kind: "parse" | "read";
  consecutive: number;
  total: number;
  detail: string;
}

const HEALTH_ALERT_THRESHOLD = 25;
const HEALTH_LOG_EVERY = 100;

/** Safety-net poll (#488): fs.watch is bound to an INODE, so a transcript
 *  replaced by write-sibling-then-rename leaves the watcher on a file nothing
 *  writes to any more. The inotify events for the unlink usually get us to
 *  readNew (which notices the inode change and re-arms), but nothing
 *  guarantees them, so a cheap stat every couple of seconds is the floor. */
const REPLACE_POLL_MS = 2000;
const EMPTY = Buffer.alloc(0);

/** Where an entry's line sits in the tailed file: `start` is the byte offset
 *  of its first byte, `end` the offset just past its newline — i.e. what
 *  offset() reports once the line is consumed. The session records `start`
 *  on the entry's forwarded-uuid receipt so a committed cursor can prove,
 *  positionally, that a replay from it never reaches the entry (#560). */
export interface TranscriptEntryPosition { start: number; end: number }

/**
 * Tail a JSONL file, invoking onEntry for each complete parsed line as it is
 * appended. Reads incrementally from a byte offset, carrying incomplete
 * trailing lines across reads. If the file can't be watched yet (e.g. it is
 * still being created), retries every 500ms until shouldRetry() returns false.
 */
export function tailJsonl(
  path: string,
  onEntry: (entry: Record<string, unknown>, pos: TranscriptEntryPosition) => void,
  shouldRetry: () => boolean = () => true,
  startOffset = 0,
  onHealth?: (h: TailerHealth) => void,
): TranscriptTailer {
  let byteOffset = startOffset;
  // Incomplete line carried across reads — kept as BYTES, not a string (#38):
  // a read can end inside a 2-4 byte UTF-8 sequence, and decoding the halves
  // separately turned each into U+FFFD (the reassembled line still parsed, so
  // the corruption was silent) while offset() then subtracted the 3-byte
  // replacement chars instead of the real bytes, skewing the checkpoint.
  let leftover: Buffer = EMPTY;
  let fsWatcher: ReturnType<typeof watch> | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  /** Inode the offset/leftover describe — a different one under the same
   *  path means the transcript was replaced (#488). */
  let fileIno: bigint | null = null;
  let closed = false;
  // Health (codex finding 6): skip-and-advance stays — a garbage line must
  // not wedge the tailer (liveness) — but failures are now COUNTED and
  // surfaced instead of indistinguishable from idleness.
  let parseConsecutive = 0, parseTotal = 0;
  let readConsecutive = 0, readTotal = 0;

  function noteParseFailure(line: string) {
    parseConsecutive++; parseTotal++;
    if (parseTotal === 1 || parseTotal % HEALTH_LOG_EVERY === 0) {
      process.stderr.write(`[tail] parse failure #${parseTotal} (consec ${parseConsecutive}) at ~byte ${byteOffset} of ${path}: ${JSON.stringify(line.slice(0, 80))}\n`);
    }
    if (parseConsecutive === HEALTH_ALERT_THRESHOLD) {
      onHealth?.({ kind: "parse", consecutive: parseConsecutive, total: parseTotal, detail: line.slice(0, 120) });
    }
  }

  function noteReadFailure(e: unknown) {
    readConsecutive++; readTotal++;
    if (readTotal === 1 || readTotal % HEALTH_LOG_EVERY === 0) {
      process.stderr.write(`[tail] read failure #${readTotal} (consec ${readConsecutive}) on ${path}: ${e}\n`);
    }
    if (readConsecutive === HEALTH_ALERT_THRESHOLD) {
      onHealth?.({ kind: "read", consecutive: readConsecutive, total: readTotal, detail: String(e).slice(0, 120) });
    }
  }

  function handleLine(line: string, start: number, end: number) {
    if (!line.trim()) return;
    try {
      const entry = JSON.parse(line);
      parseConsecutive = 0;
      onEntry(entry, { start, end });
    } catch (e) {
      // onEntry throwing is a CONSUMER bug, but counting it as parse
      // health keeps the alarm honest either way.
      if (e instanceof SyntaxError) noteParseFailure(line);
      else process.stderr.write(`[tail] onEntry threw for ${path}: ${e}\n`);
    }
  }

  /** (Re)bind fs.watch to whatever inode `path` names right now. Throws when
   *  the path can't be watched (caller decides: retry later / poll). */
  function armWatcher() {
    fsWatcher?.close();
    fsWatcher = watch(path, () => readNew());
    // An async watcher error with no listener is THROWN at the event loop —
    // that would take the daemon down for one unreadable transcript. Drop
    // the watcher instead; the poll re-arms it on its next tick (#488).
    fsWatcher.on("error", () => { fsWatcher?.close(); fsWatcher = null; });
  }

  function readNew() {
    if (closed) return;
    try {
      const st = statSync(path, { bigint: true });
      if (fileIno !== null && st.ino !== fileIno) {
        // The path names a DIFFERENT file (atomic replace: sibling + rename,
        // #488). Our offset and leftover describe the old inode, and so does
        // fs.watch — start the new file from byte 0 and re-arm on it.
        byteOffset = 0;
        leftover = EMPTY;
        try { armWatcher(); } catch { fsWatcher = null; /* the poll retries */ }
      }
      fileIno = st.ino;
      const size = Number(st.size);
      if (size < byteOffset) {
        // Truncated / rewritten in place (#487): the old offset is past the
        // new end, so `size <= byteOffset` alone would sit silent until the
        // rewrite outgrew it and then resume mid-line. Also covers a persisted
        // checkpoint that outlived the file it described. Re-read from 0.
        byteOffset = 0;
        leftover = EMPTY;
      }
      if (size <= byteOffset) return;
      // The descriptor is closed on EVERY path: a readSync that threw (EIO,
      // EISDIR after a replace) used to leak one fd per retry until the daemon
      // hit its limit (#489).
      const { buf, bytesRead } = withFd(path, "r", (fd) => {
        const buf = Buffer.allocUnsafe(size - byteOffset);
        return { buf, bytesRead: readSync(fd, buf, 0, buf.length, byteOffset) };
      });
      byteOffset += bytesRead;
      readConsecutive = 0;
      // Split on the newline BYTE first and decode each complete line on its
      // own (#38); the tail is carried as raw bytes so a character cut by the
      // read boundary is decoded exactly once, whole, on the next pass.
      const fresh = buf.subarray(0, bytesRead);
      const chunk = leftover.length ? Buffer.concat([leftover, fresh]) : fresh;
      // Absolute file offset of chunk[0]: the carried leftover began that
      // many bytes before this read did (#560 — each line's position).
      const base = byteOffset - bytesRead - leftover.length;
      let start = 0;
      for (let nl = chunk.indexOf(0x0a, start); nl >= 0; nl = chunk.indexOf(0x0a, start)) {
        handleLine(chunk.toString("utf-8", start, nl), base + start, base + nl + 1);
        start = nl + 1;
      }
      // Copy the tail so the (possibly large) read buffer can be collected.
      leftover = start < chunk.length ? Buffer.from(chunk.subarray(start)) : EMPTY;
    } catch (e) { noteReadFailure(e); }
  }

  function poll() {
    if (closed) return;
    if (!shouldRetry()) { stopPoll(); return; }
    if (!fsWatcher) { try { armWatcher(); } catch { /* still unwatchable — next tick */ } }
    readNew();
  }

  function stopPoll() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  function attach() {
    if (closed || !shouldRetry()) return;
    try {
      armWatcher();
      readNew();
      pollTimer = setInterval(poll, REPLACE_POLL_MS);
      pollTimer.unref?.();
    } catch {
      fsWatcher = null;
      setTimeout(attach, 500);
    }
  }

  attach();
  return {
    // leftover is bytes, so this is the exact byte offset of the first
    // unconsumed line (#38) — what the session persists as its checkpoint.
    offset() { return byteOffset - leftover.length; },
    close() {
      closed = true;
      stopPoll();
      fsWatcher?.close();
      fsWatcher = null;
    },
  };
}
