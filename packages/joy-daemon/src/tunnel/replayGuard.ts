// Replay guard for the tunnel executor (#418 follow-up). The relay is
// untrusted by design: it can re-post a recorded sealed request as often and
// as late as it likes, and nothing in the envelope stopped the daemon from
// executing it again (the response binding only protects the CLIENT from a
// replayed reply). Two checks close that:
//   - a request whose stream id was already served inside the window is a
//     replay (the stream id is the request's identity — random 16 bytes the
//     client put first on the wire, and the same bytes on every re-post);
//   - a request whose client timestamp `t` is far from now was held back (or
//     is from a badly skewed clock) and is stale.
// Old clients send no `t`: they still get the stream-id check, never the age
// check — so a request older than the window from such a client could be
// replayed once the window has forgotten it. That gap closes as apps update.
// Only an AUTHENTIC (successfully opened) request is recorded: a relay that
// splices a victim's stream id onto other frames cannot poison the guard
// against the victim's real request.
export const REPLAY_MAX_ENTRIES = 10_000;
export const REPLAY_WINDOW_MS = 15 * 60_000;
export const STALE_PAST_MS = 10 * 60_000;
export const STALE_FUTURE_MS = 2 * 60_000;

export type RefusalReason = "replayed_request" | "stale_request";

/** Bounded, time-windowed set of served request stream ids (insertion order
 *  is age order, so expiry and eviction both work from the front). */
export class SeenStreamIds {
  #seen = new Map<string, number>(); // id -> first-seen ms
  readonly #max: number;
  readonly #windowMs: number;
  readonly #now: () => number;

  constructor(opts: { max?: number; windowMs?: number; now?: () => number } = {}) {
    this.#max = opts.max ?? REPLAY_MAX_ENTRIES;
    this.#windowMs = opts.windowMs ?? REPLAY_WINDOW_MS;
    this.#now = opts.now ?? Date.now;
  }

  /** True when `id` was already recorded inside the window (a replay);
   *  otherwise records it and returns false. */
  seenOrRecord(id: string): boolean {
    const t = this.#now();
    for (const [old, at] of this.#seen) {
      if (t - at < this.#windowMs) break;
      this.#seen.delete(old);
    }
    if (this.#seen.has(id)) return true;
    this.#seen.set(id, t);
    while (this.#seen.size > this.#max) this.#seen.delete(this.#seen.keys().next().value as string);
    return false;
  }

  get size(): number { return this.#seen.size; }
}

/** "stale_request" when the client timestamp is too old or too far in the
 *  future; null when it is acceptable — or absent (an older client). */
export function staleReason(t: unknown, now: number = Date.now()): RefusalReason | null {
  if (typeof t !== "number" || !Number.isFinite(t)) return null;
  if (now - t > STALE_PAST_MS || t - now > STALE_FUTURE_MS) return "stale_request";
  return null;
}
