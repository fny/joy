import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { joyStateDir } from "../paths";

// Persisted outbound relay queue (codex review 2026-07-11, finding 1). The
// in-memory send queue died with the daemon while receipts had already marked
// its rows "forwarded" — the app permanently missed that output. Rows are
// persisted from enqueue until server ack; localIds are STABLE across restarts
// so the idempotent v3 POST collapses retries. `ackedReceipts` buffers receipt
// payloads whose rows acked before a Session registered the receipt sink
// (restart drains can outrun attachRelay).

export interface PersistedOutboundItem {
  localId: string;
  wire: unknown;
  /** Receipt payload stamped on the LAST row of a transcript-entry group —
   *  written to the receipts log only when this row (thus the group) acks. */
  receipt?: { uuid: string; turn: string };
}

export interface PersistedOutboundState {
  items: PersistedOutboundItem[];
  ackedReceipts: { uuid: string; turn: string }[];
}

function fileFor(relaySessionId: string, baseDir: string): string {
  return join(baseDir, `outbound-${relaySessionId}.json`);
}

export function loadOutbound(relaySessionId: string, baseDir = joyStateDir()): PersistedOutboundState {
  try {
    const p = fileFor(relaySessionId, baseDir);
    if (!existsSync(p)) return { items: [], ackedReceipts: [] };
    const parsed = JSON.parse(readFileSync(p, "utf8")) as PersistedOutboundState;
    if (!parsed || !Array.isArray(parsed.items)) return { items: [], ackedReceipts: [] };
    return { items: parsed.items, ackedReceipts: Array.isArray(parsed.ackedReceipts) ? parsed.ackedReceipts : [] };
  } catch {
    return { items: [], ackedReceipts: [] };
  }
}

/** Atomic write (tmp+rename), same idiom as the dispatch-queue spool. Throws
 *  are swallowed — outbound rows also live in memory, and the next mutation
 *  retries the write; a read-only disk degrades to pre-persistence behavior. */
export function saveOutbound(relaySessionId: string, state: PersistedOutboundState, baseDir = joyStateDir()): boolean {
  try {
    mkdirSync(baseDir, { recursive: true });
    const p = fileFor(relaySessionId, baseDir);
    const tmp = `${p}.tmp`;
    writeFileSync(tmp, JSON.stringify(state));
    renameSync(tmp, p);
    return true;
  } catch (e) {
    // Reported, not thrown: rows also live in memory and the next mutation
    // retries — but the CALLER must know (5.6-sol audit #2: a swallowed
    // outbound-persist failure while the transcript checkpoint advanced left
    // a crash with neither persisted rows NOR replay coverage).
    process.stderr.write(`[outbound] save failed for ${relaySessionId}: ${e}\n`);
    return false;
  }
}

export function clearOutbound(relaySessionId: string, baseDir = joyStateDir()): void {
  try { rmSync(fileFor(relaySessionId, baseDir), { force: true }); } catch { /* best effort */ }
}
