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

export interface ReceiptLog {
  inbound: InboundReceipt[];
  outbound: OutboundReceipt[];
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
      };
    }
  } catch {}
  return { inbound: [], outbound: [] };
}

export function saveReceipts(relaySessionId: string, log: ReceiptLog, baseDir = defaultStateDir()): void {
  try {
    const p = receiptPath(relaySessionId, baseDir);
    const tmp = p + ".tmp";
    writeFileSync(tmp, JSON.stringify(log));
    renameSync(tmp, p);
  } catch (e) {
    process.stderr.write(`[receipts] save failed for ${relaySessionId}: ${e}\n`);
  }
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
