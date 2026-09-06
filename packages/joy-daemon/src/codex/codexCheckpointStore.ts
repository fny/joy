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
  /** Relay seq → clientId receipts for prompts whose userMessage echo landed
   *  (last SEQ_RECEIPT_CAP). The echo REMOVES the spool entry, so the spool
   *  alone forgot a seq the moment it was confirmed — a redelivery of that seq
   *  after completion (crash-before-cursor-persist) started the prompt again
   *  (#516). clientUserMessageId is correlation, not server idempotency, so
   *  the daemon must remember what it already accepted. Consulted by enqueue
   *  live AND after a restart (loaded with the checkpoint). */
  seqReceipts?: SeqReceipt[];
}

export interface SeqReceipt { seq: number; clientId: string }

/** Bound on remembered seq receipts. The relay redelivers only the seqs after
 *  its confirmed cursor — a window of a few messages — so 500 is generous. */
export const SEQ_RECEIPT_CAP = 500;

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
      seqReceipts: Array.isArray(parsed.seqReceipts)
        ? parsed.seqReceipts.filter((r): r is SeqReceipt => !!r && typeof r === "object" && typeof (r as SeqReceipt).seq === "number" && typeof (r as SeqReceipt).clientId === "string")
        : undefined,
    };
  } catch { return empty(); }
}

export function saveCheckpoint(id: string, cp: CodexCheckpoint, baseDir = joyStateDir()): boolean {
  try {
    mkdirSync(baseDir, { recursive: true });
    const p = fileFor(id, baseDir);
    const tmp = `${p}.tmp`;
    writeFileSync(tmp, JSON.stringify(cp));
    renameSync(tmp, p);
    return true;
  } catch (e) {
    process.stderr.write(`[codex-checkpoint] save failed for ${id}: ${e}\n`);
    return false;
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

/** Remember that the prompt for relay `seq` (dispatched as `clientId`) was
 *  confirmed by its echo (#516). Returns a NEW checkpoint; bounded FIFO. */
export function recordSeqReceipt(cp: CodexCheckpoint, seq: number, clientId: string): CodexCheckpoint {
  const prior = (cp.seqReceipts ?? []).filter((r) => r.seq !== seq);
  return { ...cp, seqReceipts: [...prior, { seq, clientId }].slice(-SEQ_RECEIPT_CAP) };
}

/** The clientId a confirmed relay `seq` was delivered under, if remembered. */
export function seqReceiptFor(cp: CodexCheckpoint, seq: number): string | null {
  return cp.seqReceipts?.find((r) => r.seq === seq)?.clientId ?? null;
}
