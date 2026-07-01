// Persistent delivery receipts mapping relay seq numbers ↔ transcript UUIDs.
// Identical user messages are matched sequentially via a FIFO pending queue so
// that repeated text (e.g. two "yes" sends) pairs with the right transcript
// entries in order, regardless of text equality alone.

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "fs";
import { join } from "path";
import { homedir } from "os";

export type DeliverySource = "relay" | "web" | "rpc";

export interface InboundReceipt {
  seq?: number;             // relay seq (absent for /send and joy-send RPC)
  uuid: string;             // transcript entry uuid Claude assigned
  text: string;             // for forensics / debugging
  source: DeliverySource;
  at: number;               // ms epoch
}

export interface OutboundReceipt {
  uuid: string;             // transcript entry uuid we forwarded
  turn: string;             // turnId used for relay session events ("" for user echo)
  at: number;
}

export interface ReceivedEntry {
  text: string;             // a user message text received from the relay/app
  at: number;               // ms epoch
}

export interface ReceiptLog {
  inbound: InboundReceipt[];
  outbound: OutboundReceipt[];
  // Texts the app sent us (persisted) so their transcript echo is never
  // mirrored back as a duplicate — even if the pending queue is lost to a
  // restart. The resilience backstop behind the in-memory pending match.
  received: ReceivedEntry[];
}

export interface PendingSend {
  seq?: number;
  text: string;
  source: DeliverySource;
  at: number;
}

export interface DeliveryState {
  pending: PendingSend[];
  receipts: ReceiptLog;
  forwardedUuids: Set<string>;
}

export function defaultStateDir(): string {
  return join(homedir(), ".happy", "joy-tmux-state");
}

export function receiptPath(relaySessionId: string, baseDir = defaultStateDir()): string {
  if (!existsSync(baseDir)) mkdirSync(baseDir, { recursive: true });
  return join(baseDir, `${relaySessionId}.receipts.json`);
}

export function loadReceipts(relaySessionId: string, baseDir = defaultStateDir()): ReceiptLog {
  try {
    const p = receiptPath(relaySessionId, baseDir);
    if (existsSync(p)) {
      const parsed = JSON.parse(readFileSync(p, "utf-8")) as ReceiptLog;
      return {
        inbound: Array.isArray(parsed.inbound) ? parsed.inbound : [],
        outbound: Array.isArray(parsed.outbound) ? parsed.outbound : [],
        received: Array.isArray(parsed.received) ? parsed.received : [],
      };
    }
  } catch {}
  return { inbound: [], outbound: [], received: [] };
}

// Coalesce writes: saveReceipts is called for EVERY forwarded transcript entry,
// and a synchronous whole-file rewrite per entry is O(n²) cumulative IO as the
// log grows (the log can't be pruned — forwardedUuids must cover the full
// replay window for restart dedup). Writes are debounced per session and
// flushed on process exit; only the last ≤300ms can be lost to a hard crash
// (worst case: a handful of entries re-forwarded once after restart).
// Under vitest writes stay synchronous — tests read the file right back
// (same precedent as ENABLE_CONTROL in tmux/driver.ts).
const SAVE_DEBOUNCE_MS = 300;
const IMMEDIATE_SAVES = process.env.VITEST === "true";
const pendingSaves = new Map<string, { log: ReceiptLog; baseDir: string; timer: ReturnType<typeof setTimeout> }>();
let exitFlushInstalled = false;

function writeReceiptsNow(relaySessionId: string, log: ReceiptLog, baseDir: string): void {
  try {
    const p = receiptPath(relaySessionId, baseDir);
    const tmp = p + ".tmp";
    writeFileSync(tmp, JSON.stringify(log));
    renameSync(tmp, p);
  } catch (e) {
    process.stderr.write(`[receipts] save failed for ${relaySessionId}: ${e}\n`);
  }
}

/** Synchronously flush every pending debounced save (exit hook / tests). */
export function flushReceipts(): void {
  for (const [id, p] of pendingSaves) {
    clearTimeout(p.timer);
    writeReceiptsNow(id, p.log, p.baseDir);
  }
  pendingSaves.clear();
}

export function saveReceipts(relaySessionId: string, log: ReceiptLog, baseDir = defaultStateDir()): void {
  if (IMMEDIATE_SAVES) {
    writeReceiptsNow(relaySessionId, log, baseDir);
    return;
  }
  if (!exitFlushInstalled) {
    exitFlushInstalled = true;
    process.on("exit", flushReceipts);
  }
  const existing = pendingSaves.get(relaySessionId);
  if (existing) clearTimeout(existing.timer);
  const timer = setTimeout(() => {
    pendingSaves.delete(relaySessionId);
    writeReceiptsNow(relaySessionId, log, baseDir);
  }, SAVE_DEBOUNCE_MS);
  timer.unref?.();
  // `log` is the live mutable ReceiptLog — the flush serializes its state as of
  // write time, so coalesced entries are all captured.
  pendingSaves.set(relaySessionId, { log, baseDir, timer });
}

export function initDeliveryState(relaySessionId: string, baseDir = defaultStateDir()): DeliveryState {
  const receipts = loadReceipts(relaySessionId, baseDir);
  return {
    pending: [],
    receipts,
    // Every transcript uuid we've already handled — both pane-typed entries we
    // mirrored (outbound) AND relay/RPC sends we matched (inbound). After a
    // restart the in-memory pending queue is gone, so this set is what stops a
    // re-tailed user message from being mirrored a second time (duplicate).
    forwardedUuids: new Set([
      ...receipts.outbound.map(o => o.uuid),
      ...receipts.inbound.map(i => i.uuid),
    ]),
  };
}

/**
 * Match a transcript user entry against the pending-send queue.
 * Returns the matched PendingSend (popped from the queue) if the front matches,
 * else null. Sequential matching: identical texts are paired in arrival order.
 */
export function matchPendingForUserEntry(state: DeliveryState, text: string): PendingSend | null {
  const front = state.pending[0];
  if (front && front.text === text) {
    state.pending.shift();
    return front;
  }
  return null;
}

/** Append an inbound receipt to state and persist. Idempotent on uuid. */
export function recordInboundReceipt(
  state: DeliveryState,
  relaySessionId: string,
  receipt: InboundReceipt,
  baseDir = defaultStateDir(),
): void {
  if (state.receipts.inbound.some(r => r.uuid === receipt.uuid)) return;
  // Mark as handled so a re-tail (in-run or after restart) won't re-mirror it.
  state.forwardedUuids.add(receipt.uuid);
  state.receipts.inbound.push(receipt);
  saveReceipts(relaySessionId, state.receipts, baseDir);
}

/** Append an outbound receipt and update the forwardedUuids set. Idempotent on uuid. */
export function recordOutboundReceipt(
  state: DeliveryState,
  relaySessionId: string,
  receipt: OutboundReceipt,
  baseDir = defaultStateDir(),
): void {
  if (state.forwardedUuids.has(receipt.uuid)) return;
  state.forwardedUuids.add(receipt.uuid);
  state.receipts.outbound.push(receipt);
  saveReceipts(relaySessionId, state.receipts, baseDir);
}

const RECEIVED_WINDOW_MS = 15 * 60 * 1000;
const RECEIVED_MAX = 200;

/**
 * Record a user message text the app sent us, so its later transcript echo is
 * recognized as our own and never mirrored back as a duplicate — persisted so
 * it survives a daemon restart. Prunes entries older than the window.
 */
export function recordReceived(state: DeliveryState, relaySessionId: string, text: string, at: number, baseDir = defaultStateDir()): void {
  const cutoff = at - RECEIVED_WINDOW_MS;
  state.receipts.received = state.receipts.received.filter((r) => r.at >= cutoff);
  state.receipts.received.push({ text, at });
  if (state.receipts.received.length > RECEIVED_MAX) {
    state.receipts.received.splice(0, state.receipts.received.length - RECEIVED_MAX);
  }
  saveReceipts(relaySessionId, state.receipts, baseDir);
}

/**
 * If `text` was recently received from the app, consume one matching entry and
 * return true (an echo to suppress). Newest-first so repeated identical sends
 * each pair with one transcript entry.
 */
export function consumeReceived(state: DeliveryState, relaySessionId: string, text: string, now: number, baseDir = defaultStateDir()): boolean {
  const cutoff = now - RECEIVED_WINDOW_MS;
  for (let i = state.receipts.received.length - 1; i >= 0; i--) {
    const r = state.receipts.received[i];
    if (r.at >= cutoff && r.text === text) {
      state.receipts.received.splice(i, 1);
      saveReceipts(relaySessionId, state.receipts, baseDir);
      return true;
    }
  }
  return false;
}
