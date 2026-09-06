// Persistent delivery receipts mapping relay seq numbers ↔ transcript UUIDs.
// Identical user messages are matched sequentially via a FIFO pending queue so
// that repeated text (e.g. two "yes" sends) pairs with the right transcript
// entries in order, regardless of text equality alone.

import { existsSync, mkdirSync, readFileSync } from "fs";
import { join } from "path";
import { joyStateDir } from "../paths";
import { writeFileAtomic } from "./atomicWrite";

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
  return joyStateDir();
}

export function receiptPath(relaySessionId: string, baseDir = defaultStateDir()): string {
  if (!existsSync(baseDir)) mkdirSync(baseDir, { recursive: true });
  return join(baseDir, `${relaySessionId}.receipts.json`);
}

// Row validators (#559): the file parsing as JSON says nothing about its rows.
// A `null` or field-less row passed straight through here and blew up LATER —
// in initDeliveryState's `o.uuid` dereference — outside this function's
// try/catch, so one bad row killed the whole session's delivery state and
// every good receipt beside it. Each row is checked for exactly the fields
// recovery and matching read; bad rows are dropped, good ones kept.
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
function isInbound(v: unknown): v is InboundReceipt {
  return isRecord(v) && typeof v.uuid === "string" && v.uuid.length > 0;
}
function isOutbound(v: unknown): v is OutboundReceipt {
  return isRecord(v) && typeof v.uuid === "string" && v.uuid.length > 0;
}
function isReceived(v: unknown): v is ReceivedEntry {
  return isRecord(v) && typeof v.text === "string" && typeof v.at === "number" && Number.isFinite(v.at);
}
function rows<T>(v: unknown, ok: (x: unknown) => x is T): T[] {
  return Array.isArray(v) ? v.filter(ok) : [];
}

export function loadReceipts(relaySessionId: string, baseDir = defaultStateDir()): ReceiptLog {
  try {
    const p = receiptPath(relaySessionId, baseDir);
    if (existsSync(p)) {
      const parsed = JSON.parse(readFileSync(p, "utf-8")) as unknown;
      const doc = isRecord(parsed) ? parsed : {};
      return {
        inbound: rows(doc.inbound, isInbound),
        outbound: rows(doc.outbound, isOutbound),
        received: rows(doc.received, isReceived),
      };
    }
  } catch {}
  return { inbound: [], outbound: [], received: [] };
}

// Coalesce writes: saveReceipts is called for EVERY forwarded transcript entry,
// and a synchronous whole-file rewrite per entry is O(n²) cumulative IO as the
// log grows (the log IS pruned now — see pruneReceiptLog — since the
// transcript offset checkpoint bounds the replay window). Writes are debounced per session and
// flushed on process exit; only the last ≤300ms can be lost to a hard crash
// (worst case: a handful of entries re-forwarded once after restart).
// Under vitest writes stay synchronous — tests read the file right back
// (same precedent as ENABLE_CONTROL in tmux/driver.ts).
const SAVE_DEBOUNCE_MS = 300;
const IMMEDIATE_SAVES = process.env.VITEST === "true";
// Retry backoff for a save that FAILED (#557). The old flush dropped the
// pending entry before writing; a transient EIO/ENOSPC then left the log
// dirty with nothing scheduled to write it — and because forwardedUuids
// already held the uuid, recording the same receipt again returned early, so
// the receipt could never reach disk. A dirty log now stays pending, with
// bounded backoff, until a write succeeds (or the process exits, where the
// exit flush makes one last attempt).
const RETRY_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000];
interface PendingSave { log: ReceiptLog; baseDir: string; timer: ReturnType<typeof setTimeout> | null; failures: number }
const pendingSaves = new Map<string, PendingSave>();
let exitFlushInstalled = false;

/** One write attempt. Atomic (tmp + fsync + rename): a receipts file is read
 *  back on every restart to rebuild forwardedUuids; a torn write there means
 *  re-forwarding history. Returns whether it landed. */
function writeReceiptsNow(relaySessionId: string, log: ReceiptLog, baseDir: string): boolean {
  try {
    writeFileAtomic(receiptPath(relaySessionId, baseDir), JSON.stringify(log));
    return true;
  } catch (e) {
    process.stderr.write(`[receipts] save failed for ${relaySessionId}: ${e}\n`);
    return false;
  }
}

function installExitFlush(): void {
  if (exitFlushInstalled) return;
  exitFlushInstalled = true;
  process.on("exit", flushReceipts);
}

/** Schedule (or re-schedule) the write for one session's pending entry. */
function scheduleSave(relaySessionId: string, entry: PendingSave, delayMs: number): void {
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = setTimeout(() => {
    entry.timer = null;
    attemptSave(relaySessionId, entry);
  }, delayMs);
  entry.timer.unref?.();
}

/** Write; on success the entry retires, on failure it stays pending and the
 *  next attempt is scheduled with backoff. The entry is only ever removed
 *  from `pendingSaves` AFTER a successful replacement. */
function attemptSave(relaySessionId: string, entry: PendingSave): boolean {
  if (writeReceiptsNow(relaySessionId, entry.log, entry.baseDir)) {
    // Retire only if no newer entry replaced this one meanwhile.
    if (pendingSaves.get(relaySessionId) === entry) pendingSaves.delete(relaySessionId);
    return true;
  }
  entry.failures++;
  installExitFlush();
  scheduleSave(relaySessionId, entry, RETRY_BACKOFF_MS[Math.min(entry.failures, RETRY_BACKOFF_MS.length) - 1]);
  return false;
}

/** Synchronously attempt every pending save (exit hook / tests). Entries whose
 *  write fails STAY pending (with their retry timer re-armed) so a later flush
 *  or timer can still land them. Returns how many are still dirty. */
export function flushReceipts(): number {
  for (const [id, entry] of [...pendingSaves]) {
    if (entry.timer) { clearTimeout(entry.timer); entry.timer = null; }
    attemptSave(id, entry);
  }
  return pendingSaves.size;
}

/** Number of receipt logs with an unwritten (dirty) state — diagnostics/tests. */
export function pendingReceiptSaves(): number {
  return pendingSaves.size;
}

export function saveReceipts(relaySessionId: string, log: ReceiptLog, baseDir = defaultStateDir()): void {
  const existing = pendingSaves.get(relaySessionId);
  // `log` is the live mutable ReceiptLog — the flush serializes its state as of
  // write time, so coalesced entries are all captured. A pending entry for
  // the same session is reused (same object) unless the caller handed us a
  // different log object, which supersedes it.
  const entry: PendingSave = existing && existing.log === log && existing.baseDir === baseDir
    ? existing
    : { log, baseDir, timer: null, failures: existing?.failures ?? 0 };
  if (existing && existing !== entry && existing.timer) clearTimeout(existing.timer);
  pendingSaves.set(relaySessionId, entry);
  if (IMMEDIATE_SAVES) {
    // Under vitest writes stay synchronous — tests read the file right back.
    // A failed immediate write still follows the retry contract above.
    attemptSave(relaySessionId, entry);
    return;
  }
  installExitFlush();
  scheduleSave(relaySessionId, entry, SAVE_DEBOUNCE_MS);
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
// Receipt logs are bounded now that transcript replay is bounded (codex
// review finding 8 — pruning BEFORE the offset checkpoint existed would have
// caused duplicate pushes: recovery replayed whole files relying on
// forwardedUuids). With checkpoints, a replay covers at most the ~5s window
// since the last checkpoint save; 2000 entries is orders of magnitude more
// than that overlap. The in-memory forwardedUuids set keeps everything seen
// this process (broader dedupe is harmless); the pruned log only shapes what
// a RESTART rebuilds — which only needs the checkpoint overlap.
const RECEIPT_LOG_MAX = 2000;
const RECEIPT_LOG_TRIM = 500;
function pruneReceiptLog<T>(log: T[]): void {
  if (log.length > RECEIPT_LOG_MAX) log.splice(0, RECEIPT_LOG_TRIM);
}

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
  pruneReceiptLog(state.receipts.inbound);
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
  pruneReceiptLog(state.receipts.outbound);
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
