// Delivered-turn checkpoint for codex reconciliation (gpt-5.6-sol review #2 +
// live finding 2026-07-24): on reconnect we replay thread/read history, but the
// per-ITEM ids differ between live notifications (msg_…/call_…) and thread/read
// history (positional item-N), so item-id dedup at the append layer does NOT
// work across a restart. Turn ids ARE stable, though — so we checkpoint which
// turns were fully delivered and skip them wholesale on reconcile, replaying
// only turns not yet delivered. Bounded to the most recent ids.

import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { joyStateDir } from "../paths";

const MAX_TURNS = 500;

function fileFor(id: string, baseDir: string): string {
  return join(baseDir, `codex-checkpoint-${id}.json`);
}

export function loadDeliveredTurns(id: string, baseDir = joyStateDir()): Set<string> {
  try {
    const p = fileFor(id, baseDir);
    if (!existsSync(p)) return new Set();
    const parsed = JSON.parse(readFileSync(p, "utf8"));
    return new Set(Array.isArray(parsed) ? parsed as string[] : []);
  } catch { return new Set(); }
}

export function saveDeliveredTurns(id: string, turns: Set<string>, baseDir = joyStateDir()): void {
  try {
    mkdirSync(baseDir, { recursive: true });
    const arr = [...turns].slice(-MAX_TURNS);
    const p = fileFor(id, baseDir);
    const tmp = `${p}.tmp`;
    writeFileSync(tmp, JSON.stringify(arr));
    renameSync(tmp, p);
  } catch (e) {
    process.stderr.write(`[codex-checkpoint] save failed for ${id}: ${e}\n`);
  }
}

export function clearDeliveredTurns(id: string, baseDir = joyStateDir()): void {
  try { rmSync(fileFor(id, baseDir), { force: true }); } catch { /* best effort */ }
}
