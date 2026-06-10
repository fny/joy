// Transcript file mechanics: locate Claude Code JSONL transcripts and tail
// them as parsed entries. No session semantics here — what an entry *means*
// (turns, receipts, relay events) lives in session.ts; this module only
// knows how to find the file and stream its lines.

import { openSync, readSync, closeSync, statSync, readdirSync, watch } from "fs";
import { join } from "path";
import { homedir } from "os";

/** Claude Code writes transcripts under ~/.claude/projects/<cwd-with-slashes-as-dashes>/ */
export function cwdToTranscriptDir(cwd: string): string {
  return join(homedir(), ".claude", "projects", cwd.replace(/\//g, "-"));
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
): TranscriptTailer {
  let byteOffset = 0;
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
