// The durable acceptance ledger (review campaign 2026-09, architecture item
// 3 / Wave C1). ONE SQLite database per relay state dir replaces the per-
// session JSON stores that each had their own notion of "accepted":
// `queue-<id>.json`, `<id>.receipts.json`, `v2-outbound.json`,
// `codex-inbound-<id>.json`, `codex-checkpoint-<id>.json`, `v2-spawns.json`
// and the execution fields of `window-<id>.json`.
//
// Contract (Astra §1): acceptance is the COMMIT of a transaction. Every public
// method is synchronous, runs inside `BEGIN IMMEDIATE … COMMIT`, and returns
// only after the WAL frame is fsync'd (`synchronous=FULL`). A method either
// returns the row it wrote or throws — no boolean "saved". Five identities
// stay distinct: command id (the queue item id the app sees), payload
// version, session generation, runtime attempt id, event sequence (outbox
// seq / runtime_event_id). Confirmed deliveries live in a retained receipt
// table that survives the command row's pruning (#516).
//
// Rules encoded HERE, not in callers:
//   - acceptCommand refuses a session whose current generation is closed
//     (SessionEndedError, #553) and dedupes a re-pulled relay seq against
//     both the pending row and the retained receipt (#516);
//   - recordAttempt refuses a command whose cancel was requested — the row is
//     cancelled instead of dispatched (#77/#35);
//   - every write that names a generation is refused when that generation is
//     not the session's current one (StaleGenerationError — #481, #36);
//   - a checkpoint recorded while its outputs are still unacked stays
//     PENDING until the outbox acks them; a crash before that replays from
//     the previous checkpoint, receipt-deduped, never skipping output (#67);
//   - a SETTLEMENT (settleAttempt / confirmDelivery, and the attempt effects
//     of recordObservation) changes the command only under the current-owner
//     rule: the claimed generation (explicit, else the attempt's own) is the
//     session's current open one AND the attempt is the command's newest.
//     Anything else is a late/stale echo: it is recorded as a
//     `stale_settlement` observation on ITS OWN attempt (ownership of a late
//     echo is preserved) but never moves the command's state or supersedes
//     the newer attempt (review 95c4781e, wave C1). transition / setCheckpoint
//     / acceptCommand take an optional generation (+ expectedAttemptId) and
//     refuse when it is not current.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { joyStateDir } from "../paths";

// ── errors ───────────────────────────────────────────────────────────────────

/** A write did not commit; nothing was applied (ROLLBACK). */
export class LedgerWriteError extends Error {
  phase: string;
  override cause: unknown;
  constructor(phase: string, cause: unknown) {
    super(`ledger ${phase} failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "LedgerWriteError";
    this.phase = phase;
    this.cause = cause;
  }
}
/** The named generation is no longer the session's current one (#481). */
export class StaleGenerationError extends LedgerWriteError {
  constructor(sessionId: string, generation: number, current: number | null) {
    super("generation fence", `${sessionId}: generation ${generation} is not current (${current ?? "none"})`);
    this.name = "StaleGenerationError";
  }
}
/** The session's current generation is closed: nothing will run it (#553). */
export class SessionEndedError extends LedgerWriteError {
  constructor(sessionId: string) {
    super("accept", `${sessionId}: session ended`);
    this.name = "SessionEndedError";
  }
}
/** A CAS precondition on a command failed where the caller needed it to hold. */
export class StaleCommandError extends LedgerWriteError {
  constructor(commandId: string, detail: string) {
    super("command", `${commandId}: ${detail}`);
    this.name = "StaleCommandError";
  }
}
/** A caller-chosen command id already names another session's command.
 *  Command ids are global (one `commands` row per id): the same id may be
 *  re-accepted only by the session that owns it (that is the dedupe), never
 *  claimed by a second session (review 7652e686). */
export class CommandIdConflictError extends LedgerWriteError {
  commandId: string; ownerSessionId: string;
  constructor(commandId: string, ownerSessionId: string, sessionId: string) {
    super("accept", `${commandId}: owned by session ${ownerSessionId}, not ${sessionId}`);
    this.name = "CommandIdConflictError";
    this.commandId = commandId; this.ownerSessionId = ownerSessionId;
  }
}

// ── rows ─────────────────────────────────────────────────────────────────────

export type CommandState = "queued" | "submitting" | "accepted" | "unknown" | "running" | "cancelling"
  | "completed" | "failed" | "cancelled" | "interrupted";
export const TERMINAL_STATES: readonly CommandState[] = ["completed", "failed", "cancelled", "interrupted"];
export const NON_TERMINAL_STATES: readonly CommandState[] = ["queued", "submitting", "accepted", "unknown", "running", "cancelling"];
export const isTerminalState = (s: string): boolean => (TERMINAL_STATES as readonly string[]).includes(s);

export type AttemptState = "submitting" | "accepted" | "unknown" | "rejected" | "superseded" | "done";
/** Attempt states that still await evidence from the runtime (echo matching). */
export const AWAITING_ATTEMPT_STATES: readonly AttemptState[] = ["submitting", "accepted", "unknown"];

export interface CommandRow {
  id: string; sessionId: string; origin: string; source: string;
  seq: number | null; relayTurnId: string | null; relayCommandId: string | null;
  text: string; payloadVersion: number; visible: boolean; mirrorToRelay: boolean;
  position: number; state: CommandState;
  cancelRequestedAt: number | null; cancelAttempts: number; activeOp: string | null;
  terminalReason: string | null; createdAt: number; updatedAt: number;
}
export interface AttemptRow {
  id: string; commandId: string; sessionId: string; generation: number; attemptNo: number; payloadVersion: number;
  runtimeRef: string | null; runtimeTurnId: string | null; state: AttemptState;
  submittedAt: number; settledAt: number | null; detail: string | null;
}
export interface ObservationRow {
  id: number; sessionId: string; generation: number; attemptId: string | null;
  kind: string; ref: string | null; payload: unknown; at: number;
}
export interface OutboxRow {
  seq: number; sessionId: string; generation: number; kind: "output" | "terminal";
  runtimeEventId: string; relayTurnId: string | null; v2SessionId: string | null;
  sealed: boolean; keyB64: string | null; body: unknown; bytes: number; createdAt: number;
  ackedAt: number | null; attempts: number; nextRetryAt: number; lastError: string | null;
}
export interface ReceiptRow { sessionId: string; kind: string; ref: string; commandId: string | null; attemptId: string | null; at: number }
export interface CheckpointRow {
  sessionId: string; kind: string; ref: string; offset: number; updatedAt: number;
  pendingRef: string | null; pendingOffset: number | null; pendingThroughSeq: number | null;
}
export interface GenerationRow { sessionId: string; generation: number; agent: string; startedAt: number; endedAt: number | null; endReason: string | null }
export interface SpawnIntentRow { relayCommandId: string; localSessionId: string; createdAt: number; boundAt: number | null }
export interface JobRow { id: string; sessionId: string; kind: string; payload: unknown; updatedAt: number }

export interface NewCommand {
  sessionId: string; text: string;
  /** relay | local | handoff | reinjection | steer | import */
  origin?: string;
  /** DeliverySource: relay | web | rpc */
  source: string;
  seq?: number | null; relayTurnId?: string | null; relayCommandId?: string | null;
  visible: boolean; mirrorToRelay: boolean;
  /** Caller-chosen id (a restart carrying a prompt over keeps its id). */
  id?: string;
  createdAt?: number;
  /** Initial state (default queued). The import uses it for rows that were mid-flight. */
  state?: CommandState;
  /** The accepting owner's generation: refused (StaleGenerationError) when it
   *  is not the session's current open one. Omitted by the import (no
   *  generation is open) and by callers with no runtime of their own. */
  generation?: number;
}
export interface NewReceipt { kind: string; ref: string; commandId?: string | null; attemptId?: string | null; at?: number }
export interface NewOutbound {
  sessionId: string; kind: "output" | "terminal"; runtimeEventId: string;
  relayTurnId?: string | null; v2SessionId?: string | null; sealed: boolean; keyB64?: string | null;
  body: unknown; generation?: number; createdAt?: number;
}
export interface NewObservation { sessionId: string; generation: number; attemptId?: string | null; kind: string; ref?: string | null; payload?: unknown; at?: number }
export interface ObservationEffects {
  receipts?: NewReceipt[];
  outbox?: NewOutbound[];
  command?: { id: string; from?: CommandState[]; to: CommandState; terminalReason?: string };
  attempt?: { id: string; outcome: AttemptState; runtimeTurnId?: string; detail?: string };
  /** Becomes pending until every outbox row this observation (and any
   *  earlier one) produced is acked — see setCheckpoint. */
  checkpoint?: { kind: string; ref: string; offset: number };
}

export interface PrunePolicy {
  /** Terminal commands (with their attempts), acked outbox rows and receipts older than this are removed. */
  terminalOlderThanMs: number;
  observationsOlderThanMs: number;
}
/** 7-day retention for terminal rows (campaign decision, 2026-09-06). */
export const DEFAULT_PRUNE_POLICY: PrunePolicy = { terminalOlderThanMs: 7 * 24 * 3_600_000, observationsOlderThanMs: 7 * 24 * 3_600_000 };

/** Backpressure thresholds per session (design §1.5). */
export const OUTBOX_MAX_ROWS = 2_000;
export const OUTBOX_MAX_BYTES = 64 * 1024 * 1024;

const SCHEMA_VERSION = 1;
const SCHEMA = `
CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS session_generations (
  session_id TEXT NOT NULL, generation INTEGER NOT NULL, agent TEXT NOT NULL,
  started_at INTEGER NOT NULL, ended_at INTEGER, end_reason TEXT,
  PRIMARY KEY (session_id, generation));
CREATE TABLE IF NOT EXISTS commands (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, origin TEXT NOT NULL, source TEXT NOT NULL,
  seq INTEGER, relay_turn_id TEXT, relay_command_id TEXT,
  text TEXT NOT NULL, payload_version INTEGER NOT NULL DEFAULT 1,
  visible INTEGER NOT NULL, mirror_to_relay INTEGER NOT NULL, position INTEGER NOT NULL,
  state TEXT NOT NULL, cancel_requested_at INTEGER, cancel_attempts INTEGER NOT NULL DEFAULT 0,
  active_op TEXT, terminal_reason TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE (session_id, seq), UNIQUE (relay_turn_id));
CREATE INDEX IF NOT EXISTS commands_pending ON commands(session_id, position)
  WHERE state NOT IN ('completed','failed','cancelled','interrupted');
CREATE INDEX IF NOT EXISTS commands_updated ON commands(updated_at);
CREATE TABLE IF NOT EXISTS attempts (
  id TEXT PRIMARY KEY, command_id TEXT NOT NULL REFERENCES commands(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL, generation INTEGER NOT NULL, attempt_no INTEGER NOT NULL,
  payload_version INTEGER NOT NULL, runtime_ref TEXT, runtime_turn_id TEXT, state TEXT NOT NULL,
  submitted_at INTEGER NOT NULL, settled_at INTEGER, detail TEXT,
  UNIQUE (command_id, attempt_no));
CREATE INDEX IF NOT EXISTS attempts_ref ON attempts(session_id, runtime_ref);
CREATE INDEX IF NOT EXISTS attempts_state ON attempts(session_id, state);
CREATE TABLE IF NOT EXISTS observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, generation INTEGER NOT NULL,
  attempt_id TEXT, kind TEXT NOT NULL, ref TEXT, payload TEXT, at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS observations_at ON observations(at);
CREATE TABLE IF NOT EXISTS outbox (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, generation INTEGER NOT NULL,
  kind TEXT NOT NULL, runtime_event_id TEXT NOT NULL UNIQUE, relay_turn_id TEXT, v2_session_id TEXT,
  sealed INTEGER NOT NULL, key_b64 TEXT, body TEXT NOT NULL, bytes INTEGER NOT NULL,
  created_at INTEGER NOT NULL, acked_at INTEGER, attempts INTEGER NOT NULL DEFAULT 0,
  next_retry_at INTEGER NOT NULL DEFAULT 0, last_error TEXT);
CREATE INDEX IF NOT EXISTS outbox_pending ON outbox(session_id, seq) WHERE acked_at IS NULL;
CREATE INDEX IF NOT EXISTS outbox_acked ON outbox(acked_at) WHERE acked_at IS NOT NULL;
CREATE TABLE IF NOT EXISTS receipts (
  session_id TEXT NOT NULL, kind TEXT NOT NULL, ref TEXT NOT NULL,
  command_id TEXT, attempt_id TEXT, at INTEGER NOT NULL,
  PRIMARY KEY (session_id, kind, ref));
CREATE INDEX IF NOT EXISTS receipts_at ON receipts(at);
CREATE TABLE IF NOT EXISTS checkpoints (
  session_id TEXT NOT NULL, kind TEXT NOT NULL, ref TEXT NOT NULL, offset INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL, pending_ref TEXT, pending_offset INTEGER, pending_through_seq INTEGER,
  PRIMARY KEY (session_id, kind));
CREATE TABLE IF NOT EXISTS spawn_intents (
  relay_command_id TEXT PRIMARY KEY, local_session_id TEXT NOT NULL,
  created_at INTEGER NOT NULL, bound_at INTEGER);
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, kind TEXT NOT NULL,
  payload TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS import_sources (
  path TEXT PRIMARY KEY, content_hash TEXT NOT NULL, imported_at INTEGER NOT NULL);
`;

/** Observation kind recorded for a settlement that failed the current-owner rule. */
export const STALE_SETTLEMENT_KIND = "stale_settlement";
export interface ImportSourceRow { path: string; contentHash: string; importedAt: number }
interface StaleSettlement { reason: string; claimedGeneration: number; claimIsCurrent: boolean; currentGeneration: number | null; currentAttemptId: string | null }

const b = (v: boolean | undefined | null): number => (v ? 1 : 0);
const placeholders = (n: number): string => Array.from({ length: n }, () => "?").join(",");

type Raw = Record<string, unknown>;
const rowCommand = (r: Raw): CommandRow => ({
  id: r.id as string, sessionId: r.session_id as string, origin: r.origin as string, source: r.source as string,
  seq: r.seq as number | null, relayTurnId: r.relay_turn_id as string | null, relayCommandId: r.relay_command_id as string | null,
  text: r.text as string, payloadVersion: r.payload_version as number, visible: !!r.visible, mirrorToRelay: !!r.mirror_to_relay,
  position: r.position as number, state: r.state as CommandState,
  cancelRequestedAt: r.cancel_requested_at as number | null, cancelAttempts: r.cancel_attempts as number, activeOp: r.active_op as string | null,
  terminalReason: r.terminal_reason as string | null, createdAt: r.created_at as number, updatedAt: r.updated_at as number,
});
const rowAttempt = (r: Raw): AttemptRow => ({
  id: r.id as string, commandId: r.command_id as string, sessionId: r.session_id as string, generation: r.generation as number,
  attemptNo: r.attempt_no as number, payloadVersion: r.payload_version as number, runtimeRef: r.runtime_ref as string | null,
  runtimeTurnId: r.runtime_turn_id as string | null, state: r.state as AttemptState,
  submittedAt: r.submitted_at as number, settledAt: r.settled_at as number | null, detail: r.detail as string | null,
});
const parseJson = (s: unknown): unknown => { if (typeof s !== "string") return null; try { return JSON.parse(s); } catch { return null; } };
const rowOutbox = (r: Raw): OutboxRow => ({
  seq: r.seq as number, sessionId: r.session_id as string, generation: r.generation as number, kind: r.kind as "output" | "terminal",
  runtimeEventId: r.runtime_event_id as string, relayTurnId: r.relay_turn_id as string | null, v2SessionId: r.v2_session_id as string | null,
  sealed: !!r.sealed, keyB64: r.key_b64 as string | null, body: parseJson(r.body), bytes: r.bytes as number, createdAt: r.created_at as number,
  ackedAt: r.acked_at as number | null, attempts: r.attempts as number, nextRetryAt: r.next_retry_at as number, lastError: r.last_error as string | null,
});
const rowReceipt = (r: Raw): ReceiptRow => ({
  sessionId: r.session_id as string, kind: r.kind as string, ref: r.ref as string,
  commandId: r.command_id as string | null, attemptId: r.attempt_id as string | null, at: r.at as number,
});
const rowCheckpoint = (r: Raw): CheckpointRow => ({
  sessionId: r.session_id as string, kind: r.kind as string, ref: r.ref as string, offset: r.offset as number, updatedAt: r.updated_at as number,
  pendingRef: r.pending_ref as string | null, pendingOffset: r.pending_offset as number | null, pendingThroughSeq: r.pending_through_seq as number | null,
});
const rowGeneration = (r: Raw): GenerationRow => ({
  sessionId: r.session_id as string, generation: r.generation as number, agent: r.agent as string,
  startedAt: r.started_at as number, endedAt: r.ended_at as number | null, endReason: r.end_reason as string | null,
});
const rowObservation = (r: Raw): ObservationRow => ({
  id: r.id as number, sessionId: r.session_id as string, generation: r.generation as number, attemptId: r.attempt_id as string | null,
  kind: r.kind as string, ref: r.ref as string | null, payload: parseJson(r.payload), at: r.at as number,
});

// ── the ledger ───────────────────────────────────────────────────────────────

export class Ledger {
  readonly path: string;
  readonly stateDir: string;
  #db: DatabaseSync;
  #now: () => number;
  #txDepth = 0;
  #closed = false;

  static path(stateDir: string): string { return join(stateDir, "ledger.sqlite"); }

  /** Open (creating + migrating) the ledger for a state dir. */
  static open(stateDir: string, opts: { now?: () => number } = {}): Ledger {
    return new Ledger(stateDir, opts.now ?? Date.now);
  }

  private constructor(stateDir: string, now: () => number) {
    mkdirSync(stateDir, { recursive: true });
    this.stateDir = stateDir;
    this.path = Ledger.path(stateDir);
    this.#now = now;
    this.#db = new DatabaseSync(this.path);
    // WAL + FULL: a COMMIT returns only after its WAL frame is fsync'd — the
    // power-loss durability the "returns only after commit" contract needs
    // (WAL/NORMAL only survives a process crash). busy_timeout covers a
    // reader (a diagnostic `sqlite3` shell) holding a lock briefly.
    this.#db.exec("PRAGMA journal_mode=WAL");
    this.#db.exec("PRAGMA synchronous=FULL");
    this.#db.exec("PRAGMA foreign_keys=ON");
    this.#db.exec("PRAGMA busy_timeout=5000");
    this.#db.exec("PRAGMA wal_autocheckpoint=1000");
    this.tx(() => {
      this.#db.exec(SCHEMA);
      const v = this.#get("SELECT value FROM schema_meta WHERE key='version'");
      if (!v) this.#run("INSERT INTO schema_meta(key,value) VALUES('version',?)", String(SCHEMA_VERSION));
    });
  }

  get closed(): boolean { return this.#closed; }
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    try { this.#db.close(); } catch { /* already closed */ }
  }

  /** Tests: the underlying handle (to inject write failures). */
  get db(): DatabaseSync { return this.#db; }

  // ── transactions ──
  #run(sql: string, ...params: Array<string | number | bigint | null>): { changes: number | bigint } {
    return this.#db.prepare(sql).run(...params);
  }
  #get(sql: string, ...params: Array<string | number | bigint | null>): Raw | undefined {
    return this.#db.prepare(sql).get(...params) as Raw | undefined;
  }
  #all(sql: string, ...params: Array<string | number | bigint | null>): Raw[] {
    return this.#db.prepare(sql).all(...params) as Raw[];
  }

  /** `BEGIN IMMEDIATE; fn(); COMMIT` — rollback + rethrow on error. Nested
   *  calls join the outer transaction. A thrown LedgerWriteError means
   *  nothing inside was applied. */
  tx<T>(fn: () => T, phase = "tx"): T {
    if (this.#txDepth > 0) { this.#txDepth++; try { return fn(); } finally { this.#txDepth--; } }
    this.#txDepth = 1;
    try {
      this.#db.exec("BEGIN IMMEDIATE");
    } catch (e) {
      this.#txDepth = 0;
      throw new LedgerWriteError(phase, e);
    }
    let out: T;
    try {
      out = fn();
    } catch (e) {
      try { this.#db.exec("ROLLBACK"); } catch { /* the connection may be gone */ }
      this.#txDepth = 0;
      throw e instanceof LedgerWriteError ? e : new LedgerWriteError(phase, e);
    }
    try {
      this.#db.exec("COMMIT");
    } catch (e) {
      try { this.#db.exec("ROLLBACK"); } catch { /* ditto */ }
      throw new LedgerWriteError(phase, e);
    } finally {
      this.#txDepth = 0;
    }
    return out;
  }

  // ── meta ──
  getMeta(key: string): string | null {
    return (this.#get("SELECT value FROM schema_meta WHERE key=?", key)?.value as string | undefined) ?? null;
  }
  setMeta(key: string, value: string): void {
    this.tx(() => { this.#run("INSERT OR REPLACE INTO schema_meta(key,value) VALUES(?,?)", key, value); }, "meta");
  }

  // ── import markers ──
  /** The legacy-import marker for a source file (its state-dir-relative
   *  name): committed INSIDE the file's import transaction, so "this file is
   *  done" is a ledger fact, not an inference from the file having moved. */
  getImportSource(path: string): ImportSourceRow | null {
    const r = this.#get("SELECT * FROM import_sources WHERE path=?", path);
    return r ? { path: r.path as string, contentHash: r.content_hash as string, importedAt: r.imported_at as number } : null;
  }
  recordImportSource(path: string, contentHash: string): void {
    this.tx(() => { this.#run("INSERT OR REPLACE INTO import_sources(path,content_hash,imported_at) VALUES(?,?,?)", path, contentHash, this.#now()); }, "importSource");
  }

  // ── generations ──
  /** Open a new generation for a session (1 = first launch of the id). Any
   *  generation still open is closed as superseded; attempts that were
   *  awaiting evidence under it become `unknown` — a crash between a
   *  submit and its echo is an explicit unknown outcome, never a blind
   *  resend (Astra §1). Queued commands stay queued. */
  openGeneration(sessionId: string, agent: string, reason = "superseded"): number {
    return this.tx(() => {
      const now = this.#now();
      const cur = this.#get("SELECT generation, ended_at FROM session_generations WHERE session_id=? ORDER BY generation DESC LIMIT 1", sessionId);
      const next = cur ? (cur.generation as number) + 1 : 1;
      if (cur && cur.ended_at == null) this.#closeGenerationInner(sessionId, cur.generation as number, reason, now);
      this.#run("INSERT INTO session_generations(session_id,generation,agent,started_at) VALUES(?,?,?,?)", sessionId, next, agent, now);
      return next;
    }, "openGeneration");
  }

  /** Close a generation. `restart` keeps queued commands (the replacement
   *  takes them); every other reason interrupts them too — an ended session
   *  will never deliver, and the app must not be told otherwise. Any command
   *  mid-flight is `interrupted` with the reason (its attempt → unknown). */
  closeGeneration(sessionId: string, generation: number, reason: string, opts: { keepQueued?: boolean } = {}): void {
    this.tx(() => {
      const row = this.#get("SELECT ended_at FROM session_generations WHERE session_id=? AND generation=?", sessionId, generation);
      if (!row || row.ended_at != null) return;
      this.#closeGenerationInner(sessionId, generation, reason, this.#now(), opts.keepQueued);
    }, "closeGeneration");
  }
  #closeGenerationInner(sessionId: string, generation: number, reason: string, now: number, keepQueued?: boolean): void {
    this.#run("UPDATE session_generations SET ended_at=?, end_reason=? WHERE session_id=? AND generation=?", now, reason, sessionId, generation);
    this.#run(`UPDATE attempts SET state='unknown', settled_at=?, detail=? WHERE session_id=? AND generation=? AND state='submitting'`,
      now, `generation closed: ${reason}`, sessionId, generation);
    if (keepQueued ?? (reason === "restart" || reason === "superseded")) {
      // The replacement (or the next daemon) owns the session: queued rows
      // stay queued; anything mid-flight is an explicit UNKNOWN outcome the
      // adapter reconciles before any resend (codex thread/read; claude
      // re-dispatches, as it always has).
      this.#run(`UPDATE commands SET state='unknown', active_op=NULL, updated_at=? WHERE session_id=? AND state IN ('submitting','accepted','running','cancelling')`, now, sessionId);
      return;
    }
    this.#run(`UPDATE commands SET state='interrupted', terminal_reason=?, active_op=NULL, updated_at=? WHERE session_id=? AND state IN (${placeholders(NON_TERMINAL_STATES.length)})`,
      reason, now, sessionId, ...NON_TERMINAL_STATES);
    this.#run("UPDATE attempts SET state='superseded', settled_at=? WHERE session_id=? AND state IN ('accepted','unknown')", now, sessionId);
  }

  /** An `unknown` command the adapter decided to dispatch again: back to
   *  queued (its earlier attempt stays settled as unknown, still matchable
   *  by its runtime ref — a late echo of the first submission dedupes). */
  requeueCommand(id: string): boolean {
    return this.tx(() => Number(this.#run("UPDATE commands SET state='queued', active_op=NULL, updated_at=? WHERE id=? AND state='unknown'", this.#now(), id).changes) > 0, "requeue");
  }

  currentGeneration(sessionId: string): { generation: number; open: boolean; agent: string } | null {
    const r = this.#get("SELECT * FROM session_generations WHERE session_id=? ORDER BY generation DESC LIMIT 1", sessionId);
    return r ? { generation: r.generation as number, open: r.ended_at == null, agent: r.agent as string } : null;
  }
  listGenerations(sessionId: string): GenerationRow[] {
    return this.#all("SELECT * FROM session_generations WHERE session_id=? ORDER BY generation", sessionId).map(rowGeneration);
  }
  #isCurrent(sessionId: string, generation: number): boolean {
    const cur = this.currentGeneration(sessionId);
    return !!cur && cur.generation === generation && cur.open;
  }
  #fence(sessionId: string, generation: number): void {
    if (!this.#isCurrent(sessionId, generation)) throw new StaleGenerationError(sessionId, generation, this.currentGeneration(sessionId)?.generation ?? null);
  }

  // ── commands ──
  /** Accept a command: the COMMIT of this insert is the acceptance. Returns
   *  the row and how it was deduped: `pending` = a non-terminal row for this
   *  seq / id already exists (same id back, no second row); `receipt` = the
   *  seq was already delivered (the retained receipt or the terminal row
   *  says so) — the caller acks the redelivery without dispatching (#516).
   *  A caller-chosen id that another session already owns is refused
   *  (CommandIdConflictError): ids are global, dedupe is per owner. */
  acceptCommand(c: NewCommand): { id: string; deduped: "none" | "pending" | "receipt"; row: CommandRow | null } {
    return this.tx(() => {
      const gen = this.currentGeneration(c.sessionId);
      if (gen && !gen.open) throw new SessionEndedError(c.sessionId);
      if (c.generation != null) this.#fence(c.sessionId, c.generation);
      const now = c.createdAt ?? this.#now();
      if (c.id) {
        const existing = this.getCommand(c.id);
        if (existing && existing.sessionId !== c.sessionId) throw new CommandIdConflictError(c.id, existing.sessionId, c.sessionId);
        if (existing) return { id: existing.id, deduped: isTerminalState(existing.state) ? "receipt" : "pending", row: existing };
      }
      if (c.seq != null) {
        const bySeq = this.commandForSeq(c.sessionId, c.seq);
        if (bySeq) return { id: bySeq.id, deduped: isTerminalState(bySeq.state) ? "receipt" : "pending", row: bySeq };
        const receipt = this.getReceipt(c.sessionId, "seq", String(c.seq));
        if (receipt) return { id: receipt.commandId ?? `seq:${c.seq}`, deduped: "receipt", row: null };
      }
      if (c.relayTurnId) {
        const byTurn = this.commandForRelayTurn(c.relayTurnId);
        if (byTurn) return { id: byTurn.id, deduped: isTerminalState(byTurn.state) ? "receipt" : "pending", row: byTurn };
      }
      const id = c.id ?? randomUUID().slice(0, 8);
      const pos = (this.#get("SELECT COALESCE(MAX(position),0) AS p FROM commands WHERE session_id=?", c.sessionId)?.p as number) + 1;
      this.#run(
        `INSERT INTO commands(id,session_id,origin,source,seq,relay_turn_id,relay_command_id,text,payload_version,visible,mirror_to_relay,position,state,created_at,updated_at)
         VALUES(?,?,?,?,?,?,?,?,1,?,?,?,?,?,?)`,
        id, c.sessionId, c.origin ?? (c.seq != null ? "relay" : "local"), c.source, c.seq ?? null, c.relayTurnId ?? null, c.relayCommandId ?? null,
        c.text, b(c.visible), b(c.mirrorToRelay), pos, c.state ?? "queued", now, now,
      );
      return { id, deduped: "none", row: this.getCommand(id)! };
    }, "accept");
  }

  getCommand(id: string): CommandRow | null {
    const r = this.#get("SELECT * FROM commands WHERE id=?", id);
    return r ? rowCommand(r) : null;
  }
  commandForRelayTurn(relayTurnId: string): CommandRow | null {
    const r = this.#get("SELECT * FROM commands WHERE relay_turn_id=?", relayTurnId);
    return r ? rowCommand(r) : null;
  }
  commandForSeq(sessionId: string, seq: number): CommandRow | null {
    const r = this.#get("SELECT * FROM commands WHERE session_id=? AND seq=?", sessionId, seq);
    return r ? rowCommand(r) : null;
  }
  /** Non-terminal commands in FIFO (position) order. */
  listPending(sessionId: string, states: readonly CommandState[] = NON_TERMINAL_STATES): CommandRow[] {
    return this.#all(`SELECT * FROM commands WHERE session_id=? AND state IN (${placeholders(states.length)}) ORDER BY position`, sessionId, ...states).map(rowCommand);
  }
  listCommands(sessionId: string): CommandRow[] {
    return this.#all("SELECT * FROM commands WHERE session_id=? ORDER BY position", sessionId).map(rowCommand);
  }

  /** Only a queued row is editable; the payload version bumps so an attempt
   *  made for the old text is recognizably stale. */
  editCommand(id: string, text: string): boolean {
    return this.tx(() => {
      const r = this.#run("UPDATE commands SET text=?, payload_version=payload_version+1, updated_at=? WHERE id=? AND state='queued'", text, this.#now(), id);
      return Number(r.changes) > 0;
    }, "edit");
  }

  /** Move a queued row to index `toIndex` among the session's queued rows
   *  (clamped); non-queued rows keep their place. */
  reorderCommand(id: string, toIndex: number): boolean {
    return this.tx(() => {
      const target = this.getCommand(id);
      if (!target || target.state !== "queued") return false;
      const queued = this.listPending(target.sessionId, ["queued"]);
      const from = queued.findIndex((q) => q.id === id);
      if (from < 0) return false;
      const [m] = queued.splice(from, 1);
      const to = Math.max(0, Math.min(queued.length, Math.floor(toIndex)));
      queued.splice(to, 0, m);
      // Rewrite the queued rows' positions over the SAME slot set they held,
      // so they still interleave correctly with non-queued rows.
      const slots = this.listPending(target.sessionId, ["queued"]).map((q) => q.position);
      const now = this.#now();
      queued.forEach((q, i) => { this.#run("UPDATE commands SET position=?, updated_at=? WHERE id=?", slots[i], now, q.id); });
      return true;
    }, "reorder");
  }

  /** Durable cancel request: a queued row is cancelled at once; a row in
   *  flight keeps its state and carries the flag (the next recordAttempt
   *  refuses it; the coordinator turns it into `cancelling` and counts its
   *  interrupt tries with noteCancelAttempt). Null = unknown or terminal. */
  requestCancel(id: string, reason = "cancelled"): CommandRow | null {
    return this.tx(() => {
      const row = this.getCommand(id);
      if (!row || isTerminalState(row.state)) return null;
      const now = this.#now();
      if (row.state === "queued") {
        this.#run("UPDATE commands SET state='cancelled', terminal_reason=?, cancel_requested_at=COALESCE(cancel_requested_at,?), active_op=NULL, updated_at=? WHERE id=?", reason, now, now, id);
        this.#run("UPDATE attempts SET state='superseded', settled_at=? WHERE command_id=? AND state IN ('submitting','accepted','unknown')", now, id);
      } else {
        this.#run("UPDATE commands SET cancel_requested_at=COALESCE(cancel_requested_at,?), updated_at=? WHERE id=?", now, now, id);
      }
      return this.getCommand(id);
    }, "cancel");
  }

  /** Compare-and-set state transition. A terminal `to` clears active_op and
   *  (unless `settleAttempts: false` — the runtime's echo for a delivery
   *  confirmed by another signal is still expected and must pair with the
   *  attempt) settles any attempt still awaiting evidence as superseded, or
   *  done when the command completed. False = precondition failed, nothing
   *  changed. `generation` / `expectedAttemptId` are further preconditions:
   *  the generation must be the session's current open one and the attempt
   *  must be the command's newest (a stale owner's transition is a no-op). */
  transition(id: string, from: readonly CommandState[], to: CommandState, patch: { activeOp?: string | null; terminalReason?: string; settleAttempts?: boolean; generation?: number; expectedAttemptId?: string } = {}): boolean {
    return this.tx(() => {
      const now = this.#now();
      if (patch.generation != null || patch.expectedAttemptId) {
        const cmd = this.getCommand(id);
        if (!cmd) return false;
        if (patch.generation != null && !this.#isCurrent(cmd.sessionId, patch.generation)) return false;
        if (patch.expectedAttemptId && this.latestAttempt(id)?.id !== patch.expectedAttemptId) return false;
      }
      const sets = ["state=?", "updated_at=?"];
      const params: Array<string | number | null> = [to, now];
      if (isTerminalState(to)) { sets.push("active_op=NULL"); sets.push("terminal_reason=?"); params.push(patch.terminalReason ?? null); }
      else if (patch.activeOp !== undefined) { sets.push("active_op=?"); params.push(patch.activeOp); }
      const r = this.#run(`UPDATE commands SET ${sets.join(",")} WHERE id=? AND state IN (${placeholders(from.length)})`, ...params, id, ...from);
      if (Number(r.changes) === 0) return false;
      if (isTerminalState(to) && patch.settleAttempts !== false) {
        this.#run("UPDATE attempts SET state=?, settled_at=? WHERE command_id=? AND state IN ('submitting','accepted','unknown')",
          to === "completed" ? "done" : "superseded", now, id);
      }
      return true;
    }, "transition");
  }

  // ── attempts ──
  /** One tx: command queued→submitting (CAS) + an attempts row. Refused for
   *  a stale generation (#481) and for a command whose cancel was requested —
   *  that row is cancelled instead of dispatched (#77/#35). */
  recordAttempt(commandId: string, generation: number, runtimeRef: string | null, op: string | null = null): AttemptRow {
    const pre = this.getCommand(commandId);
    if (pre && pre.cancelRequestedAt != null && !isTerminalState(pre.state)) {
      // A stale owner has no authority to terminalise the row either: the
      // fence comes FIRST (review 95c4781e — the cancel used to commit before
      // the generation was checked). Committed on its own so the refusal
      // below (a throw) does not roll it back.
      this.#fence(pre.sessionId, generation);
      this.transition(commandId, NON_TERMINAL_STATES, "cancelled", { terminalReason: "cancelled", generation });
      throw new StaleCommandError(commandId, "cancel requested — row cancelled, not dispatched");
    }
    return this.tx(() => {
      const cmd = this.getCommand(commandId);
      if (!cmd) throw new StaleCommandError(commandId, "no such command");
      this.#fence(cmd.sessionId, generation);
      const now = this.#now();
      if (cmd.state !== "queued") throw new StaleCommandError(commandId, `state is ${cmd.state}, not queued`);
      const n = (this.#get("SELECT COUNT(*) AS n FROM attempts WHERE command_id=?", commandId)?.n as number) + 1;
      const id = randomUUID();
      this.#run("INSERT INTO attempts(id,command_id,session_id,generation,attempt_no,payload_version,runtime_ref,state,submitted_at) VALUES(?,?,?,?,?,?,?,'submitting',?)",
        id, commandId, cmd.sessionId, generation, n, cmd.payloadVersion, runtimeRef, now);
      this.#run("UPDATE commands SET state='submitting', active_op=?, updated_at=? WHERE id=?", op, now, commandId);
      return this.getAttempt(id)!;
    }, "attempt");
  }

  /** The current-owner rule for a settlement naming attempt `a` (see the
   *  header): null when the caller owns the command's current execution,
   *  else why not. */
  #staleSettlement(a: AttemptRow, generation: number | undefined): StaleSettlement | null {
    const claimed = generation ?? a.generation;
    const cur = this.currentGeneration(a.sessionId);
    const latest = this.latestAttempt(a.commandId);
    const base = { claimedGeneration: claimed, claimIsCurrent: !!cur && cur.open && cur.generation === claimed, currentGeneration: cur?.generation ?? null, currentAttemptId: latest?.id ?? null };
    if (!cur || !cur.open || cur.generation !== claimed) return { reason: `generation ${claimed} is not current (${cur ? `${cur.generation}${cur.open ? "" : ", closed"}` : "none"})`, ...base };
    if (latest && latest.id !== a.id) return { reason: `attempt ${a.attemptNo} is not the command's current attempt (${latest.attemptNo})`, ...base };
    return null;
  }
  /** A settlement that failed the current-owner rule: recorded on its own
   *  attempt as an observation; the command and every other attempt are
   *  untouched. The attempt's own row takes the outcome only while it still
   *  awaits evidence AND the claim comes from someone entitled to speak
   *  about it — the current owner (reporting a late echo of an older
   *  attempt) or the attempt's own generation (its owner, late). A stale
   *  owner naming someone else's attempt leaves only the observation. */
  #recordStaleSettlement(a: AttemptRow, outcome: AttemptState, patch: { runtimeTurnId?: string; detail?: string }, why: StaleSettlement, via: string): void {
    const now = this.#now();
    this.#run("INSERT INTO observations(session_id,generation,attempt_id,kind,ref,payload,at) VALUES(?,?,?,?,?,?,?)",
      a.sessionId, a.generation, a.id, STALE_SETTLEMENT_KIND, outcome,
      JSON.stringify({ outcome, via, detail: patch.detail ?? null, runtimeTurnId: patch.runtimeTurnId ?? null, ...why }), now);
    const entitled = why.claimIsCurrent || why.claimedGeneration === a.generation;
    if (entitled && (AWAITING_ATTEMPT_STATES as readonly string[]).includes(a.state) && outcome !== "submitting") {
      this.#run("UPDATE attempts SET state=?, settled_at=?, runtime_turn_id=COALESCE(?,runtime_turn_id), detail=COALESCE(?,detail) WHERE id=?",
        outcome, now, patch.runtimeTurnId ?? null, patch.detail ?? null, a.id);
    }
  }

  /** Settle an attempt. The command follows unless `command` says otherwise:
   *  accepted→accepted, unknown→unknown, done→completed(delivered),
   *  rejected→failed, superseded→(no change). Fenced by the current-owner
   *  rule: `generation` is the caller's (a replacement reconciling its
   *  predecessor's attempt names its OWN generation); omitted, the attempt's
   *  generation is the claim. A stale settlement never changes the command
   *  (see #recordStaleSettlement). */
  settleAttempt(attemptId: string, outcome: AttemptState, patch: { runtimeTurnId?: string; detail?: string; command?: { to: CommandState; terminalReason?: string } | null; generation?: number } = {}): AttemptRow {
    return this.tx(() => {
      const a = this.getAttempt(attemptId);
      if (!a) throw new StaleCommandError(attemptId, "no such attempt");
      const stale = this.#staleSettlement(a, patch.generation);
      if (stale) { this.#recordStaleSettlement(a, outcome, patch, stale, "settleAttempt"); return this.getAttempt(attemptId)!; }
      const now = this.#now();
      const settled = outcome === "submitting" ? null : now;
      this.#run("UPDATE attempts SET state=?, settled_at=?, runtime_turn_id=COALESCE(?,runtime_turn_id), detail=COALESCE(?,detail) WHERE id=?",
        outcome, settled, patch.runtimeTurnId ?? null, patch.detail ?? null, attemptId);
      const follow = patch.command === null ? null : patch.command ?? (
        outcome === "accepted" ? { to: "accepted" as CommandState }
        : outcome === "unknown" ? { to: "unknown" as CommandState }
        : outcome === "done" ? { to: "completed" as CommandState, terminalReason: "delivered" }
        : outcome === "rejected" ? { to: "failed" as CommandState, terminalReason: patch.detail ?? "rejected" }
        : null);
      if (follow) {
        const cmd = this.getCommand(a.commandId);
        if (cmd && !isTerminalState(cmd.state)) this.transition(a.commandId, NON_TERMINAL_STATES, follow.to, { terminalReason: follow.terminalReason });
      }
      return this.getAttempt(attemptId)!;
    }, "settle");
  }

  /** Import only: an attempt row for a legacy in-flight submission, without
   *  the generation fence (no generation is open while the import runs). */
  importAttempt(commandId: string, runtimeRef: string | null, state: AttemptState, at: number): AttemptRow {
    return this.tx(() => {
      const cmd = this.getCommand(commandId);
      if (!cmd) throw new StaleCommandError(commandId, "no such command");
      const n = (this.#get("SELECT COUNT(*) AS n FROM attempts WHERE command_id=?", commandId)?.n as number) + 1;
      const id = randomUUID();
      this.#run("INSERT INTO attempts(id,command_id,session_id,generation,attempt_no,payload_version,runtime_ref,state,submitted_at,settled_at,detail) VALUES(?,?,?,0,?,?,?,?,?,?,'imported')",
        id, commandId, cmd.sessionId, n, cmd.payloadVersion, runtimeRef, state, at, state === "submitting" ? null : at);
      return this.getAttempt(id)!;
    }, "importAttempt");
  }

  getAttempt(id: string): AttemptRow | null {
    const r = this.#get("SELECT * FROM attempts WHERE id=?", id);
    return r ? rowAttempt(r) : null;
  }
  attemptsForCommand(commandId: string): AttemptRow[] {
    return this.#all("SELECT * FROM attempts WHERE command_id=? ORDER BY attempt_no", commandId).map(rowAttempt);
  }
  latestAttempt(commandId: string): AttemptRow | null {
    const r = this.#get("SELECT * FROM attempts WHERE command_id=? ORDER BY attempt_no DESC LIMIT 1", commandId);
    return r ? rowAttempt(r) : null;
  }
  attemptsAwaiting(sessionId: string, states: readonly AttemptState[] = AWAITING_ATTEMPT_STATES): AttemptRow[] {
    return this.#all(`SELECT * FROM attempts WHERE session_id=? AND state IN (${placeholders(states.length)}) ORDER BY submitted_at, attempt_no`, sessionId, ...states).map(rowAttempt);
  }
  /** Oldest attempt still awaiting evidence whose runtime ref matches (#437:
   *  identical texts pair in submission order). */
  matchAttemptByRef(sessionId: string, runtimeRef: string, states: readonly AttemptState[] = AWAITING_ATTEMPT_STATES): AttemptRow | null {
    const r = this.#get(`SELECT * FROM attempts WHERE session_id=? AND runtime_ref=? AND state IN (${placeholders(states.length)}) ORDER BY submitted_at, attempt_no LIMIT 1`, sessionId, runtimeRef, ...states);
    return r ? rowAttempt(r) : null;
  }
  /** The newest attempt of this session carrying `ref`, whatever its state
   *  (a late echo of a settled submission still pairs with it). */
  attemptByRef(sessionId: string, runtimeRef: string): AttemptRow | null {
    const r = this.#get("SELECT * FROM attempts WHERE session_id=? AND runtime_ref=? ORDER BY submitted_at DESC, attempt_no DESC LIMIT 1", sessionId, runtimeRef);
    return r ? rowAttempt(r) : null;
  }
  /** Every attempt of this session that rode the runtime's turn (a steered
   *  message joins the running turn; all of them end with it). */
  attemptsByRuntimeTurnId(sessionId: string, runtimeTurnId: string): AttemptRow[] {
    return this.#all("SELECT * FROM attempts WHERE session_id=? AND runtime_turn_id=? ORDER BY submitted_at, attempt_no", sessionId, runtimeTurnId).map(rowAttempt);
  }
  /** The attempt the runtime named by its turn id (a turn_ended correlates here). */
  attemptByRuntimeTurnId(sessionId: string, runtimeTurnId: string): AttemptRow | null {
    const r = this.#get("SELECT * FROM attempts WHERE session_id=? AND runtime_turn_id=? ORDER BY submitted_at DESC, attempt_no DESC LIMIT 1", sessionId, runtimeTurnId);
    return r ? rowAttempt(r) : null;
  }
  /** Bind the runtime's turn id to an attempt once it is known (an echo
   *  carrying the turn, a turn_started matched by ref). */
  setAttemptTurn(attemptId: string, runtimeTurnId: string): void {
    this.tx(() => { this.#run("UPDATE attempts SET runtime_turn_id=? WHERE id=?", runtimeTurnId, attemptId); }, "attempt");
  }
  /** One more interrupt try for a cancelling command; returns the count. */
  noteCancelAttempt(commandId: string): number {
    return this.tx(() => {
      this.#run("UPDATE commands SET cancel_attempts=cancel_attempts+1, updated_at=? WHERE id=?", this.#now(), commandId);
      return (this.#get("SELECT cancel_attempts AS n FROM commands WHERE id=?", commandId)?.n as number | undefined) ?? 0;
    }, "cancel");
  }
  /** Did this session ever submit `ref` (any attempt) or confirm it (a receipt of `kind`)? */
  ownsRuntimeRef(sessionId: string, ref: string, receiptKind: string): boolean {
    if (this.#get("SELECT 1 AS x FROM attempts WHERE session_id=? AND runtime_ref=? LIMIT 1", sessionId, ref)) return true;
    return !!this.#get("SELECT 1 AS x FROM receipts WHERE session_id=? AND kind=? AND ref=?", sessionId, receiptKind, ref);
  }

  // ── observations ──
  /** The observation, its receipts, its outbox rows, its command/attempt
   *  transitions and its local checkpoint commit TOGETHER; the remote ack
   *  stays separate (Astra §1). Fenced on the generation. */
  recordObservation(obs: NewObservation, effects: ObservationEffects = {}): { observationId: number; outboxSeqs: number[] } {
    return this.tx(() => {
      this.#fence(obs.sessionId, obs.generation);
      const now = obs.at ?? this.#now();
      const r = this.#run("INSERT INTO observations(session_id,generation,attempt_id,kind,ref,payload,at) VALUES(?,?,?,?,?,?,?)",
        obs.sessionId, obs.generation, obs.attemptId ?? null, obs.kind, obs.ref ?? null, obs.payload === undefined ? null : JSON.stringify(obs.payload), now);
      const observationId = Number((r as { lastInsertRowid?: number | bigint }).lastInsertRowid ?? 0);
      for (const rc of effects.receipts ?? []) this.#addReceiptInner(obs.sessionId, rc, now);
      if (effects.attempt) this.settleAttempt(effects.attempt.id, effects.attempt.outcome, { runtimeTurnId: effects.attempt.runtimeTurnId, detail: effects.attempt.detail, command: null, generation: obs.generation });
      if (effects.command) {
        const ok = this.transition(effects.command.id, effects.command.from ?? NON_TERMINAL_STATES, effects.command.to, { terminalReason: effects.command.terminalReason, generation: obs.generation });
        if (!ok) throw new StaleCommandError(effects.command.id, `not in ${(effects.command.from ?? NON_TERMINAL_STATES).join("|")}`);
      }
      const outboxSeqs = effects.outbox?.length ? this.enqueueOutbound(effects.outbox.map((o) => ({ generation: obs.generation, ...o }))) : [];
      if (effects.checkpoint) this.setCheckpoint(obs.sessionId, effects.checkpoint.kind, effects.checkpoint.ref, effects.checkpoint.offset, { throughSeq: "latest", generation: obs.generation });
      return { observationId, outboxSeqs };
    }, "observe");
  }
  listObservations(sessionId: string, kind?: string): ObservationRow[] {
    return (kind
      ? this.#all("SELECT * FROM observations WHERE session_id=? AND kind=? ORDER BY id", sessionId, kind)
      : this.#all("SELECT * FROM observations WHERE session_id=? ORDER BY id", sessionId)).map(rowObservation);
  }

  /** Sugar: delivery was proven — receipt(s) + attempt done + command terminal
   *  `completed(delivered)` in one commit. Idempotent: a second echo for the
   *  same command only adds the receipt. `settleAttempts: false` completes
   *  the command but leaves its attempt awaiting: the proof came from a
   *  signal other than the runtime's echo (a hook, a dialog) and the echo,
   *  when it arrives, must still pair with the attempt instead of being
   *  mirrored back as a new user message. Fenced by the current-owner rule
   *  when it names an attempt or a generation: the receipts are facts and
   *  always land, a stale confirmation settles only its own attempt. A call
   *  naming neither (a hook-proven delivery with no attempt) is a plain
   *  command transition. */
  confirmDelivery(commandId: string, receipts: NewReceipt | NewReceipt[], opts: { attemptId?: string | null; to?: CommandState; terminalReason?: string; settleAttempts?: boolean; generation?: number } = {}): CommandRow | null {
    return this.tx(() => {
      const cmd = this.getCommand(commandId);
      const now = this.#now();
      const list = Array.isArray(receipts) ? receipts : [receipts];
      for (const rc of list) this.#addReceiptInner(cmd?.sessionId ?? "", { commandId, attemptId: opts.attemptId ?? null, ...rc }, now);
      if (!cmd) return null;
      if (opts.attemptId) {
        const a = this.getAttempt(opts.attemptId);
        if (a) {
          const stale = this.#staleSettlement(a, opts.generation);
          if (stale) { this.#recordStaleSettlement(a, "done", {}, stale, "confirmDelivery"); return this.getCommand(commandId); }
          if ((AWAITING_ATTEMPT_STATES as readonly string[]).includes(a.state)) this.settleAttempt(opts.attemptId, "done", { command: null, generation: opts.generation });
        }
      } else if (opts.generation != null && !this.#isCurrent(cmd.sessionId, opts.generation)) {
        this.#run("INSERT INTO observations(session_id,generation,attempt_id,kind,ref,payload,at) VALUES(?,?,NULL,?,?,?,?)",
          cmd.sessionId, opts.generation, STALE_SETTLEMENT_KIND, "done", JSON.stringify({ outcome: "done", via: "confirmDelivery", commandId, claimedGeneration: opts.generation, currentGeneration: this.currentGeneration(cmd.sessionId)?.generation ?? null }), now);
        return cmd;
      } else if (opts.settleAttempts !== false) {
        this.#run("UPDATE attempts SET state='done', settled_at=? WHERE command_id=? AND state IN ('submitting','accepted','unknown')", now, commandId);
      }
      if (!isTerminalState(cmd.state)) this.transition(commandId, NON_TERMINAL_STATES, opts.to ?? "completed", { terminalReason: opts.terminalReason ?? "delivered", settleAttempts: opts.settleAttempts });
      return this.getCommand(commandId);
    }, "confirm");
  }

  // ── receipts ──
  #addReceiptInner(sessionId: string, rc: NewReceipt, now: number): void {
    this.#run("INSERT OR IGNORE INTO receipts(session_id,kind,ref,command_id,attempt_id,at) VALUES(?,?,?,?,?,?)",
      sessionId, rc.kind, rc.ref, rc.commandId ?? null, rc.attemptId ?? null, rc.at ?? now);
  }
  /** Retained proof of delivery (INSERT OR IGNORE — idempotent on the key). */
  addReceipt(sessionId: string, rc: NewReceipt): void {
    this.tx(() => { this.#addReceiptInner(sessionId, rc, this.#now()); }, "receipt");
  }
  addReceipts(sessionId: string, rcs: NewReceipt[]): void {
    if (!rcs.length) return;
    this.tx(() => { const now = this.#now(); for (const rc of rcs) this.#addReceiptInner(sessionId, rc, now); }, "receipt");
  }
  hasReceipt(sessionId: string, kind: string, ref: string): boolean {
    return !!this.#get("SELECT 1 AS x FROM receipts WHERE session_id=? AND kind=? AND ref=?", sessionId, kind, ref);
  }
  getReceipt(sessionId: string, kind: string, ref: string): ReceiptRow | null {
    const r = this.#get("SELECT * FROM receipts WHERE session_id=? AND kind=? AND ref=?", sessionId, kind, ref);
    return r ? rowReceipt(r) : null;
  }
  listReceipts(sessionId: string, kind?: string): ReceiptRow[] {
    return (kind
      ? this.#all("SELECT * FROM receipts WHERE session_id=? AND kind=? ORDER BY at, ref", sessionId, kind)
      : this.#all("SELECT * FROM receipts WHERE session_id=? ORDER BY at, kind, ref", sessionId)).map(rowReceipt);
  }
  deleteReceipt(sessionId: string, kind: string, ref: string): boolean {
    return this.tx(() => Number(this.#run("DELETE FROM receipts WHERE session_id=? AND kind=? AND ref=?", sessionId, kind, ref).changes) > 0, "receipt");
  }

  // ── outbox ──
  /** Persist outbound rows in order. Idempotent on runtime_event_id (a
   *  duplicate returns the existing seq). Usable alone or inside tx(). */
  enqueueOutbound(rows: NewOutbound[]): number[] {
    return this.tx(() => {
      const seqs: number[] = [];
      for (const o of rows) {
        const dup = this.#get("SELECT seq FROM outbox WHERE runtime_event_id=?", o.runtimeEventId);
        if (dup) { seqs.push(dup.seq as number); continue; }
        const body = JSON.stringify(o.body);
        const gen = o.generation ?? this.currentGeneration(o.sessionId)?.generation ?? 0;
        const r = this.#run(
          "INSERT INTO outbox(session_id,generation,kind,runtime_event_id,relay_turn_id,v2_session_id,sealed,key_b64,body,bytes,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
          o.sessionId, gen, o.kind, o.runtimeEventId, o.relayTurnId ?? null, o.v2SessionId ?? null, b(o.sealed), o.keyB64 ?? null, body, Buffer.byteLength(body), o.createdAt ?? this.#now(),
        );
        seqs.push(Number((r as { lastInsertRowid?: number | bigint }).lastInsertRowid ?? 0));
      }
      return seqs;
    }, "outbox");
  }
  /** Head of the session's line (lowest unacked seq), whatever its retry time. */
  nextOutbound(sessionId: string): OutboxRow | null {
    const r = this.#get("SELECT * FROM outbox WHERE session_id=? AND acked_at IS NULL ORDER BY seq LIMIT 1", sessionId);
    return r ? rowOutbox(r) : null;
  }
  getOutbound(seq: number): OutboxRow | null {
    const r = this.#get("SELECT * FROM outbox WHERE seq=?", seq);
    return r ? rowOutbox(r) : null;
  }
  pendingOutbound(sessionId: string): OutboxRow[] {
    return this.#all("SELECT * FROM outbox WHERE session_id=? AND acked_at IS NULL ORDER BY seq", sessionId).map(rowOutbox);
  }
  sessionsWithOutbound(): string[] {
    return this.#all("SELECT DISTINCT session_id FROM outbox WHERE acked_at IS NULL ORDER BY session_id").map((r) => r.session_id as string);
  }
  /** Was a row with this runtime event id ever committed (acked or not)? */
  hasOutboundEvent(runtimeEventId: string): boolean {
    return !!this.#get("SELECT 1 AS x FROM outbox WHERE runtime_event_id=?", runtimeEventId);
  }
  hasTerminalFor(relayTurnId: string): boolean {
    return !!this.#get("SELECT 1 AS x FROM outbox WHERE kind='terminal' AND relay_turn_id=? AND acked_at IS NULL", relayTurnId);
  }
  lastOutboundSeq(sessionId: string): number {
    return (this.#get("SELECT COALESCE(MAX(seq),0) AS s FROM outbox WHERE session_id=?", sessionId)?.s as number) ?? 0;
  }
  /** The relay acknowledged the row: mark it, then promote any pending
   *  checkpoint of that session that nothing older still covers. */
  ackOutbound(seq: number): void {
    this.tx(() => {
      const row = this.getOutbound(seq);
      if (!row || row.ackedAt != null) return;
      this.#run("UPDATE outbox SET acked_at=?, last_error=NULL WHERE seq=?", this.#now(), seq);
      this.#promoteCheckpoints(row.sessionId);
    }, "ack");
  }
  failOutbound(seq: number, error: string, retryAt: number): void {
    this.tx(() => { this.#run("UPDATE outbox SET attempts=attempts+1, last_error=?, next_retry_at=? WHERE seq=? AND acked_at IS NULL", error.slice(0, 500), retryAt, seq); }, "fail");
  }
  /** A permanent refusal (4xx, budget): the row will never be acked — settle
   *  it as dropped so the line moves on; a checkpoint waiting on it promotes. */
  dropOutbound(seq: number, reason: string): void {
    this.tx(() => {
      const row = this.getOutbound(seq);
      if (!row || row.ackedAt != null) return;
      this.#run("UPDATE outbox SET acked_at=?, last_error=? WHERE seq=?", this.#now(), `dropped: ${reason}`.slice(0, 500), seq);
      this.#promoteCheckpoints(row.sessionId);
    }, "drop");
  }
  /** Stamp the relay session id + sealing identity on rows produced before bind (#582). */
  bindOutbound(sessionId: string, v2SessionId: string, seal: { sealed: boolean; keyB64?: string | null }): number {
    return this.tx(() => Number(this.#run("UPDATE outbox SET v2_session_id=?, sealed=?, key_b64=? WHERE session_id=? AND v2_session_id IS NULL AND acked_at IS NULL",
      v2SessionId, b(seal.sealed), seal.keyB64 ?? null, sessionId).changes), "bind");
  }
  outboundPressure(sessionId: string): { rows: number; bytes: number; over: boolean } {
    const r = this.#get("SELECT COUNT(*) AS n, COALESCE(SUM(bytes),0) AS b FROM outbox WHERE session_id=? AND kind='output' AND acked_at IS NULL", sessionId);
    const rows = Number(r?.n ?? 0), bytes = Number(r?.b ?? 0);
    return { rows, bytes, over: rows > OUTBOX_MAX_ROWS || bytes > OUTBOX_MAX_BYTES };
  }
  /** Sessions whose backlog is over the cap. */
  sessionsOverPressure(): string[] {
    return this.#all("SELECT session_id, COUNT(*) AS n, COALESCE(SUM(bytes),0) AS b FROM outbox WHERE kind='output' AND acked_at IS NULL GROUP BY session_id HAVING n>? OR b>?", OUTBOX_MAX_ROWS, OUTBOX_MAX_BYTES)
      .map((r) => r.session_id as string);
  }

  // ── checkpoints ──
  getCheckpoint(sessionId: string, kind: string): CheckpointRow | null {
    const r = this.#get("SELECT * FROM checkpoints WHERE session_id=? AND kind=?", sessionId, kind);
    return r ? rowCheckpoint(r) : null;
  }
  /** Record a local replay cursor. With `throughSeq` (or "latest" = the
   *  session's newest outbox row) the checkpoint is committed only once every
   *  outbox row up to that seq is acked or dropped; until then it is held as
   *  pending and a restart replays from the previous committed cursor — or
   *  from nothing (`ref` is "" while no cursor has ever been committed). */
  setCheckpoint(sessionId: string, kind: string, ref: string, offset: number, opts: { throughSeq?: number | "latest"; generation?: number } = {}): { committed: boolean } {
    return this.tx(() => {
      if (opts.generation != null) this.#fence(sessionId, opts.generation);
      const now = this.#now();
      const through = opts.throughSeq === "latest" ? this.lastOutboundSeq(sessionId) : opts.throughSeq;
      const blocked = through != null && through > 0
        && !!this.#get("SELECT 1 AS x FROM outbox WHERE session_id=? AND acked_at IS NULL AND seq<=? LIMIT 1", sessionId, through);
      const cur = this.getCheckpoint(sessionId, kind);
      if (blocked) {
        if (cur) this.#run("UPDATE checkpoints SET pending_ref=?, pending_offset=?, pending_through_seq=?, updated_at=? WHERE session_id=? AND kind=?", ref, offset, through, now, sessionId, kind);
        else this.#run("INSERT INTO checkpoints(session_id,kind,ref,offset,updated_at,pending_ref,pending_offset,pending_through_seq) VALUES(?,?,'',0,?,?,?,?)", sessionId, kind, now, ref, offset, through);
        return { committed: false };
      }
      this.#run("INSERT OR REPLACE INTO checkpoints(session_id,kind,ref,offset,updated_at,pending_ref,pending_offset,pending_through_seq) VALUES(?,?,?,?,?,NULL,NULL,NULL)", sessionId, kind, ref, offset, now);
      return { committed: true };
    }, "checkpoint");
  }
  clearCheckpoint(sessionId: string, kind: string): void {
    this.tx(() => { this.#run("DELETE FROM checkpoints WHERE session_id=? AND kind=?", sessionId, kind); }, "checkpoint");
  }
  #promoteCheckpoints(sessionId: string): void {
    const rows = this.#all("SELECT * FROM checkpoints WHERE session_id=? AND pending_through_seq IS NOT NULL", sessionId).map(rowCheckpoint);
    for (const cp of rows) {
      const stillUnacked = this.#get("SELECT 1 AS x FROM outbox WHERE session_id=? AND acked_at IS NULL AND seq<=? LIMIT 1", sessionId, cp.pendingThroughSeq!);
      if (stillUnacked) continue;
      this.#run("UPDATE checkpoints SET ref=?, offset=?, updated_at=?, pending_ref=NULL, pending_offset=NULL, pending_through_seq=NULL WHERE session_id=? AND kind=?",
        cp.pendingRef, cp.pendingOffset ?? 0, this.#now(), sessionId, cp.kind);
    }
  }

  // ── spawn intents ──
  spawnIntent(relayCommandId: string, localSessionId: string): void {
    this.tx(() => {
      this.#run("INSERT INTO spawn_intents(relay_command_id,local_session_id,created_at) VALUES(?,?,?) ON CONFLICT(relay_command_id) DO UPDATE SET local_session_id=excluded.local_session_id",
        relayCommandId, localSessionId, this.#now());
    }, "spawnIntent");
  }
  lookupSpawnIntent(relayCommandId: string): string | null {
    return (this.#get("SELECT local_session_id FROM spawn_intents WHERE relay_command_id=?", relayCommandId)?.local_session_id as string | undefined) ?? null;
  }
  bindSpawnIntent(relayCommandId: string): void {
    this.tx(() => { this.#run("UPDATE spawn_intents SET bound_at=? WHERE relay_command_id=?", this.#now(), relayCommandId); }, "spawnIntent");
  }
  listSpawnIntents(): SpawnIntentRow[] {
    return this.#all("SELECT * FROM spawn_intents ORDER BY created_at").map((r) => ({
      relayCommandId: r.relay_command_id as string, localSessionId: r.local_session_id as string, createdAt: r.created_at as number, boundAt: r.bound_at as number | null,
    }));
  }

  // ── jobs ──
  putJob(job: { id: string; sessionId: string; kind: string; payload: unknown }): void {
    this.tx(() => {
      this.#run("INSERT OR REPLACE INTO jobs(id,session_id,kind,payload,updated_at) VALUES(?,?,?,?,?)", job.id, job.sessionId, job.kind, JSON.stringify(job.payload), this.#now());
    }, "job");
  }
  getJob(id: string): JobRow | null {
    const r = this.#get("SELECT * FROM jobs WHERE id=?", id);
    return r ? { id: r.id as string, sessionId: r.session_id as string, kind: r.kind as string, payload: parseJson(r.payload), updatedAt: r.updated_at as number } : null;
  }
  listJobs(kind: string): JobRow[] {
    return this.#all("SELECT * FROM jobs WHERE kind=? ORDER BY updated_at", kind)
      .map((r) => ({ id: r.id as string, sessionId: r.session_id as string, kind: r.kind as string, payload: parseJson(r.payload), updatedAt: r.updated_at as number }));
  }
  deleteJob(id: string): boolean {
    return this.tx(() => Number(this.#run("DELETE FROM jobs WHERE id=?", id).changes) > 0, "job");
  }

  // ── retention ──
  /** Retention by durable acknowledgement, never by evicting live work:
   *  only terminal commands (+ their attempts, cascaded), acked/dropped
   *  outbox rows, old observations and old receipts go. */
  prune(policy: PrunePolicy = DEFAULT_PRUNE_POLICY): { commands: number; outbox: number; observations: number; receipts: number } {
    return this.tx(() => {
      const now = this.#now();
      const cut = now - policy.terminalOlderThanMs;
      const commands = Number(this.#run(`DELETE FROM commands WHERE state IN (${placeholders(TERMINAL_STATES.length)}) AND updated_at<?`, ...TERMINAL_STATES, cut).changes);
      const outbox = Number(this.#run("DELETE FROM outbox WHERE acked_at IS NOT NULL AND acked_at<?", cut).changes);
      const observations = Number(this.#run("DELETE FROM observations WHERE at<?", now - policy.observationsOlderThanMs).changes);
      const receipts = Number(this.#run("DELETE FROM receipts WHERE at<?", cut).changes);
      this.#run("DELETE FROM session_generations WHERE ended_at IS NOT NULL AND ended_at<? AND session_id NOT IN (SELECT DISTINCT session_id FROM commands)", cut);
      return { commands, outbox, observations, receipts };
    }, "prune");
  }
  /** Drop everything a session left (its record is being deleted for good). */
  forgetSession(sessionId: string): void {
    this.tx(() => {
      this.#run("DELETE FROM commands WHERE session_id=?", sessionId);
      this.#run("DELETE FROM outbox WHERE session_id=? AND acked_at IS NOT NULL", sessionId);
      this.#run("DELETE FROM observations WHERE session_id=?", sessionId);
      this.#run("DELETE FROM checkpoints WHERE session_id=?", sessionId);
      this.#run("DELETE FROM jobs WHERE session_id=?", sessionId);
    }, "forget");
  }
}

// ── process-wide handles ─────────────────────────────────────────────────────

const open = new Map<string, Ledger>();
/** The ledger for a state dir — opened once per process per dir (the daemon
 *  serves one relay; tests point JOY_HOME_DIR at throwaway dirs). */
export function ledgerFor(stateDir: string = joyStateDir()): Ledger {
  let l = open.get(stateDir);
  if (!l || l.closed) { l = Ledger.open(stateDir); open.set(stateDir, l); }
  return l;
}
/** Tests: close every cached handle (a reopen sees the on-disk state). */
export function closeAllLedgers(): void {
  for (const l of open.values()) l.close();
  open.clear();
}
