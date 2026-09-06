// One-time, versioned import of the legacy per-file stores into the ledger
// (design §1.4). Runs at daemon boot, before any session is recovered, and
// only until every legacy file is gone (`schema_meta.import_v1 = done`).
//
// Idempotent under a crash at any point: each source file is imported in ONE
// transaction with insert-or-ignore semantics on the natural keys (command
// id, receipt primary key, runtime_event_id, spawn intent id), and only after
// COMMIT is the file moved to `<stateDir>/imported-v1/`. A crash between the
// commit and the move re-imports a file whose rows already exist — zero
// effect. The originals are preserved for inspection, never deleted.
//
// The legacy parsers live here now (they used to be the stores' loaders);
// nothing else in the daemon reads these files any more.
import fs from "node:fs";
import { join } from "node:path";
import { Ledger, LedgerWriteError, type CommandState, type NewOutbound } from "./ledger";

export interface ImportReport {
  skipped: boolean;
  files: string[];
  commands: number;
  attempts: number;
  receipts: number;
  outbox: number;
  checkpoints: number;
  spawnIntents: number;
  jobs: number;
  /** Files that could not be moved after their import committed (retried next boot). */
  unmoved: string[];
  /** Files whose import failed (left in place, retried next boot). */
  failed: Array<{ file: string; error: string }>;
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
/** The old `received[]` echo backstop only ever mattered inside this window. */
const RECEIVED_WINDOW_MS = 15 * 60 * 1000;

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
  const report: ImportReport = { skipped: false, files: [], commands: 0, attempts: 0, receipts: 0, outbox: 0, checkpoints: 0, spawnIntents: 0, jobs: 0, unmoved: [], failed: [] };
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
      log(`[ledger-import] ${name}: imported but could not be moved aside (${e instanceof Error ? e.message : e}) — re-imported (no-op) next boot`);
    }
  };

  for (const name of files) {
    const path = join(stateDir, name);
    try {
      ledger.tx(() => {
        let m: RegExpExecArray | null;
        if ((m = LEGACY.queue.exec(name))) importQueue(ledger, m[1], readJson(path), report);
        else if ((m = LEGACY.receipts.exec(name))) importReceipts(ledger, m[1], readJson(path), report, now());
        else if (LEGACY.outbound.test(name)) importOutbound(ledger, readJson(path), report, opts.sealsContent, localByV2, log);
        else if ((m = LEGACY.codexInbound.exec(name))) importCodexInbound(ledger, m[1], readJson(path), report);
        else if ((m = LEGACY.codexCheckpoint.exec(name))) importCodexCheckpoint(ledger, m[1], readJson(path), report);
        else if (LEGACY.spawns.test(name)) importSpawns(ledger, readJson(path), report);
      }, `import ${name}`);
      report.files.push(name);
      move(name);
    } catch (e) {
      report.failed.push({ file: name, error: e instanceof Error ? e.message : String(e) });
      log(`[ledger-import] ${name}: import failed (${e instanceof Error ? e.message : e}) — left in place, retried next boot`);
    }
  }

  // Window records: the three execution fields move; the record stays.
  for (const rec of records) {
    if (!EXEC_FIELDS.some((f) => rec.raw[f] !== undefined)) continue;
    try {
      ledger.tx(() => importRecordFields(ledger, rec.id, rec.raw, report), `import window-${rec.id}`);
      const stripped: Record<string, unknown> = { ...rec.raw };
      for (const f of EXEC_FIELDS) delete stripped[f];
      try { fs.writeFileSync(rec.path, JSON.stringify(stripped)); }
      catch (e) { report.unmoved.push(`window-${rec.id}.json`); log(`[ledger-import] window-${rec.id}.json: fields imported but the record could not be rewritten (${e instanceof Error ? e.message : e})`); }
      report.files.push(`window-${rec.id}.json`);
    } catch (e) {
      report.failed.push({ file: `window-${rec.id}.json`, error: e instanceof Error ? e.message : String(e) });
    }
  }

  if (report.failed.length === 0 && report.unmoved.length === 0 && listLegacyFiles(stateDir).length === 0) {
    try { ledger.setMeta("import_v1", "done"); } catch (e) { log(`[ledger-import] could not mark the import done: ${e instanceof Error ? e.message : e}`); }
  }
  if (report.files.length) {
    log(`[ledger-import] imported ${report.files.length} legacy file(s): ${report.commands} commands, ${report.attempts} attempts, ${report.receipts} receipts, ${report.outbox} outbox rows, ${report.checkpoints} checkpoints, ${report.spawnIntents} spawn intents, ${report.jobs} jobs`);
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

function importQueue(ledger: Ledger, sessionId: string, doc: unknown, report: ImportReport): void {
  if (!Array.isArray(doc)) return;
  for (const it of doc) {
    if (!isRecord(it) || typeof it.id !== "string" || typeof it.text !== "string" || !it.text) continue;
    const seq = num(it.seq);
    const r = ledger.acceptCommand({
      sessionId, id: it.id, text: it.text, origin: seq != null ? "relay" : "local",
      source: str(it.source) ?? "rpc", seq: seq ?? null, visible: it.visible !== false, mirrorToRelay: it.mirrorToRelay !== false,
      createdAt: num(it.createdAt),
    });
    if (r.deduped === "none") report.commands++;
  }
}

function importReceipts(ledger: Ledger, sessionId: string, doc: unknown, report: ImportReport, now: number): void {
  if (!isRecord(doc)) return;
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
  // pairs with it and is not mirrored back as a duplicate bubble.
  for (const r of received) {
    if (!isRecord(r) || typeof r.text !== "string" || !r.text) continue;
    const at = num(r.at) ?? 0;
    if (at < now - RECEIVED_WINDOW_MS) continue;
    const c = ledger.acceptCommand({ sessionId, text: r.text, origin: "import", source: "relay", visible: false, mirrorToRelay: false, createdAt: at, state: "completed" });
    if (c.deduped !== "none") continue;
    ledger.importAttempt(c.id, r.text, "unknown", at); report.commands++; report.attempts++;
  }
}

function importOutbound(ledger: Ledger, doc: unknown, report: ImportReport, sealsContent: boolean, localByV2: Map<string, string>, log: (l: string) => void): void {
  if (!Array.isArray(doc)) return;
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
  const before = ledger.sessionsWithOutbound().length;
  const seqs = ledger.enqueueOutbound(rows);
  void before;
  report.outbox += seqs.length;
}

function importCodexInbound(ledger: Ledger, sessionId: string, doc: unknown, report: ImportReport): void {
  if (!Array.isArray(doc)) return;
  for (const it of doc) {
    if (!isRecord(it) || typeof it.clientId !== "string" || !it.clientId) continue;
    const seq = num(it.seq);
    const state = str(it.state);
    if (state === "delivered") {
      // An ownership record: the prompt ran; only the receipts matter.
      ledger.addReceipt(sessionId, { kind: "codex_client", ref: it.clientId, commandId: it.clientId, at: num(it.at) }); report.receipts++;
      if (seq != null) { ledger.addReceipt(sessionId, { kind: "seq", ref: String(seq), commandId: it.clientId, at: num(it.at) }); report.receipts++; }
      continue;
    }
    if (typeof it.text !== "string") continue;
    const target: CommandState = state === "sentUnknown" ? "unknown" : "queued";
    const r = ledger.acceptCommand({
      sessionId, id: it.clientId, text: it.text, origin: seq != null ? "relay" : "local", source: seq != null ? "relay" : "rpc",
      seq: seq ?? null, visible: false, mirrorToRelay: true, createdAt: num(it.at), state: target,
    });
    if (r.deduped !== "none") continue;
    report.commands++;
    if (target === "unknown") { ledger.importAttempt(it.clientId, it.clientId, "unknown", num(it.at) ?? Date.now()); report.attempts++; }
  }
}

function importCodexCheckpoint(ledger: Ledger, sessionId: string, doc: unknown, report: ImportReport): void {
  if (!isRecord(doc)) return;
  const high = str(doc.deliveredThroughTurnId);
  if (high) { ledger.setCheckpoint(sessionId, "codex_turn", high, 0); report.checkpoints++; }
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
  if (!isRecord(doc)) return;
  for (const [commandId, localId] of Object.entries(doc)) {
    if (typeof localId !== "string" || !localId) continue;
    if (ledger.lookupSpawnIntent(commandId)) continue;
    ledger.spawnIntent(commandId, localId); report.spawnIntents++;
  }
}

function importRecordFields(ledger: Ledger, sessionId: string, raw: Record<string, unknown>, report: ImportReport): void {
  const cp = raw.transcriptCheckpoint;
  if (isRecord(cp) && typeof cp.path === "string" && typeof cp.offset === "number") {
    if (!ledger.getCheckpoint(sessionId, "claude_transcript")) { ledger.setCheckpoint(sessionId, "claude_transcript", cp.path, cp.offset); report.checkpoints++; }
  }
  const oc = raw.opencodeDeliveredThrough;
  if (typeof oc === "string" && oc) {
    if (!ledger.getCheckpoint(sessionId, "opencode_msg")) { ledger.setCheckpoint(sessionId, "opencode_msg", oc, 0); report.checkpoints++; }
  }
  const job = raw.handoffJob;
  if (isRecord(job) && typeof job.role === "string" && typeof job.path === "string") {
    if (!ledger.getJob(sessionId)) { ledger.putJob({ id: sessionId, sessionId, kind: "handoff", payload: job }); report.jobs++; }
  }
}

export { LedgerWriteError };
