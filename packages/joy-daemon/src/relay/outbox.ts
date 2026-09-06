// The outbox scheduler: ONE sender per session, head-of-line, in the
// ledger's persisted order (`outbox.seq`), retrying by the stable
// runtime_event_id (which the relay dedupes). Replaces the nucleus lane's
// per-record chains, its `posting` set, the spool replay pass and the
// terminal's own 60s retry loop + background worker.
//
// What the sender owns: WHEN a row is tried (lease present, next_retry_at
// reached), backoff (persisted in the row, so a restart resumes the
// schedule), and the row's settlement (ack / fail / drop). What the caller
// owns (the lane's `post`): HOW a row is sent — sealing, turn- vs
// session-scoped facts, terminal facts vs reconcile — and the verdict on a
// failure. A terminal row is, by construction, after its session's earlier
// outputs; it is written the instant the outcome is known and sent once the
// line reaches it (#464/#74). Boot is `start()`: every session with unacked
// rows gets a loop — no separate replay pass, no `replayPending` flag (#462).
import type { Ledger, OutboxRow } from "../domain/ledger";

export type PostFate =
  | "transient"   // network, 5xx, lease fencing: retry with backoff
  | "permanent"   // the relay refused this row for good: drop it
  | "unbound";    // the session has no relay row yet: park the line until bind wakes it
export type PostResult = { ok: true } | { ok: false; fate: PostFate; error: string; retryAfterMs?: number };

export interface OutboxSenderOpts {
  ledger: Ledger;
  /** Send one row. Must never throw — a throw is treated as transient. */
  post: (row: OutboxRow) => Promise<PostResult>;
  /** May a row be sent right now (a lease is held)? */
  ready: () => boolean;
  log?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** First retry delay; doubles per attempt up to maxBackoffMs. */
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  /** How long a parked loop (no lease) sleeps between checks. */
  idleMs?: number;
}

export class OutboxSender {
  #o: Required<Pick<OutboxSenderOpts, "ledger" | "post" | "ready" | "sleep" | "now" | "baseBackoffMs" | "maxBackoffMs" | "idleMs">> & { log: (line: string) => void };
  #running = new Map<string, Promise<void>>();
  #wanted = new Set<string>();
  #stopped = false;
  /** Resolvers waiting for a specific seq to settle (ack or drop). */
  #waiters = new Map<number, Array<() => void>>();

  constructor(opts: OutboxSenderOpts) {
    this.#o = {
      ledger: opts.ledger, post: opts.post, ready: opts.ready,
      log: opts.log ?? (() => {}),
      sleep: opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
      now: opts.now ?? Date.now,
      baseBackoffMs: opts.baseBackoffMs ?? 1_000,
      maxBackoffMs: opts.maxBackoffMs ?? 30_000,
      idleMs: opts.idleMs ?? 1_000,
    };
  }

  /** Wake every session that has unacked rows (boot, lease re-acquire, sweep). */
  start(): void {
    if (this.#stopped) return;
    for (const sid of this.#o.ledger.sessionsWithOutbound()) this.wake(sid);
  }

  stop(): void {
    this.#stopped = true;
    for (const [, rs] of this.#waiters) for (const r of rs) r();
    this.#waiters.clear();
  }

  /** Ensure a loop is running for the session (a new row, a bind, a retry). */
  wake(sessionId: string): void {
    if (this.#stopped) return;
    this.#wanted.add(sessionId);
    if (this.#running.has(sessionId)) return;
    // The loop body starts on a microtask, AFTER #running holds it: a post()
    // that wakes this session synchronously (a record produced while sending)
    // must find the loop registered, not start a second one.
    const p = Promise.resolve().then(() => this.#loop(sessionId)).catch((e) => this.#o.log(`outbox ${sessionId}: loop crashed: ${e instanceof Error ? e.message : e}`)).finally(() => {
      this.#running.delete(sessionId);
      // A wake that landed between our last empty read and this cleanup
      // restarts the loop (JS is single-threaded: no wake interleaves the
      // read-then-exit below, but one may land during an awaited post).
      if (this.#wanted.has(sessionId) && !this.#stopped && this.#o.ledger.nextOutbound(sessionId)) this.wake(sessionId);
    });
    this.#running.set(sessionId, p);
  }

  /** Is a loop active for the session? */
  active(sessionId: string): boolean { return this.#running.has(sessionId); }

  /** Resolves once the row is acked or dropped, or after `timeoutMs`
   *  (false). The row keeps being retried in the background either way. */
  awaitSettled(seq: number, timeoutMs: number): Promise<boolean> {
    const row = this.#o.ledger.getOutbound(seq);
    if (!row || row.ackedAt != null) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const list = this.#waiters.get(seq) ?? [];
      let done = false;
      const timer = setTimeout(() => { if (!done) { done = true; resolve(false); } }, timeoutMs);
      timer.unref?.();
      list.push(() => { if (!done) { done = true; clearTimeout(timer); resolve(true); } });
      this.#waiters.set(seq, list);
    });
  }

  #settled(seq: number): void {
    const rs = this.#waiters.get(seq);
    if (!rs) return;
    this.#waiters.delete(seq);
    for (const r of rs) r();
  }

  backoffFor(attempts: number): number {
    return Math.min(this.#o.maxBackoffMs, this.#o.baseBackoffMs * Math.pow(2, Math.max(0, attempts)));
  }

  async #loop(sessionId: string): Promise<void> {
    const { ledger, post, ready, sleep, now, idleMs } = this.#o;
    for (;;) {
      if (this.#stopped) return;
      this.#wanted.delete(sessionId);
      const row = ledger.nextOutbound(sessionId);
      if (!row) return;
      if (!ready()) { await sleep(idleMs); continue; }
      const wait = row.nextRetryAt - now();
      if (wait > 0) { await sleep(Math.min(wait, this.#o.maxBackoffMs)); continue; }
      let r: PostResult;
      try { r = await post(row); }
      catch (e) { r = { ok: false, fate: "transient", error: e instanceof Error ? e.message : String(e) }; }
      if (this.#stopped) return;
      // The row may have been settled by someone else meanwhile (a drop from
      // a bind decision, a test): re-read before writing a verdict.
      const cur = ledger.getOutbound(row.seq);
      if (!cur || cur.ackedAt != null) { this.#settled(row.seq); continue; }
      if (r.ok) {
        ledger.ackOutbound(row.seq);
        this.#settled(row.seq);
        continue;
      }
      if (r.fate === "permanent") {
        ledger.dropOutbound(row.seq, r.error);
        this.#settled(row.seq);
        continue;
      }
      if (r.fate === "unbound") return; // parked: bindOutbound + wake() resumes the line
      const delay = r.retryAfterMs ?? this.backoffFor(cur.attempts);
      ledger.failOutbound(row.seq, r.error, now() + delay);
    }
  }
}
