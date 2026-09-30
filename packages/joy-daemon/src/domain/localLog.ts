// The event log of a local-only session (domain/localOnly.ts): the records a
// relay-bound session would upload, kept on this machine instead, one JSON
// line each in ~/.joy/sessions/<id>/records.jsonl. The storage scan already
// counts that folder, and deleting the session's files removes the history.
//
// Each line is { seq, at, record }. `seq` starts at 1 and has no gaps, like
// the relay's event log, so a client pages it the same way (`after`,
// `before`, `limit`) and follows it through subscribe().
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { joySessionDir } from "../paths";

export interface LocalRecord { seq: number; at: number; record: unknown }

type Listener = (rec: LocalRecord) => void;

const heads = new Map<string, number>();
const listeners = new Map<string, Set<Listener>>();

const fileOf = (id: string) => join(joySessionDir(id), "records.jsonl");

function readAll(id: string): LocalRecord[] {
  const f = fileOf(id);
  if (!existsSync(f)) return [];
  const out: LocalRecord[] = [];
  for (const line of readFileSync(f, "utf8").split("\n")) {
    if (!line) continue;
    try { out.push(JSON.parse(line) as LocalRecord); } catch { /* a torn last line after a crash: skip it */ }
  }
  return out;
}

/** The newest seq, or 0 for an empty log. */
export function localHeadSeq(id: string): number {
  let h = heads.get(id);
  if (h === undefined) {
    const all = readAll(id);
    h = all.length ? all[all.length - 1].seq : 0;
    heads.set(id, h);
  }
  return h;
}

/** Append one record; returns its seq. Durable when this returns. */
export function appendLocalRecord(id: string, record: unknown, now = Date.now()): number {
  const seq = localHeadSeq(id) + 1;
  const rec: LocalRecord = { seq, at: now, record };
  mkdirSync(joySessionDir(id), { recursive: true });
  appendFileSync(fileOf(id), JSON.stringify(rec) + "\n");
  heads.set(id, seq);
  for (const fn of listeners.get(id) ?? []) { try { fn(rec); } catch { /* a listener's failure is its own */ } }
  return seq;
}

/** The last `n` records. */
export function lastLocalRecords(id: string, n: number): LocalRecord[] {
  const all = readAll(id);
  return all.slice(Math.max(0, all.length - Math.max(0, Math.floor(n))));
}

/** A page of the log: records after `after`, or the last `limit` before
 *  `before` — oldest first either way. */
export function pageLocalRecords(id: string, q: { after?: number; before?: number; limit?: number }): LocalRecord[] {
  const limit = Math.max(1, Math.min(500, Math.floor(q.limit ?? 200)));
  const all = readAll(id);
  if (q.before !== undefined) {
    const older = all.filter((r) => r.seq < q.before!);
    return older.slice(Math.max(0, older.length - limit));
  }
  const after = q.after ?? 0;
  return all.filter((r) => r.seq > after).slice(0, limit);
}

/** Call `fn(record)` after every append to this session's log. */
export function subscribeLocalLog(id: string, fn: Listener): () => void {
  let set = listeners.get(id);
  if (!set) { set = new Set(); listeners.set(id, set); }
  set.add(fn);
  return () => { set!.delete(fn); if (set!.size === 0) listeners.delete(id); };
}

/** Tests only. */
export function _resetLocalLog(): void { heads.clear(); listeners.clear(); }
