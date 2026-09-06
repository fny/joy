// One-time, versioned import of the legacy per-file stores into the ledger
// (design §1.4). Runs at daemon boot, before any session is recovered, and
// only until every legacy file is gone (`schema_meta.import_v1 = done`).
//
// Contract (review 95c4781e, wave C1):
//   - Each source file is imported in ONE transaction that also commits a
//     per-source marker (`import_sources`: state-dir-relative name + content
//     hash). "This file is done" is that ledger fact, never an inference
//     from the file having moved: a repeat import of a file the marker
//     already covers is a no-op even when the file could not be moved
//     aside. Synthetic rows (the received-text echo backstop) take ids
//     derived from the source hash and the record's index, so they cannot
//     multiply either. The natural keys (command id, receipt primary key,
//     runtime_event_id, spawn intent id) stay insert-or-ignore on top.
//   - An unreadable or malformed source is a FAILED import: nothing is
//     written, the file stays where it is, the failure is reported with the
//     session it belongs to (server.ts quarantines that session) and the
//     import is NOT marked done — it is retried next boot. "Malformed"
//     covers the rows, not only the envelope (review 7652e686): a queue or
//     codex-inbound array with one entry missing its id / text, or a window
//     record whose execution field has the wrong shape (a string offset),
//     fails the whole file — nothing of it is committed, nothing stripped,
//     the session waits for a repair. A command id another session already
//     owns fails it the same way (CommandIdConflictError). A window record
//     that cannot be read or parsed is a failed import of THAT record too
//     (review a7edccec): its execution fields cannot be known to be absent,
//     so its session is quarantined until the record is repaired. Byte
//     offsets and sequence numbers must be non-negative safe integers; a
//     handoff job must be one `domain/handoff.ts` can resume (a known
//     role, and the target / peer that role needs) — accepted execution
//     state is never imported in a shape that resume would clear. Receipt
//     rows are held to the same rule (review d5f35f45): a receipts-file or
//     codex-checkpoint row whose seq is not a safe integer, whose uuid /
//     clientId is not a non-empty string, or that is not an object fails
//     its file — a receipt is ownership and dedupe evidence, and dropping
//     one row silently while importing the rest loses exactly that.
//   - Window records import FIRST, and a source that depends on a record
//     which failed is DEFERRED (review d5f35f45): not imported, no marker,
//     not moved, reported in `failed` and retried next boot, so a repaired
//     record's next import still finds it. The dependents of a record are
//     the per-session files of its session and every v2-outbound entry it
//     owns — including one without a localId whose v2SessionId no readable
//     record maps while some record could not be read at all (it may be
//     the owner). Only sources whose owner record imported are consumed.
//   - A failed file changes nothing, the report's counters included: they
//     are restored with the rows when its transaction rolls back.
//   - A legacy checkpoint never moves the ledger's cursor backwards: it is
//     installed only while the ledger has none of that kind.
//   - Window records keep their identity fields; the execution fields are
//     stripped through the atomic-write primitive, so a rewrite that fails
//     leaves the record complete (a truncating write left `{"launch`).
// Only after COMMIT is a file moved to `<stateDir>/imported-v1/`; the
// originals are preserved for inspection, never deleted.
//
// The legacy parsers live here now (they used to be the stores' loaders);
// nothing else in the daemon reads these files any more.
import fs from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { Ledger, LedgerWriteError, type CommandState, type NewOutbound } from "./ledger";
import { writeFileAtomic } from "./atomicWrite";
import type { HandoffJob } from "./handoff";

export interface ImportFailure { file: string; error: string; sessionId?: string }
export interface ImportReport {
  skipped: boolean;
  files: string[];
  /** Files whose marker already covered their contents: nothing re-applied. */
  repeated: string[];
  commands: number;
  attempts: number;
  receipts: number;
  outbox: number;
  checkpoints: number;
  spawnIntents: number;
  jobs: number;
  /** Files that could not be moved after their import committed (retried next boot — a no-op). */
  unmoved: string[];
  /** Files whose import failed (left in place, nothing written, retried next boot). */
  failed: ImportFailure[];
  /** Sessions a failed per-session source belongs to: they must not accept
   *  or recover work until their import completes. */
  quarantine: string[];
}

export interface ImportOptions {
  /** Does this daemon seal content (an account content key is paired)? A
   *  legacy outbound entry without the sealing flag is then treated as
   *  sealed — never sent in plaintext (#582). */
  sealsContent: boolean;
  log?: (line: string) => void;
  now?: () => number;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
/** A non-negative safe integer (a byte offset, a sequence number) — a
 *  finite float or a value past 2^53 is not one. */
const index = (v: unknown): number | undefined => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : undefined);
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
/** The old `received[]` echo backstop only ever mattered inside this window. */
const RECEIVED_WINDOW_MS = 15 * 60 * 1000;

/** The source parsed, but is not the shape its file class promises. */
class MalformedSource extends Error {
  constructor(what: string) { super(`malformed: ${what}`); this.name = "MalformedSource"; }
}
/** The source is fine, but a window record it depends on failed to import:
 *  it waits, unconsumed, for that record's repair. */
class DeferredSource extends Error {
  constructor(what: string) { super(`deferred: ${what}`); this.name = "DeferredSource"; }
}

/** Read + parse a source, hashing the bytes actually read. Throws: an
 *  unreadable file (EIO, EACCES, a vanished file) or one that is not JSON. */
function readSource(path: string): { doc: unknown; hash: string } {
  const raw = fs.readFileSync(path);
  let doc: unknown;
  try { doc = JSON.parse(raw.toString("utf8")); }
  catch (e) { throw new MalformedSource(`not JSON (${errMsg(e)})`); }
  return { doc, hash: createHash("sha256").update(raw).digest("hex") };
}

/** Read + parse a window record. Throws like readSource: an unreadable file
 *  or one that is not JSON (MalformedSource) — the caller fails the record.
 *  A record that is not an object is malformed too. */
function readRecord(path: string): Record<string, unknown> {
  const doc = readSource(path).doc;
  if (!isRecord(doc)) throw new MalformedSource("a window record is an object");
  return doc;
}

/** Legacy file classes, matched against a state-dir entry name. */
const LEGACY = {
  queue: /^queue-([0-9a-f]{8})\.json$/,
  receipts: /^([0-9a-f]{8})\.receipts\.json$/,
  outbound: /^v2-outbound\.json$/,
  codexInbound: /^codex-inbound-([0-9a-f]{8})\.json$/,
  codexCheckpoint: /^codex-checkpoint-([0-9a-f]{8})\.json$/,
  spawns: /^v2-spawns\.json$/,
} as const;
const EXEC_FIELDS = ["transcriptCheckpoint", "opencodeDeliveredThrough", "handoffJob"] as const;

/** The session a per-session legacy file belongs to (none for the global ones). */
function sessionOf(name: string): string | undefined {
  for (const re of [LEGACY.queue, LEGACY.receipts, LEGACY.codexInbound, LEGACY.codexCheckpoint]) {
    const m = re.exec(name);
    if (m) return m[1];
  }
  return undefined;
}

/** Every legacy store file present in the state dir (window records are
 *  handled separately: they stay, only their execution fields move). */
export function listLegacyFiles(stateDir: string): string[] {
  let names: string[] = [];
  try { names = fs.readdirSync(stateDir); } catch { return []; }
  return names.filter((n) => Object.values(LEGACY).some((re) => re.test(n))).sort();
}

export function importLegacyState(ledger: Ledger, stateDir: string, opts: ImportOptions): ImportReport {
  const log = opts.log ?? (() => {});
  const now = opts.now ?? Date.now;
  const report: ImportReport = { skipped: false, files: [], repeated: [], commands: 0, attempts: 0, receipts: 0, outbox: 0, checkpoints: 0, spawnIntents: 0, jobs: 0, unmoved: [], failed: [], quarantine: [] };
  if (ledger.getMeta("import_v1") === "done") { report.skipped = true; return report; }
  const files = listLegacyFiles(stateDir);
  const records = listRecordFiles(stateDir);
  // localId ← v2SessionId, from the window records, for outbound entries
  // that predate the localId field.
  const localByV2 = new Map<string, string>();
  for (const r of records) if (r.raw && r.v2SessionId) localByV2.set(r.v2SessionId, r.id);
  // The counters describe what COMMITTED: a file whose transaction rolls
  // back leaves them exactly as they were.
  const COUNTERS = ["commands", "attempts", "receipts", "outbox", "checkpoints", "spawnIntents", "jobs"] as const;
  const counters = (): Record<(typeof COUNTERS)[number], number> => Object.fromEntries(COUNTERS.map((k) => [k, report[k]])) as Record<(typeof COUNTERS)[number], number>;
  const restore = (snap: ReturnType<typeof counters>): void => { for (const k of COUNTERS) report[k] = snap[k]; };

  const movedDir = join(stateDir, "imported-v1");
  const move = (name: string): void => {
    try {
      fs.mkdirSync(movedDir, { recursive: true });
      fs.renameSync(join(stateDir, name), join(movedDir, name));
    } catch (e) {
      report.unmoved.push(name);
      log(`[ledger-import] ${name}: imported but could not be moved aside (${errMsg(e)}) — re-imported (no-op) next boot`);
    }
  };
  const fail = (file: string, sessionId: string | undefined, what: string, error: string): void => {
    report.failed.push({ file, error, ...(sessionId ? { sessionId } : {}) });
    if (sessionId && !report.quarantine.includes(sessionId)) report.quarantine.push(sessionId);
    log(`[ledger-import] ${file}: ${what} (${error}) — left in place, nothing imported, retried next boot${sessionId ? `; session ${sessionId} accepts no work until then` : ""}`);
  };

  // Window records FIRST: the three execution fields move; the record stays.
  // The per-session files and the outbound entries a record owns depend on
  // it importing — a record that fails holds them back (review d5f35f45).
  const owners: RecordOwners = { failed: new Map(), unreadable: [], localByV2 };
  for (const rec of records) {
    const file = `window-${rec.id}.json`;
    // A record that could not be read or parsed may hold execution fields
    // nobody can see: a failed import of this record, its session
    // quarantined, retried once the record is repaired (review a7edccec).
    const raw = rec.raw;
    if (!raw) {
      const what = rec.error instanceof MalformedSource ? "malformed" : "unreadable";
      fail(file, rec.id, what, errMsg(rec.error));
      owners.failed.set(rec.id, `${what}: ${errMsg(rec.error)}`);
      owners.unreadable.push(file);
      continue;
    }
    if (!EXEC_FIELDS.some((f) => raw[f] != null)) continue;
    // Every field is validated BEFORE anything is written or stripped: a
    // malformed one (a string offset) is a failed import of this record —
    // it keeps its fields and its session is quarantined until repaired.
    let fields: RecordFields;
    try { fields = parseRecordFields(raw); }
    catch (e) { fail(file, rec.id, "malformed", errMsg(e)); owners.failed.set(rec.id, errMsg(e)); continue; }
    const before = counters();
    try { ledger.tx(() => importRecordFields(ledger, rec.id, fields, report), `import ${file}`); }
    catch (e) { restore(before); fail(file, rec.id, "import failed", errMsg(e)); owners.failed.set(rec.id, errMsg(e)); continue; }
    const stripped: Record<string, unknown> = { ...raw };
    for (const f of EXEC_FIELDS) delete stripped[f];
    // The record is the session's identity (launch cwd, conversation id): it
    // is replaced atomically or not at all. A failed rewrite leaves the old
    // fields in place; importRecordFields ignores them once the ledger has
    // its checkpoint, and the strip is retried next boot.
    try { writeFileAtomic(rec.path, JSON.stringify(stripped)); }
    catch (e) { report.unmoved.push(file); log(`[ledger-import] ${file}: fields imported but the record could not be rewritten (${errMsg(e)}) — record left complete, stripped next boot`); }
    report.files.push(file);
  }

  for (const name of files) {
    const path = join(stateDir, name);
    const sessionId = sessionOf(name);
    let src: { doc: unknown; hash: string };
    try { src = readSource(path); }
    catch (e) { fail(name, sessionId, e instanceof MalformedSource ? "malformed" : "unreadable", errMsg(e)); continue; }
    const marker = ledger.getImportSource(name);
    if (marker && marker.contentHash === src.hash) {
      // Already committed (the move failed, or the daemon died between the
      // commit and the move): nothing to apply, only the move to retry.
      report.repeated.push(name);
      move(name);
      continue;
    }
    // A per-session file whose owner record failed waits for the repair:
    // nothing of it is consumed until its session can be recovered.
    const owner = sessionId ? owners.failed.get(sessionId) : undefined;
    if (owner !== undefined) { fail(name, sessionId, "deferred", new DeferredSource(`window-${sessionId}.json failed to import (${owner}) — this file waits for its repair`).message); continue; }
    const before = counters();
    try {
      ledger.tx(() => {
        let m: RegExpExecArray | null;
        if ((m = LEGACY.queue.exec(name))) importQueue(ledger, m[1], src.doc, report);
        else if ((m = LEGACY.receipts.exec(name))) importReceipts(ledger, m[1], src.doc, src.hash, report, now());
        else if (LEGACY.outbound.test(name)) importOutbound(ledger, src.doc, report, opts.sealsContent, owners, log);
        else if ((m = LEGACY.codexInbound.exec(name))) importCodexInbound(ledger, m[1], src.doc, report);
        else if ((m = LEGACY.codexCheckpoint.exec(name))) importCodexCheckpoint(ledger, m[1], src.doc, report);
        else if (LEGACY.spawns.test(name)) importSpawns(ledger, src.doc, report);
        ledger.recordImportSource(name, src.hash);
      }, `import ${name}`);
      report.files.push(name);
      move(name);
    } catch (e) {
      restore(before);
      // A wrong-shape source throws MalformedSource inside the transaction;
      // tx() wraps it — report the shape complaint, not the wrapper.
      const cause = e instanceof LedgerWriteError ? e.cause : e;
      if (cause instanceof MalformedSource) fail(name, sessionId, "malformed", cause.message);
      else if (cause instanceof DeferredSource) fail(name, sessionId, "deferred", cause.message);
      else fail(name, sessionId, "import failed", errMsg(e));
    }
  }

  if (report.failed.length === 0 && report.unmoved.length === 0 && listLegacyFiles(stateDir).length === 0) {
    try { ledger.setMeta("import_v1", "done"); } catch (e) { log(`[ledger-import] could not mark the import done: ${errMsg(e)}`); }
  }
  if (report.files.length) {
    log(`[ledger-import] imported ${report.files.length} legacy file(s): ${report.commands} commands, ${report.attempts} attempts, ${report.receipts} receipts, ${report.outbox} outbox rows, ${report.checkpoints} checkpoints, ${report.spawnIntents} spawn intents, ${report.jobs} jobs${report.repeated.length ? ` (${report.repeated.length} already imported, skipped)` : ""}`);
  }
  return report;
}

/** A window record: parsed (`raw`), or the read/parse failure it hit. */
interface RecordFile { id: string; path: string; raw: Record<string, unknown> | null; error?: unknown; v2SessionId?: string }
/** What the window-record pass learned about the sources' owners: the
 *  records that failed (id → why), the ones nobody could read (their
 *  v2SessionId is unknown, so they may own any unmapped outbound entry),
 *  and the v2 → local mapping the readable ones supplied. */
interface RecordOwners { failed: Map<string, string>; unreadable: string[]; localByV2: Map<string, string> }
function listRecordFiles(stateDir: string): RecordFile[] {
  let names: string[] = [];
  try { names = fs.readdirSync(stateDir); } catch { return []; }
  const out: RecordFile[] = [];
  for (const n of names.sort()) {
    const m = /^window-([0-9a-f]{8})\.json$/.exec(n);
    if (!m) continue;
    const path = join(stateDir, n);
    try {
      const raw = readRecord(path);
      out.push({ id: m[1], path, raw, v2SessionId: str(raw.v2SessionId) });
    } catch (e) {
      out.push({ id: m[1], path, raw: null, error: e });
    }
  }
  return out;
}

/** A non-empty string field, or a MalformedSource naming the row and field. */
function requireText(row: Record<string, unknown>, field: string, where: string): string {
  const v = row[field];
  if (typeof v !== "string" || !v) throw new MalformedSource(`${where}: ${field} must be a non-empty string`);
  return v;
}
/** An optional finite-number field (absent / null = undefined), or a MalformedSource. */
function optionalNum(row: Record<string, unknown>, field: string, where: string): number | undefined {
  const v = row[field];
  if (v == null) return undefined;
  const n = num(v);
  if (n === undefined) throw new MalformedSource(`${where}: ${field} must be a number`);
  return n;
}
/** An optional non-negative safe-integer field (a seq, an offset), or a MalformedSource. */
function optionalIndex(row: Record<string, unknown>, field: string, where: string): number | undefined {
  const v = row[field];
  if (v == null) return undefined;
  const n = index(v);
  if (n === undefined) throw new MalformedSource(`${where}: ${field} must be a non-negative integer`);
  return n;
}

function importQueue(ledger: Ledger, sessionId: string, doc: unknown, report: ImportReport): void {
  if (!Array.isArray(doc)) throw new MalformedSource("a queue file is an array of items");
  // Every entry is a command the app accepted: one that cannot be imported
  // fails the file (nothing committed) rather than vanishing.
  doc.forEach((it, i) => {
    const where = `queue item ${i}`;
    if (!isRecord(it)) throw new MalformedSource(`${where}: not an object`);
    const id = requireText(it, "id", where);
    const text = requireText(it, "text", where);
    const seq = optionalIndex(it, "seq", where);
    const createdAt = optionalNum(it, "createdAt", where);
    const r = ledger.acceptCommand({
      sessionId, id, text, origin: seq != null ? "relay" : "local",
      source: str(it.source) ?? "rpc", seq: seq ?? null, visible: it.visible !== false, mirrorToRelay: it.mirrorToRelay !== false,
      createdAt,
    });
    if (r.deduped === "none") report.commands++;
  });
}

/** An optional array field (absent / null = empty), or a MalformedSource. */
function optionalList(doc: Record<string, unknown>, field: string, where: string): unknown[] {
  const v = doc[field];
  if (v == null) return [];
  if (!Array.isArray(v)) throw new MalformedSource(`${where}: ${field} must be an array`);
  return v;
}

function importReceipts(ledger: Ledger, sessionId: string, doc: unknown, sourceHash: string, report: ImportReport, now: number): void {
  if (!isRecord(doc)) throw new MalformedSource("a receipts file is an object");
  const where = "receipts file";
  const inbound = optionalList(doc, "inbound", where);
  const outbound = optionalList(doc, "outbound", where);
  const received = optionalList(doc, "received", where);
  // Every row is evidence the daemon recorded (an echo it matched, a seq it
  // owns): one that cannot be imported fails the file — dropping it while
  // importing the rest would silently lose that ownership (review d5f35f45).
  inbound.forEach((r, i) => {
    const where = `inbound receipt ${i}`;
    if (!isRecord(r)) throw new MalformedSource(`${where}: not an object`);
    const uuid = requireText(r, "uuid", where);
    const seq = optionalIndex(r, "seq", where);
    const at = optionalNum(r, "at", where);
    ledger.addReceipt(sessionId, { kind: "transcript_uuid", ref: uuid, at }); report.receipts++;
    if (seq != null) { ledger.addReceipt(sessionId, { kind: "seq", ref: String(seq), at }); report.receipts++; }
  });
  outbound.forEach((r, i) => {
    const where = `outbound receipt ${i}`;
    if (!isRecord(r)) throw new MalformedSource(`${where}: not an object`);
    const uuid = requireText(r, "uuid", where);
    const at = optionalNum(r, "at", where);
    ledger.addReceipt(sessionId, { kind: "transcript_uuid", ref: uuid, at }); report.receipts++;
  });
  // The echo backstop: a text the app sent in the last 15 minutes whose
  // transcript echo has not been matched yet. It becomes a synthetic
  // delivered command with an attempt awaiting that echo (runtime_ref = the
  // flattened text), exactly what the live path now records — so the echo
  // pairs with it and is not mirrored back as a duplicate bubble. Its id is
  // a function of the source (hash) and the entry's index: a re-import of
  // the same file finds the same row and adds nothing.
  received.forEach((r, i) => {
    const where = `received entry ${i}`;
    if (!isRecord(r)) throw new MalformedSource(`${where}: not an object`);
    const text = requireText(r, "text", where);
    const at = optionalNum(r, "at", where) ?? 0;
    if (at < now - RECEIVED_WINDOW_MS) return;
    const id = `import:${sessionId}:received:${sourceHash.slice(0, 12)}:${i}`;
    const c = ledger.acceptCommand({ sessionId, id, text, origin: "import", source: "relay", visible: false, mirrorToRelay: false, createdAt: at, state: "completed" });
    if (c.deduped !== "none") return;
    ledger.importAttempt(c.id, text, "unknown", at); report.commands++; report.attempts++;
  });
}

function importOutbound(ledger: Ledger, doc: unknown, report: ImportReport, sealsContent: boolean, owners: RecordOwners, log: (l: string) => void): void {
  if (!Array.isArray(doc)) throw new MalformedSource("v2-outbound.json is an array of entries");
  const rows: NewOutbound[] = [];
  for (const e of doc) {
    if (!isRecord(e) || typeof e.id !== "string") continue;
    const v2 = str(e.v2SessionId) || null;
    const localId = str(e.localId) ?? (v2 ? owners.localByV2.get(v2) : undefined);
    // An entry only its window record can attribute (no localId) is not
    // orphaned while a record nobody could read may be that owner: the file
    // waits for the repair instead of dropping the entry (review d5f35f45).
    if (!localId && owners.unreadable.length) throw new DeferredSource(`v2-outbound entry ${e.id} has no local session (v2 ${v2 ?? "none"}) and ${owners.unreadable.join(", ")} could not be read — it may own the entry; waits for the repair`);
    if (!localId) { log(`[ledger-import] v2-outbound entry ${e.id} has no local session (v2 ${v2 ?? "none"}) — dropped`); continue; }
    // An entry whose owner record failed is imported only once that record is.
    const owner = owners.failed.get(localId);
    if (owner !== undefined) throw new DeferredSource(`v2-outbound entry ${e.id} belongs to session ${localId}, whose window-${localId}.json failed to import (${owner}) — waits for its repair`);
    if (e.kind === "terminal") {
      const turnId = str(e.turnId);
      if (!turnId || !isRecord(e.body)) continue;
      rows.push({ sessionId: localId, kind: "terminal", runtimeEventId: `term:${turnId}`, relayTurnId: turnId, v2SessionId: v2, sealed: false, body: e.body, createdAt: num(e.at) });
    } else if (e.kind === "output") {
      const runtimeEventId = str(e.runtimeEventId);
      if (!runtimeEventId || !isRecord(e.wire)) continue;
      // An entry from before the sealing flag existed cannot say: on a daemon
      // that seals, it is treated as sealed (dropped at send without a key)
      // rather than leaked in plaintext (#582).
      const sealed = typeof e.sealed === "boolean" ? e.sealed : sealsContent;
      rows.push({ sessionId: localId, kind: "output", runtimeEventId, relayTurnId: str(e.turnId) ?? null, v2SessionId: v2, sealed, keyB64: str(e.key) ?? null, body: e.wire, createdAt: num(e.at) });
    }
  }
  const seqs = ledger.enqueueOutbound(rows);
  report.outbox += seqs.length;
}

function importCodexInbound(ledger: Ledger, sessionId: string, doc: unknown, report: ImportReport): void {
  if (!Array.isArray(doc)) throw new MalformedSource("a codex inbound file is an array of items");
  // Same rule as the queue file: every entry is a prompt the app handed
  // over; a malformed one fails the file instead of being dropped.
  doc.forEach((it, i) => {
    const where = `codex inbound item ${i}`;
    if (!isRecord(it)) throw new MalformedSource(`${where}: not an object`);
    const clientId = requireText(it, "clientId", where);
    const seq = optionalIndex(it, "seq", where);
    const at = optionalNum(it, "at", where);
    const state = str(it.state);
    if (state === "delivered") {
      // An ownership record: the prompt ran; only the receipts matter.
      ledger.addReceipt(sessionId, { kind: "codex_client", ref: clientId, commandId: clientId, at }); report.receipts++;
      if (seq != null) { ledger.addReceipt(sessionId, { kind: "seq", ref: String(seq), commandId: clientId, at }); report.receipts++; }
      return;
    }
    if (typeof it.text !== "string") throw new MalformedSource(`${where}: text must be a string`);
    const target: CommandState = state === "sentUnknown" ? "unknown" : "queued";
    const r = ledger.acceptCommand({
      sessionId, id: clientId, text: it.text, origin: seq != null ? "relay" : "local", source: seq != null ? "relay" : "rpc",
      seq: seq ?? null, visible: false, mirrorToRelay: true, createdAt: at, state: target,
    });
    if (r.deduped !== "none") return;
    report.commands++;
    if (target === "unknown") { ledger.importAttempt(clientId, clientId, "unknown", at ?? Date.now()); report.attempts++; }
  });
}

function importCodexCheckpoint(ledger: Ledger, sessionId: string, doc: unknown, report: ImportReport): void {
  if (!isRecord(doc)) throw new MalformedSource("a codex checkpoint file is an object");
  const high = str(doc.deliveredThroughTurnId);
  // Never backwards: a cursor the ledger already holds is by construction
  // newer than anything the legacy file remembers.
  if (high && !ledger.getCheckpoint(sessionId, "codex_turn")) { ledger.setCheckpoint(sessionId, "codex_turn", high, 0); report.checkpoints++; }
  // Ownership evidence, held to the queue rule: a malformed row fails the
  // file rather than silently forfeiting the dedupe it carries (review d5f35f45).
  const where = "codex checkpoint";
  optionalList(doc, "knownClientIds", where).forEach((id, i) => {
    if (typeof id !== "string" || !id) throw new MalformedSource(`${where}: knownClientIds[${i}] must be a non-empty string`);
    ledger.addReceipt(sessionId, { kind: "codex_client", ref: id, commandId: id }); report.receipts++;
  });
  optionalList(doc, "seqReceipts", where).forEach((r, i) => {
    const where = `codex seq receipt ${i}`;
    if (!isRecord(r)) throw new MalformedSource(`${where}: not an object`);
    const seq = index(r.seq);
    if (seq === undefined) throw new MalformedSource(`${where}: seq must be a non-negative integer`);
    const clientId = requireText(r, "clientId", where);
    ledger.addReceipt(sessionId, { kind: "seq", ref: String(seq), commandId: clientId }); report.receipts++;
    ledger.addReceipt(sessionId, { kind: "codex_client", ref: clientId, commandId: clientId }); report.receipts++;
  });
}

function importSpawns(ledger: Ledger, doc: unknown, report: ImportReport): void {
  if (!isRecord(doc)) throw new MalformedSource("v2-spawns.json is an object");
  for (const [commandId, localId] of Object.entries(doc)) {
    if (typeof localId !== "string" || !localId) continue;
    if (ledger.lookupSpawnIntent(commandId)) continue;
    ledger.spawnIntent(commandId, localId); report.spawnIntents++;
  }
}

/** The execution fields of a window record, validated. A field that is
 *  absent or null is simply not there; one present with the wrong shape is
 *  a MalformedSource — the record is neither imported nor stripped. */
interface RecordFields {
  transcriptCheckpoint?: { path: string; offset: number };
  opencodeDeliveredThrough?: string;
  handoffJob?: HandoffJob;
}
function parseRecordFields(raw: Record<string, unknown>): RecordFields {
  const out: RecordFields = {};
  const cp = raw.transcriptCheckpoint;
  if (cp != null) {
    if (!isRecord(cp)) throw new MalformedSource("transcriptCheckpoint: not an object");
    const path = requireText(cp, "path", "transcriptCheckpoint");
    const offset = index(cp.offset);
    if (offset === undefined) throw new MalformedSource("transcriptCheckpoint: offset must be a non-negative integer");
    out.transcriptCheckpoint = { path, offset };
  }
  const oc = raw.opencodeDeliveredThrough;
  if (oc != null) {
    if (typeof oc !== "string" || !oc) throw new MalformedSource("opencodeDeliveredThrough: must be a non-empty string");
    out.opencodeDeliveredThrough = oc;
  }
  const job = raw.handoffJob;
  if (job != null) {
    if (!isRecord(job)) throw new MalformedSource("handoffJob: not an object");
    out.handoffJob = parseHandoffJob(job);
  }
  return out;
}

const HANDOFF_AGENTS: ReadonlyArray<NonNullable<HandoffJob["target"]>["agent"]> = ["claude", "codex", "opencode", "pi", "agy"];
/** The optional text fields of a handoff target, each a non-empty string when present. */
function optionalText(row: Record<string, unknown>, field: string, where: string): string | undefined {
  const v = row[field];
  if (v == null) return undefined;
  if (typeof v !== "string" || !v) throw new MalformedSource(`${where}: ${field} must be a non-empty string`);
  return v;
}
/** A handoff job in the shape `handoff.ts` resumes (review a7edccec): a
 *  known role, and what that role needs — a source its target harness
 *  (and, once delivered, the session it created), a target its peer. A
 *  job resume would only clear is not accepted execution state; the
 *  record fails until repaired. Unknown fields are not carried. */
function parseHandoffJob(job: Record<string, unknown>): HandoffJob {
  const where = "handoffJob";
  const role = requireText(job, "role", where);
  if (role !== "source" && role !== "target") throw new MalformedSource(`${where}: role must be "source" or "target"`);
  const path = requireText(job, "path", where);
  // `at` is informational (nothing reads it back): validated when present,
  // never invented when a legacy writer left it out.
  const at = optionalIndex(job, "at", where);
  const stamp = at === undefined ? {} : { at };
  if (role === "target") {
    const peer = requireText(job, "peer", `${where} (target)`);
    return { role, path, peer, ...stamp } as HandoffJob;
  }
  const t = job.target;
  if (!isRecord(t)) throw new MalformedSource(`${where} (source): target must be an object`);
  const agent = requireText(t, "agent", `${where}.target`);
  if (!(HANDOFF_AGENTS as readonly string[]).includes(agent)) throw new MalformedSource(`${where}.target: agent must be one of ${HANDOFF_AGENTS.join(", ")}`);
  const target: NonNullable<HandoffJob["target"]> = { agent: agent as (typeof HANDOFF_AGENTS)[number] };
  for (const f of ["model", "effort", "permissionMode"] as const) { const v = optionalText(t, f, `${where}.target`); if (v !== undefined) target[f] = v; }
  const dst = optionalText(job, "dst", `${where} (source)`);
  const delivered = job.delivered;
  if (delivered != null && typeof delivered !== "boolean") throw new MalformedSource(`${where} (source): delivered must be a boolean`);
  if (delivered === true && !dst) throw new MalformedSource(`${where} (source): delivered without the dst session it was delivered to`);
  return { role, path, target, ...(dst ? { dst } : {}), ...(delivered != null ? { delivered } : {}), ...stamp } as HandoffJob;
}

function importRecordFields(ledger: Ledger, sessionId: string, fields: RecordFields, report: ImportReport): void {
  const cp = fields.transcriptCheckpoint;
  if (cp && !ledger.getCheckpoint(sessionId, "claude_transcript")) { ledger.setCheckpoint(sessionId, "claude_transcript", cp.path, cp.offset, { coversReceipts: false }); report.checkpoints++; }
  const oc = fields.opencodeDeliveredThrough;
  if (oc && !ledger.getCheckpoint(sessionId, "opencode_msg")) { ledger.setCheckpoint(sessionId, "opencode_msg", oc, 0); report.checkpoints++; }
  const job = fields.handoffJob;
  if (job && !ledger.getJob(sessionId)) { ledger.putJob({ id: sessionId, sessionId, kind: "handoff", payload: job }); report.jobs++; }
}

export { LedgerWriteError };
