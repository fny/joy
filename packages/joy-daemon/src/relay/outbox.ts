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
import { nextLineState, initialLineState, waitBeforeSend, settlementOf, backoffMs, type LineState, type LineEvent } from "./outboxRow";

export type PostFate =
  | "transient"   // network, 5xx, lease fencing: retry with backoff
  | "permanent"   // the relay refused this row for good: drop it
  | "unbound";    // the session has no relay row yet: park the line until bind wakes it
export type PostResult =
  | { ok: true }
  | {
      ok: false; fate: PostFate; error: string; retryAfterMs?: number;
      /** Permanent only: evidence of the loss that must commit ATOMICALLY
       *  with the row's settlement (#130 — the event-budget drop count).
       *  Runs INSIDE the ledger transaction that drops the row: the row is
       *  settled and the evidence recorded together, or neither is and the
       *  row is retried. A crash between the two used to leave a settled
       *  row, an advanced checkpoint, and no trace of what was lost. */
      settle?: () => void;
    };

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
  /** One line per session (outboxRow.ts): idle / running(gen, wanted, waited) / stopped. */
  #lines = new Map<string, LineState>();
  #running = new Map<string, Promise<void>>();
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
    for (const sid of this.#lines.keys()) this.#send(sid, { type: "stop" });
    for (const [, rs] of this.#waiters) for (const r of rs) r();
    this.#waiters.clear();
  }

  line(sessionId: string): LineState { return this.#lines.get(sessionId) ?? initialLineState(); }

  /** One step of a session's line; starts a loop incarnation when the
   *  machine says so. The machine is stepped SYNCHRONOUSLY and the loop
   *  body starts on a microtask, so a post() that wakes this session while
   *  a row is being sent finds the line running, not idle (#462). */
  #send(sessionId: string, ev: LineEvent): LineState {
    const cur = this.line(sessionId);
    const t = nextLineState(cur, ev);
    if (!t) return cur;
    this.#lines.set(sessionId, t.to);
    if (t.startLoop) this.#startLoop(sessionId, t.to.gen);
    return t.to;
  }

  #startLoop(sessionId: string, gen: number): void {
    const p = Promise.resolve().then(() => this.#loop(sessionId, gen)).catch((e) => {
      this.#o.log(`outbox ${sessionId}: loop crashed: ${e instanceof Error ? e.message : e}`);
      this.#send(sessionId, { type: "exit", gen, reason: "crashed", hasRows: !!this.#o.ledger.nextOutbound(sessionId) });
    }).finally(() => { if (this.#running.get(sessionId) === p) this.#running.delete(sessionId); });
    this.#running.set(sessionId, p);
  }

  /** Ensure a loop is running for the session (a new row, a bind, a retry). */
  wake(sessionId: string): void {
    if (this.#stopped) return;
    this.#send(sessionId, { type: "wake" });
  }

  /** Is a loop active for the session? */
  active(sessionId: string): boolean { return this.line(sessionId).phase === "running"; }

  /** Resolves once the row is acked or dropped, or after `timeoutMs` on the
   *  sender's clock (false). The row keeps being retried in the background
   *  either way. */
  awaitSettled(seq: number, timeoutMs: number): Promise<boolean> {
    const row = this.#o.ledger.getOutbound(seq);
    if (!row || row.ackedAt != null) return Promise.resolve(true);
    const deadline = this.#o.now() + timeoutMs;
    return new Promise<boolean>((resolve) => {
      const list = this.#waiters.get(seq) ?? [];
      let done = false;
      const tick = () => {
        if (done) return;
        if (this.#o.now() >= deadline || this.#stopped) { done = true; resolve(false); return; }
        const t = setTimeout(tick, Math.min(250, Math.max(1, deadline - this.#o.now())));
        t.unref?.();
      };
      tick();
      list.push(() => { if (!done) { done = true; resolve(true); } });
      this.#waiters.set(seq, list);
    });
  }

  #settled(seq: number): void {
    const rs = this.#waiters.get(seq);
    if (!rs) return;
    this.#waiters.delete(seq);
    for (const r of rs) r();
  }

  backoffFor(attempts: number): number { return backoffMs(attempts, this.#o.baseBackoffMs, this.#o.maxBackoffMs); }

  /** One loop incarnation (`gen`) for one session's line. Every decision
   *  is the machine's (outboxRow.ts): the wait before a send, the verdict
   *  on the result, and whether the line goes idle or restarts on exit. */
  async #loop(sessionId: string, gen: number): Promise<void> {
    const { ledger, post, ready, sleep, now, idleMs } = this.#o;
    const exit = (reason: "drained" | "parked") => { this.#send(sessionId, { type: "exit", gen, reason, hasRows: !!ledger.nextOutbound(sessionId) }); };
    for (;;) {
      if (this.#stopped) return;
      this.#send(sessionId, { type: "pass", gen });
      const row = ledger.nextOutbound(sessionId);
      if (!row) return exit("drained");
      if (!ready()) { await sleep(idleMs); continue; }
      const w = waitBeforeSend(row, this.line(sessionId), now(), this.#o.maxBackoffMs);
      if (w.wait > 0) await sleep(w.wait);
      if (w.recheck) continue;
      let r: PostResult;
      try { r = await post(row); }
      catch (e) { r = { ok: false, fate: "transient", error: e instanceof Error ? e.message : String(e) }; }
      if (this.#stopped) return;
      // The row may have been settled by someone else meanwhile (a drop from
      // a bind decision, a test): the verdict is against the row as it is NOW.
      const v = settlementOf(r, ledger.getOutbound(row.seq), this.#o);
      switch (v.verdict) {
        case "already_settled": this.#settled(row.seq); continue;
        case "ack": ledger.ackOutbound(row.seq); this.#settled(row.seq); continue;
        case "drop":
          // One transaction: the drop (and the checkpoint it promotes) and
          // the caller's evidence of it. `settle` joins the drop's
          // transaction, so a throw there rolls the settlement back too and
          // the row is retried.
          if (v.settle) ledger.tx(() => { ledger.dropOutbound(row.seq, v.reason); v.settle!(); }, "drop");
          else ledger.dropOutbound(row.seq, v.reason);
          this.#settled(row.seq);
          continue;
        case "park": return exit("parked"); // bindOutbound + wake() resumes the line
        case "retry":
          ledger.failOutbound(row.seq, v.error, now() + v.delayMs);
          // Sleep the backoff here; the persisted next_retry_at is for a
          // restart, and this incarnation must not sleep it twice.
          await sleep(Math.min(v.delayMs, this.#o.maxBackoffMs));
          this.#send(sessionId, { type: "slept", gen, seq: row.seq });
          continue;
      }
    }
  }
}
