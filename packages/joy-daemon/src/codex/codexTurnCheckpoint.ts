// Delivered-turn high-water arithmetic for codex reconciliation. The value
// itself lives in the ledger (`checkpoints(kind='codex_turn')`); these are
// the pure comparisons the session applies to it.
//
// Why a single high-water mark and not a set (gpt-5.6-sol M2 finding #2): a
// bare Set with a 500-id cap evicted old ids, so one restart replayed turns
// 1–500 and the next 501–1000, duplicating old rows forever. Delivered turns
// form an ordered PREFIX — the daemon serializes turns and the relay drains
// terminal rows strictly FIFO, so terminal turns are acked in increasing id
// order with no gaps — and codex turn ids are UUIDv7 (lexicographically
// time-ordered), so ONE id captures the whole delivered prefix, unbounded-
// safe, and never falsely covers an undelivered turn.

/** Is `turnId` covered by the high-water `deliveredThrough` (a lexicographic
 *  `<=` is a chronological `<=` for UUIDv7)? */
export function isTurnDelivered(deliveredThrough: string | null | undefined, turnId: string): boolean {
  return !!turnId && !!deliveredThrough && turnId <= deliveredThrough;
}

/** The high-water after delivering `turnId`: only ever advances. */
export function advanceTurnHighWater(deliveredThrough: string | null | undefined, turnId: string): string | null {
  if (!turnId) return deliveredThrough ?? null;
  if (!deliveredThrough || turnId > deliveredThrough) return turnId;
  return deliveredThrough;
}
