// Fork a conversation for harnesses that have no native fork: each keeps its
// history in ONE file keyed by the conversation id, so a fork is copy the file
// under a fresh id and rewrite the id inside it. Claude has --fork-session and
// does not come through here; opencode keeps sessions inside its server with
// no fork surface, so it is refused (see the op).
//
//   agy   ~/.gemini/antigravity-cli/conversations/<id>.db — SQLite; the id is
//         trajectory_meta.cascade_id (probed live 2026-09-04: a copy with
//         cascade_id + trajectory_id rewritten resumes with full memory).
//   pi    ~/.pi/agent/sessions/<cwd-key>/<ts>_<id>.jsonl — first line is
//         {"type":"session","id":…}; later entries chain by parentId only.
//   codex ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl — first line is
//         session_meta with payload.id and payload.session_id.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";

export class ForkUnsupported extends Error {}

/** A live harness may be mid-append: keep only lines terminated by a newline
 *  so the copy never ends inside a JSON record. */
function completeLines(text: string): string[] {
  const cut = text.lastIndexOf("\n");
  return (cut >= 0 ? text.slice(0, cut) : text).split("\n");
}

export function forkAgyConversation(conversationId: string): string {
  const dir = join(homedir(), ".gemini", "antigravity-cli", "conversations");
  const src = join(dir, `${conversationId}.db`);
  if (!existsSync(src)) throw new ForkUnsupported(`Antigravity conversation ${conversationId.slice(0, 8)} has no local database to fork`);
  const id = randomUUID();
  const dst = join(dir, `${id}.db`);
  // node:sqlite is experimental but present on every Node this daemon runs on.
  // The daemon is ESM (tsx) — no bare `require`; go through createRequire.
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as { DatabaseSync: new (p: string, o?: { readOnly?: boolean }) => { prepare(sql: string): { run(...a: unknown[]): unknown }; exec(sql: string): void; close(): void } };
  // agy's conversation DBs are WAL-mode: a file copy misses committed pages
  // still in the -wal, and a copy mid-write is not a consistent snapshot.
  // VACUUM INTO writes a complete, consistent copy through SQLite itself.
  const srcDb = new DatabaseSync(src, { readOnly: true });
  try { srcDb.exec(`VACUUM INTO '${dst.replace(/'/g, "''")}'`); } finally { srcDb.close(); }
  const db = new DatabaseSync(dst);
  try { db.prepare("update trajectory_meta set cascade_id = ?, trajectory_id = ?").run(id, randomUUID()); }
  finally { db.close(); }
  return id;
}

/** Find pi's session file for an id in any cwd-key directory (the key format
 *  is pi's own; matching the filename suffix avoids re-deriving it). */
export function findPiSessionFile(sessionId: string): { dir: string; file: string } | null {
  const root = join(homedir(), ".pi", "agent", "sessions");
  if (!existsSync(root)) return null;
  for (const d of readdirSync(root)) {
    const dir = join(root, d);
    let files: string[];
    try { files = readdirSync(dir); } catch { continue; }
    const file = files.find((f) => f.endsWith(`_${sessionId}.jsonl`));
    if (file) return { dir, file };
  }
  return null;
}

export function forkPiSession(sessionId: string): string {
  const hit = findPiSessionFile(sessionId);
  if (!hit) throw new ForkUnsupported(`pi session ${sessionId.slice(0, 8)} has no session file to fork`);
  const id = randomUUID();
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const lines = completeLines(readFileSync(join(hit.dir, hit.file), "utf8"));
  const first = JSON.parse(lines[0]) as Record<string, unknown>;
  if (first.type !== "session") throw new ForkUnsupported("pi session file has an unexpected header");
  first.id = id; first.timestamp = new Date().toISOString();
  lines[0] = JSON.stringify(first);
  writeFileSync(join(hit.dir, `${ts}_${id}.jsonl`), lines.join("\n"));
  return id;
}

/** Locate a codex rollout by thread id (any day directory). */
export function findCodexRollout(threadId: string): string | null {
  const root = join(homedir(), ".codex", "sessions");
  if (!existsSync(root)) return null;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: string[];
    try { entries = readdirSync(dir); } catch { continue; }
    for (const e of entries) {
      const p = join(dir, e);
      if (e.startsWith("rollout-") && e.endsWith(`-${threadId}.jsonl`)) return p;
      if (!e.includes(".")) stack.push(p);
    }
  }
  return null;
}

export function forkCodexThread(threadId: string): string {
  const src = findCodexRollout(threadId);
  if (!src) throw new ForkUnsupported(`Codex thread ${threadId.slice(0, 8)} has no rollout file to fork`);
  const id = randomUUID();
  const now = new Date();
  const ts = now.toISOString().slice(0, 19).replace(/[:]/g, "-");
  const lines = completeLines(readFileSync(src, "utf8"));
  const first = JSON.parse(lines[0]) as { type?: string; payload?: Record<string, unknown> };
  if (first.type !== "session_meta" || !first.payload) throw new ForkUnsupported("codex rollout has an unexpected header");
  first.payload.id = id; first.payload.session_id = id; first.payload.timestamp = now.toISOString();
  lines[0] = JSON.stringify(first);
  const dir = join(homedir(), ".codex", "sessions", String(now.getUTCFullYear()), String(now.getUTCMonth() + 1).padStart(2, "0"), String(now.getUTCDate()).padStart(2, "0"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `rollout-${ts}-${id}.jsonl`), lines.join("\n"));
  return id;
}
