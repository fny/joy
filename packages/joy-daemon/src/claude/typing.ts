// Typing into a pane, and recognising a prompt that arrived short.
//
// fny 4477e540, 2026-09-09: a 7,345-character peer message was typed as one
// `send-keys -l` per line, and Claude received 5,696 of it — the loss began at
// character 4,042. That is the pty's input queue: Linux gives a tty 4,096
// bytes of input buffer, and when the application has not read them yet the
// kernel DROPS what arrives beyond it. A TUI that is mid-render does not read.
// So a long line goes down in pieces small enough to fit, with a breath
// between them for the reader.
//
// The second half: the echo of that truncated prompt no longer matched the
// dispatch, so the daemon took it for something a human typed at the terminal
// and mirrored it to the app — the same message twice, one full, one short —
// then timed the dispatch out and paused the queue. A prompt that shares a
// long prefix with the one dispatch in flight is that dispatch, arrived short.

export const TYPE_CHUNK_CHARS = 1024;
export const TYPE_CHUNK_GAP_MS = 20;

/** Split a line into pieces of at most `max` code points (never inside a
 *  surrogate pair). A short line is one piece; an empty line none. */
export function chunkForTyping(line: string, max = TYPE_CHUNK_CHARS): string[] {
  if (line === "") return [];
  const cps = Array.from(line);
  if (cps.length <= max) return [line];
  const out: string[] = [];
  for (let i = 0; i < cps.length; i += max) out.push(cps.slice(i, i + max).join(""));
  return out;
}

export interface GarbledEcho { landed: number; total: number }

/**
 * Is `echo` the in-flight `dispatch`, arrived short? True when the two are not
 * equal but share a prefix of at least `minPrefix` code points — a quarter of
 * the dispatch, floored at 256, so a short genuine follow-up ("yes") can never
 * be mistaken for a truncated 6 KB message. Returns how much landed.
 */
export function garbledEchoOf(echo: string, dispatch: string): GarbledEcho | null {
  if (!echo || !dispatch || echo === dispatch) return null;
  const e = Array.from(echo), d = Array.from(dispatch);
  const minPrefix = Math.max(256, Math.floor(d.length / 4));
  if (e.length < minPrefix) return null;
  let i = 0;
  while (i < e.length && i < d.length && e[i] === d[i]) i++;
  if (i < minPrefix) return null;
  return { landed: e.length, total: d.length };
}
