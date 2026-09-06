// The lane scenario scripts were written against the JSON outbound spool
// (v2-outbound.json). The spool is the ledger's outbox now (Wave C1); this
// shim gives the scripts the same read/seed/fault surface over the ledger so
// their interleavings replay unchanged:
//   spool(dir)            → { size, all(), hasTerminalFor(turn), pendingOutputs(localId) }
//   seedSpool(dir, legacy) → commits legacy-shaped entries as outbox rows
//   blockLedgerWrites(dir) / unblockLedgerWrites(dir) → the old "mkdirSync(spoolPath+'.tmp')" disk fault
//   codexDeliveredThrough(dir, id) / opencodeDeliveredThrough(dir, id) → the checkpoints
import { ledgerFor, type Ledger, type NewOutbound } from "../src/domain/ledger.ts";

export interface LegacyEntry {
  kind: "output" | "terminal";
  id: string;
  localId?: string;
  v2SessionId: string | null;
  turnId: string | null;
  wire?: unknown;
  body?: Record<string, unknown>;
  runtimeEventId?: string;
  at: number;
  sealed?: boolean;
  key?: string;
}

const toRow = (e: LegacyEntry): NewOutbound => e.kind === "terminal"
  ? { sessionId: e.localId ?? e.v2SessionId ?? "", kind: "terminal", runtimeEventId: `term:${e.turnId}`, relayTurnId: e.turnId, v2SessionId: e.v2SessionId, sealed: false, body: e.body ?? {}, createdAt: e.at }
  : { sessionId: e.localId ?? e.v2SessionId ?? "", kind: "output", runtimeEventId: e.runtimeEventId ?? `rec:${e.id}`, relayTurnId: e.turnId, v2SessionId: e.v2SessionId, sealed: e.sealed ?? false, keyB64: e.key ?? null, body: e.wire, createdAt: e.at };

export function seedSpool(stateDir: string, entries: LegacyEntry[]): number[] {
  // A legacy terminal without a localId belongs to the session whose outputs
  // share its relay row (what the real import resolves from window records).
  const localByV2 = new Map(entries.filter((e) => e.localId && e.v2SessionId).map((e) => [e.v2SessionId as string, e.localId as string]));
  return ledgerFor(stateDir).enqueueOutbound(entries.map((e) => toRow(e.localId || !e.v2SessionId ? e : { ...e, localId: localByV2.get(e.v2SessionId) ?? e.localId })));
}

export function spool(stateDir: string) {
  const l: Ledger = ledgerFor(stateDir);
  const rows = () => l.sessionsWithOutbound().flatMap((sid) => l.pendingOutbound(sid));
  return {
    get size() { return rows().length; },
    all: () => rows().map((r) => ({ kind: r.kind, id: r.runtimeEventId.replace(/^rec:/, ""), localId: r.sessionId, v2SessionId: r.v2SessionId, turnId: r.relayTurnId })),
    hasTerminalFor: (turnId: string) => l.hasTerminalFor(turnId),
    pendingOutputs: (localId: string) => l.pendingOutbound(localId).filter((r) => r.kind === "output").length,
  };
}

const blocked = new Map<string, () => void>();
/** Every ledger COMMIT fails until unblockLedgerWrites — the disk-full fault. */
export function blockLedgerWrites(stateDir: string): void {
  const l = ledgerFor(stateDir);
  const db = l.db as unknown as { exec: (sql: string) => void };
  const real = db.exec.bind(db);
  db.exec = (sql: string) => { if (sql === "COMMIT") throw new Error("SQLITE_FULL: database or disk is full (simulated)"); return real(sql); };
  blocked.set(stateDir, () => { db.exec = real; });
}
export function unblockLedgerWrites(stateDir: string): void {
  blocked.get(stateDir)?.();
  blocked.delete(stateDir);
}

/** The COMMITTED delivered-through mark (null while nothing is committed). */
export const codexDeliveredThrough = (stateDir: string, id: string): string | null => ledgerFor(stateDir).getCheckpoint(id, "codex_turn")?.ref || null;
/** A mark recorded but still pending on its outbox rows' acks (#67). */
export const codexPendingThrough = (stateDir: string, id: string): string | null => ledgerFor(stateDir).getCheckpoint(id, "codex_turn")?.pendingRef ?? null;
export const opencodeDeliveredThrough = (stateDir: string, id: string): string | undefined => ledgerFor(stateDir).getCheckpoint(id, "opencode_msg")?.ref;
