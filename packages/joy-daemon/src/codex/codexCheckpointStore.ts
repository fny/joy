// Delivered-turn checkpoint for codex reconciliation (gpt-5.6-sol M2 finding #2
// + live finding 2026-07-24). On reconnect we replay thread/read history, but
// the per-ITEM ids differ between live notifications (msg_…/call_…) and history
// (positional item-N), so item-id dedup at the append layer does NOT work
// across a restart. Turn ids ARE stable (UUIDv7 — lexicographically time-
// ordered), so we checkpoint which turns were fully delivered and skip them
// wholesale on reconcile.
//
// A bare Set with a 500-id cap was WRONG (finding #2): after 1000 turns the cap
// evicts old ids, so one restart replays turns 1–500 and the next replays
// 501–1000, duplicating old rows forever. The correct shape is a single
// HIGH-WATER mark, because delivered turns form an ordered PREFIX:
//   - the daemon serializes turns (one active turn/start at a time — finding #4),
//   - the relay drains terminal rows strictly FIFO (a turn-end ACK implies every
//     prior row, including earlier turns' terminals, already landed),
// so terminal turns are ACKed in strictly increasing id order with no gaps. One
// `deliveredThroughTurnId` therefore captures the whole delivered prefix, is
// unbounded-safe (no cap, no eviction), and never falsely covers an undelivered
// turn.

import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { joyStateDir } from "../paths";

export interface CodexCheckpoint {
  threadId: string | null;
  deliveredThroughTurnId: string | null;
  /** clientIds this session dispatched and saw echoed (last 200): ownership
   *  for userMessage items seen again on recovery (#78). */
  knownClientIds?: string[];
}

function empty(): CodexCheckpoint {
  return { threadId: null, deliveredThroughTurnId: null };
}

function fileFor(id: string, baseDir: string): string {
  return join(baseDir, `codex-checkpoint-${id}.json`);
}

export function loadCheckpoint(id: string, baseDir = joyStateDir()): CodexCheckpoint {
  try {
    const p = fileFor(id, baseDir);
    if (!existsSync(p)) return empty();
    const parsed = JSON.parse(readFileSync(p, "utf8")) as Partial<CodexCheckpoint>;
    return {
      threadId: typeof parsed.threadId === "string" ? parsed.threadId : null,
      deliveredThroughTurnId: typeof parsed.deliveredThroughTurnId === "string" ? parsed.deliveredThroughTurnId : null,
      knownClientIds: Array.isArray(parsed.knownClientIds) ? parsed.knownClientIds.filter((x): x is string => typeof x === "string") : undefined,
    };
  } catch { return empty(); }
}

export function saveCheckpoint(id: string, cp: CodexCheckpoint, baseDir = joyStateDir()): void {
  try {
    mkdirSync(baseDir, { recursive: true });
    const p = fileFor(id, baseDir);
    const tmp = `${p}.tmp`;
    writeFileSync(tmp, JSON.stringify(cp));
    renameSync(tmp, p);
  } catch (e) {
    process.stderr.write(`[codex-checkpoint] save failed for ${id}: ${e}\n`);
  }
}

export function clearCheckpoint(id: string, baseDir = joyStateDir()): void {
  try { rmSync(fileFor(id, baseDir), { force: true }); } catch { /* best effort */ }
}

/** Is this turn already delivered per the checkpoint? Turn ids are UUIDv7, so a
 *  lexicographic `<=` against the high-water is a chronological "<=". */
export function isTurnDelivered(cp: CodexCheckpoint, turnId: string): boolean {
  return !!turnId && cp.deliveredThroughTurnId !== null && turnId <= cp.deliveredThroughTurnId;
}

/** Advance the high-water to a newly-delivered turn. Delivery is strictly in
 *  increasing id order (see header), so a delivered turn is always the newest —
 *  this only ever advances, never regresses. Returns a NEW checkpoint (or the
 *  same object when nothing changed). */
export function markTurnDelivered(cp: CodexCheckpoint, turnId: string): CodexCheckpoint {
  if (!turnId) return cp;
  if (cp.deliveredThroughTurnId === null || turnId > cp.deliveredThroughTurnId) {
    return { ...cp, deliveredThroughTurnId: turnId };
  }
  return cp;
}
