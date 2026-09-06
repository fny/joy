// Durable inbound spool for codex sessions (gpt-5.6-sol review #1). App→codex
// messages must survive a daemon crash between "relay delivered it to us" and
// "codex confirmed it", because clientUserMessageId is CORRELATION, not
// idempotency — resending the same id can create a second turn. So we persist
// each message with a lifecycle before touching the wire:
//   queued      — persisted, not yet sent to codex
//   sentUnknown — turn/start returned, but no userMessage echo confirms it
// On the echo (item userMessage.clientId), the entry is removed (delivered).
// On recovery, thread/read's userMessage items tell us which clientIds already
// landed; the rest are resent.

import { existsSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { joyStateDir } from "../paths";
import { writeFileAtomic } from "../domain/atomicWrite";

/** delivered = ownership only: the echo proved delivery but the checkpoint
 *  could not be saved, so the spool keeps the clientId; never dispatched. */
export type CodexInboundState = "queued" | "sentUnknown" | "delivered";
export interface CodexInboundItem {
  clientId: string;   // stable clientUserMessageId (created once, reused on retry)
  text: string;
  state: CodexInboundState;
  at: number;
  // Relay sequence this message came from (finding #3b). The relay's confirmed
  // cursor can redeliver the same seq after a crash-before-cursor-persist; the
  // seq lets us DEDUPE the spool insertion (same seq → same logical message)
  // and derive a STABLE clientId, so a redelivery never creates a second turn.
  // Absent for non-relay sends (app RPC/local), which aren't cursor-replayed.
  seq?: number;
}

function fileFor(id: string, baseDir: string): string {
  return join(baseDir, `codex-inbound-${id}.json`);
}

export function loadCodexInbound(id: string, baseDir = joyStateDir()): CodexInboundItem[] {
  try {
    const p = fileFor(id, baseDir);
    if (!existsSync(p)) return [];
    const parsed = JSON.parse(readFileSync(p, "utf8"));
    return Array.isArray(parsed) ? parsed as CodexInboundItem[] : [];
  } catch { return []; }
}

/** Atomic replace through the shared primitive (Wave B adoption of the A2
 *  helper: fsync'd temp + rename, previous spool intact on any failure, no
 *  stray .tmp). Returns false on failure so the caller can refuse to advance
 *  the relay cursor (a swallowed write = a lost message on crash). */
export function saveCodexInbound(id: string, items: CodexInboundItem[], baseDir = joyStateDir()): boolean {
  try {
    writeFileAtomic(fileFor(id, baseDir), JSON.stringify(items));
    return true;
  } catch (e) {
    process.stderr.write(`[codex-inbound] save failed for ${id}: ${e}\n`);
    return false;
  }
}

export function clearCodexInbound(id: string, baseDir = joyStateDir()): void {
  try { rmSync(fileFor(id, baseDir), { force: true }); } catch { /* best effort */ }
}
