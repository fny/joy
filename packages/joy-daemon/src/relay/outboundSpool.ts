// Durable outbound spool for the relay lane: every adapter record and every
// turn terminal is written HERE, synchronously, before the lane tries to
// POST it, and removed only once the relay has acknowledged it.
//
// Why: forwardRecord used to fire-and-forget. A 503 or a reset connection
// dropped the record for good, and the turn could terminalize with that
// output missing from the app forever (issue #60); adapters advanced their
// delivered-through checkpoints as soon as the record was HANDED to the
// lane, so a daemon death mid-POST lost the whole turn on recovery (#67); a
// terminal fact the relay rejected twice left the session's execution slot
// held under a live lease with nothing local to release it (#74). With the
// spool, a record survives relay outages and daemon restarts — replayed on
// the next lease with the same runtimeEventId, which the relay dedupes.
//
// Records are stored as the plaintext wire shape (same trust domain as the
// transcripts and the sealed content keys beside it) and encoded at POST
// time, so a session that is not bound yet — a spawn's first output, a
// handoff target's pickup answer — is spooled too and flushed on bind
// instead of being dropped.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { WireRecord } from "./relay";

export interface SpooledOutput {
  kind: "output";
  id: string;
  /** Local (daemon) session id — the only id known before bind. */
  localId: string;
  /** Relay session id once known. */
  v2SessionId: string | null;
  /** The relay turn the record was produced under, if one was running. */
  turnId: string | null;
  wire: WireRecord;
  runtimeEventId: string;
  at: number;
}

export interface SpooledTerminal {
  kind: "terminal";
  id: string;
  v2SessionId: string;
  /** Local session id, so replay can order the terminal after that session's outputs. */
  localId?: string;
  turnId: string;
  body: Record<string, unknown>;
  at: number;
}

export type SpoolEntry = SpooledOutput | SpooledTerminal;

export class OutboundSpool {
  #path: string;
  #entries: SpoolEntry[] = [];

  constructor(path: string) {
    this.#path = path;
    try {
      if (existsSync(path)) {
        const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
        if (Array.isArray(parsed)) this.#entries = parsed.filter((e): e is SpoolEntry => !!e && typeof e === "object" && typeof (e as SpoolEntry).id === "string");
      }
    } catch (e) {
      // A corrupt spool loses its pending records; it never blocks the lane —
      // but say so, loudly: this is data the app will not get.
      process.stderr.write(`[v2-spool] ${path} unreadable (${e instanceof Error ? e.message : e}) — starting empty\n`);
      this.#entries = [];
    }
  }

  /** Pending outputs per local session above which add() reports the spool
   *  as degraded — a backpressure signal that holds adapter checkpoints —
   *  instead of evicting (an evicted record may already be covered by a
   *  checkpoint, so eviction was silent data loss; Astra, a07c43e2). Nothing
   *  is dropped: the entries stay on disk and in the sender's queue. */
  static readonly MAX_OUTPUTS_PER_SESSION = 2_000;

  /** Persist synchronously (tmp + rename) — the caller relies on the record
   *  being on disk before it returns. */
  #save(): boolean {
    try {
      mkdirSync(dirname(this.#path), { recursive: true });
      const tmp = `${this.#path}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.#entries));
      renameSync(tmp, this.#path);
      return true;
    } catch (e) {
      process.stderr.write(`[v2-spool] save failed: ${e instanceof Error ? e.message : e}\n`);
      return false;
    }
  }

  /** Append and persist. `saved` false = the entry is only in memory (the
   *  caller latches persistence as failed until resave() succeeds);
   *  `overflow` = this session's backlog is over the cap (backpressure). */
  add(entry: SpoolEntry): { saved: boolean; overflow: boolean } {
    this.#entries.push(entry);
    const saved = this.#save();
    const overflow = entry.kind === "output" && this.pendingOutputs(entry.localId) > OutboundSpool.MAX_OUTPUTS_PER_SESSION;
    if (overflow && !this.#overflowNoted.has(entry.localId)) {
      this.#overflowNoted.add(entry.localId);
      process.stderr.write(`[v2-spool] ${entry.localId}: over ${OutboundSpool.MAX_OUTPUTS_PER_SESSION} pending outputs — dispatch paused and checkpoints held until the backlog drains\n`);
    }
    return { saved, overflow };
  }
  #overflowNoted = new Set<string>();
  /** Re-persist everything in memory. True only when the disk now holds every
   *  entry — the only thing that ends a latched persistence failure. */
  resave(): boolean { return this.#save(); }
  /** True when ANY session's backlog is over the cap. */
  overflowing(): boolean {
    const counts = new Map<string, number>();
    for (const e of this.#entries) if (e.kind === "output") counts.set(e.localId, (counts.get(e.localId) ?? 0) + 1);
    let any = false;
    for (const [id, n] of counts) { if (n > OutboundSpool.MAX_OUTPUTS_PER_SESSION) any = true; else this.#overflowNoted.delete(id); }
    for (const id of [...this.#overflowNoted]) if (!counts.has(id)) this.#overflowNoted.delete(id);
    return any;
  }

  remove(id: string): void {
    const before = this.#entries.length;
    this.#entries = this.#entries.filter((e) => e.id !== id);
    if (this.#entries.length !== before) this.#save();
  }

  /** Stamp the relay session id on an entry spooled before bind. */
  bind(localId: string, v2SessionId: string): SpooledOutput[] {
    const hits: SpooledOutput[] = [];
    for (const e of this.#entries) {
      if (e.kind === "output" && e.localId === localId && !e.v2SessionId) { e.v2SessionId = v2SessionId; hits.push(e); }
    }
    if (hits.length) this.#save();
    return hits;
  }

  all(): SpoolEntry[] { return [...this.#entries]; }
  get size(): number { return this.#entries.length; }
  hasTerminalFor(turnId: string): boolean { return this.#entries.some((e) => e.kind === "terminal" && e.turnId === turnId); }
  pendingOutputs(localId: string): number { return this.#entries.filter((e) => e.kind === "output" && e.localId === localId).length; }
}
