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
//     owns fails it the same way (CommandIdConflictError).
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
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
/** The old `received[]` echo backstop only ever mattered inside this window. */
const RECEIVED_WINDOW_MS = 15 * 60 * 1000;

/** The source parsed, but is not the shape its file class promises. */
class MalformedSource extends Error {
  constructor(what: string) { super(`malformed: ${what}`); this.name = "MalformedSource"; }
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

/** Best-effort read for the window records (a record that does not parse is
 *  not this module's to repair — windowRecord.ts owns it). */
function readJson(path: string): unknown {
  try { return JSON.parse(fs.readFileSync(path, "utf8")); } catch { return null; }
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
  for (const r of records) if (r.v2SessionId) localByV2.set(r.v2SessionId, r.id);

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
    try {
      ledger.tx(() => {
        let m: RegExpExecArray | null;
        if ((m = LEGACY.queue.exec(name))) importQueue(ledger, m[1], src.doc, report);
        else if ((m = LEGACY.receipts.exec(name))) importReceipts(ledger, m[1], src.doc, src.hash, report, now());
        else if (LEGACY.outbound.test(name)) importOutbound(ledger, src.doc, report, opts.sealsContent, localByV2, log);
        else if ((m = LEGACY.codexInbound.exec(name))) importCodexInbound(ledger, m[1], src.doc, report);
        else if ((m = LEGACY.codexCheckpoint.exec(name))) importCodexCheckpoint(ledger, m[1], src.doc, report);
        else if (LEGACY.spawns.test(name)) importSpawns(ledger, src.doc, report);
        ledger.recordImportSource(name, src.hash);
      }, `import ${name}`);
      report.files.push(name);
      move(name);
    } catch (e) {
      // A wrong-shape source throws MalformedSource inside the transaction;
      // tx() wraps it — report the shape complaint, not the wrapper.
      const cause = e instanceof LedgerWriteError ? e.cause : e;
      if (cause instanceof MalformedSource) fail(name, sessionId, "malformed", cause.message);
      else fail(name, sessionId, "import failed", errMsg(e));
    }
  }

  // Window records: the three execution fields move; the record stays.
  for (const rec of records) {
    if (!EXEC_FIELDS.some((f) => rec.raw[f] != null)) continue;
    const file = `window-${rec.id}.json`;
    // Every field is validated BEFORE anything is written or stripped: a
    // malformed one (a string offset) is a failed import of this record —
    // it keeps its fields and its session is quarantined until repaired.
    let fields: RecordFields;
    try { fields = parseRecordFields(rec.raw); }
    catch (e) { fail(file, rec.id, "malformed", errMsg(e)); continue; }
    try { ledger.tx(() => importRecordFields(ledger, rec.id, fields, report), `import ${file}`); }
    catch (e) { fail(file, rec.id, "import failed", errMsg(e)); continue; }
    const stripped: Record<string, unknown> = { ...rec.raw };
    for (const f of EXEC_FIELDS) delete stripped[f];
    // The record is the session's identity (launch cwd, conversation id): it
    // is replaced atomically or not at all. A failed rewrite leaves the old
    // fields in place; importRecordFields ignores them once the ledger has
    // its checkpoint, and the strip is retried next boot.
    try { writeFileAtomic(rec.path, JSON.stringify(stripped)); }
    catch (e) { report.unmoved.push(file); log(`[ledger-import] ${file}: fields imported but the record could not be rewritten (${errMsg(e)}) — record left complete, stripped next boot`); }
    report.files.push(file);
  }

  if (report.failed.length === 0 && report.unmoved.length === 0 && listLegacyFiles(stateDir).length === 0) {
    try { ledger.setMeta("import_v1", "done"); } catch (e) { log(`[ledger-import] could not mark the import done: ${errMsg(e)}`); }
  }
  if (report.files.length) {
    log(`[ledger-import] imported ${report.files.length} legacy file(s): ${report.commands} commands, ${report.attempts} attempts, ${report.receipts} receipts, ${report.outbox} outbox rows, ${report.checkpoints} checkpoints, ${report.spawnIntents} spawn intents, ${report.jobs} jobs${report.repeated.length ? ` (${report.repeated.length} already imported, skipped)` : ""}`);
  }
  return report;
}

interface RecordFile { id: string; path: string; raw: Record<string, unknown>; v2SessionId?: string }
function listRecordFiles(stateDir: string): RecordFile[] {
  let names: string[] = [];
  try { names = fs.readdirSync(stateDir); } catch { return []; }
  const out: RecordFile[] = [];
  for (const n of names) {
    const m = /^window-([0-9a-f]{8})\.json$/.exec(n);
    if (!m) continue;
    const raw = readJson(join(stateDir, n));
    if (!isRecord(raw)) continue;
    out.push({ id: m[1], path: join(stateDir, n), raw, v2SessionId: str(raw.v2SessionId) });
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

function importQueue(ledger: Ledger, sessionId: string, doc: unknown, report: ImportReport): void {
  if (!Array.isArray(doc)) throw new MalformedSource("a queue file is an array of items");
  // Every entry is a command the app accepted: one that cannot be imported
  // fails the file (nothing committed) rather than vanishing.
  doc.forEach((it, i) => {
    const where = `queue item ${i}`;
    if (!isRecord(it)) throw new MalformedSource(`${where}: not an object`);
    const id = requireText(it, "id", where);
    const text = requireText(it, "text", where);
    const seq = optionalNum(it, "seq", where);
    const createdAt = optionalNum(it, "createdAt", where);
    const r = ledger.acceptCommand({
      sessionId, id, text, origin: seq != null ? "relay" : "local",
      source: str(it.source) ?? "rpc", seq: seq ?? null, visible: it.visible !== false, mirrorToRelay: it.mirrorToRelay !== false,
      createdAt,
    });
    if (r.deduped === "none") report.commands++;
  });
}

function importReceipts(ledger: Ledger, sessionId: string, doc: unknown, sourceHash: string, report: ImportReport, now: number): void {
  if (!isRecord(doc)) throw new MalformedSource("a receipts file is an object");
  const inbound = Array.isArray(doc.inbound) ? doc.inbound : [];
  const outbound = Array.isArray(doc.outbound) ? doc.outbound : [];
  const received = Array.isArray(doc.received) ? doc.received : [];
  for (const r of inbound) {
    if (!isRecord(r) || typeof r.uuid !== "string" || !r.uuid) continue;
    ledger.addReceipt(sessionId, { kind: "transcript_uuid", ref: r.uuid, at: num(r.at) }); report.receipts++;
    const seq = num(r.seq);
    if (seq != null) { ledger.addReceipt(sessionId, { kind: "seq", ref: String(seq), at: num(r.at) }); report.receipts++; }
  }
  for (const r of outbound) {
    if (!isRecord(r) || typeof r.uuid !== "string" || !r.uuid) continue;
    ledger.addReceipt(sessionId, { kind: "transcript_uuid", ref: r.uuid, at: num(r.at) }); report.receipts++;
  }
  // The echo backstop: a text the app sent in the last 15 minutes whose
  // transcript echo has not been matched yet. It becomes a synthetic
  // delivered command with an attempt awaiting that echo (runtime_ref = the
  // flattened text), exactly what the live path now records — so the echo
  // pairs with it and is not mirrored back as a duplicate bubble. Its id is
  // a function of the source (hash) and the entry's index: a re-import of
  // the same file finds the same row and adds nothing.
  received.forEach((r, i) => {
    if (!isRecord(r) || typeof r.text !== "string" || !r.text) return;
    const at = num(r.at) ?? 0;
    if (at < now - RECEIVED_WINDOW_MS) return;
    const id = `import:${sessionId}:received:${sourceHash.slice(0, 12)}:${i}`;
    const c = ledger.acceptCommand({ sessionId, id, text: r.text, origin: "import", source: "relay", visible: false, mirrorToRelay: false, createdAt: at, state: "completed" });
    if (c.deduped !== "none") return;
    ledger.importAttempt(c.id, r.text, "unknown", at); report.commands++; report.attempts++;
  });
}

function importOutbound(ledger: Ledger, doc: unknown, report: ImportReport, sealsContent: boolean, localByV2: Map<string, string>, log: (l: string) => void): void {
  if (!Array.isArray(doc)) throw new MalformedSource("v2-outbound.json is an array of entries");
  const rows: NewOutbound[] = [];
  for (const e of doc) {
    if (!isRecord(e) || typeof e.id !== "string") continue;
    const v2 = str(e.v2SessionId) || null;
    const localId = str(e.localId) ?? (v2 ? localByV2.get(v2) : undefined);
    if (!localId) { log(`[ledger-import] v2-outbound entry ${e.id} has no local session (v2 ${v2 ?? "none"}) — dropped`); continue; }
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
    const seq = optionalNum(it, "seq", where);
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
  for (const id of Array.isArray(doc.knownClientIds) ? doc.knownClientIds : []) {
    if (typeof id !== "string" || !id) continue;
    ledger.addReceipt(sessionId, { kind: "codex_client", ref: id, commandId: id }); report.receipts++;
  }
  for (const r of Array.isArray(doc.seqReceipts) ? doc.seqReceipts : []) {
    if (!isRecord(r) || typeof r.seq !== "number" || typeof r.clientId !== "string") continue;
    ledger.addReceipt(sessionId, { kind: "seq", ref: String(r.seq), commandId: r.clientId }); report.receipts++;
    ledger.addReceipt(sessionId, { kind: "codex_client", ref: r.clientId, commandId: r.clientId }); report.receipts++;
  }
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
  handoffJob?: Record<string, unknown>;
}
function parseRecordFields(raw: Record<string, unknown>): RecordFields {
  const out: RecordFields = {};
  const cp = raw.transcriptCheckpoint;
  if (cp != null) {
    if (!isRecord(cp)) throw new MalformedSource("transcriptCheckpoint: not an object");
    const path = requireText(cp, "path", "transcriptCheckpoint");
    const offset = num(cp.offset);
    if (offset === undefined || offset < 0) throw new MalformedSource("transcriptCheckpoint: offset must be a non-negative number");
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
    requireText(job, "role", "handoffJob");
    requireText(job, "path", "handoffJob");
    out.handoffJob = job;
  }
  return out;
}

function importRecordFields(ledger: Ledger, sessionId: string, fields: RecordFields, report: ImportReport): void {
  const cp = fields.transcriptCheckpoint;
  if (cp && !ledger.getCheckpoint(sessionId, "claude_transcript")) { ledger.setCheckpoint(sessionId, "claude_transcript", cp.path, cp.offset); report.checkpoints++; }
  const oc = fields.opencodeDeliveredThrough;
  if (oc && !ledger.getCheckpoint(sessionId, "opencode_msg")) { ledger.setCheckpoint(sessionId, "opencode_msg", oc, 0); report.checkpoints++; }
  const job = fields.handoffJob;
  if (job && !ledger.getJob(sessionId)) { ledger.putJob({ id: sessionId, sessionId, kind: "handoff", payload: job }); report.jobs++; }
}

export { LedgerWriteError };
