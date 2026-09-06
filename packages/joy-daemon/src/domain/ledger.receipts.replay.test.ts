// #560 through a real Claude Session (review 0133a2fb): an answer forwarded
// AFTER the committed transcript cursor keeps its receipt through a prune,
// even with thousands of newer receipts over the cap and a newer cursor held
// pending behind unacked output — so the replacement session's replay from
// the committed cursor does not emit the answer a second time. Both
// emissions would lack a stable occurrence id (no localId, a fresh
// runtimeEventId per emission), so nothing downstream would dedupe them.
import { test, expect, beforeAll, afterAll, vi } from "vitest";
import fs, { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Session } from "../claude/session";
import type { TmuxDriver } from "../tmux/driver";
import { Ledger, DEFAULT_PRUNE_POLICY } from "./ledger";

let home: string;
beforeAll(() => { home = mkdtempSync(join(tmpdir(), "joy-receipt-replay-")); process.env.JOY_HOME_DIR = home; });
afterAll(() => { delete process.env.JOY_HOME_DIR; rmSync(home, { recursive: true, force: true }); });

const RULE = "─".repeat(60);
const READY = [RULE, "❯ ", RULE, "  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents"].join("\n");

/** A scripted tmux whose pane is idle and ready. */
function fakeTmux(pane: string): TmuxDriver {
  return {
    async captureFresh() { return { ok: true, out: pane }; },
    captureCached() { return { ok: true, out: pane }; },
    async key() { return { ok: true, out: "" }; },
    async literal() { return { ok: true, out: "" }; },
    async command() { return { ok: true, out: "" }; },
    async commandOnce() { return { ok: true, out: "" }; },
    runSync() { return { ok: true, out: "" }; },
    track() {}, untrack() {},
  } as unknown as TmuxDriver;
}
function mkSession(id: string, ledger: Ledger, transcriptStartOffset = 0): Session {
  return new Session(
    { id, tmuxWindow: `joy:j-${id}`, cwd: join(home, "cwd"), flags: [], transcriptStartOffset, status: "active", startedAt: 0, tmux: fakeTmux(READY), claudeSessionId: "replay-runtime-sid" } as any,
    { relayClient: null, broadcast: () => {}, addChatMessage: () => {}, ledger } as any,
  );
}
/** A relay stub that records every row a session sends it. */
function relayStub(rows: Array<{ record: any; localId?: string }>): any {
  let sink: ((r: { uuid: string; turn: string }) => void) | null = null;
  return {
    relaySessionId: "rs-replay",
    start() {}, stop() {}, pausePull() {},
    send(record: any, localId?: string) { rows.push({ record, localId }); },
    setThinking() {}, updateRetry() {}, async clearThinkingMeta() {}, async updateLogin() {}, async updateDialog() {},
    setReceiptSink(fn: any) { sink = fn; },
    stampReceiptOnLastQueued(r: { uuid: string; turn: string }) { sink?.(r); }, // the server ack, synchronously
    updateQueue() {}, async updateBgTasks() {}, async updateContext() {}, updateCompacting() {}, updateGoal() {},
    notify() {}, notifyCustom() {}, async updateSummary() {}, async updateModelCode() {}, async archive() { return true; },
    updateJoyState() {},
  };
}

test("#560: a pruned ledger does not make the replacement session re-emit an answer the committed cursor still replays", () => {
  const dir = mkdtempSync(join(tmpdir(), "joy-replay-ledger-"));
  let clock = 10_000;
  const ledger = Ledger.open(dir, { now: () => clock });
  const id = `rp${Date.now().toString(36).slice(-6)}`;
  const rows: Array<{ record: any; localId?: string }> = [];
  let a: Session | null = null;
  let b: Session | null = null;
  try {
    a = mkSession(id, ledger);
    a.attachRelay(relayStub(rows), true);
    // The committed replay origin; the answer arrives after it.
    expect(ledger.setCheckpoint(id, "claude_transcript", "/transcript", 100).committed).toBe(true);
    clock++;
    const entry: any = { type: "assistant", uuid: "already-forwarded", timestamp: new Date(1).toISOString(), message: { role: "assistant", content: [{ type: "text", text: "Already visible answer" }], stop_reason: "end_turn" } };
    a.onTranscriptEntry(entry);
    expect(ledger.hasReceipt(id, "transcript_uuid", "already-forwarded")).toBe(true);
    expect(rows.filter((x) => JSON.stringify(x.record).includes("Already visible answer"))).toHaveLength(1);
    // 5,001 newer receipts (over the default cap) and a newer cursor that
    // cannot commit while its output is unacked.
    ledger.addReceipts(id, Array.from({ length: 5_001 }, (_, n) => ({ kind: "transcript_uuid", ref: `newer-${n}`, at: ++clock })));
    ledger.enqueueOutbound([{ sessionId: id, kind: "output", runtimeEventId: "unacked-later", body: {}, sealed: false }]);
    clock++;
    expect(ledger.setCheckpoint(id, "claude_transcript", "/transcript", 999, { throughSeq: "latest" }).committed).toBe(false);
    ledger.prune(DEFAULT_PRUNE_POLICY);
    expect(ledger.getCheckpoint(id, "claude_transcript")?.offset).toBe(100);
    expect(ledger.hasReceipt(id, "transcript_uuid", "already-forwarded")).toBe(true);
    // The replacement replays from offset 100 and reaches the answer again.
    a.end("restart"); a = null;
    b = mkSession(id, ledger);
    b.attachRelay(relayStub(rows), true);
    b.onTranscriptEntry(entry);
    const answers = rows.filter((x) => JSON.stringify(x.record).includes("Already visible answer"));
    expect(answers).toHaveLength(1);
  } finally {
    a?.end("restart"); b?.end("restart");
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── review 939c279a: insertion order proves nothing about byte coverage after
// a restart. A receipt written by the previous run for an entry BEYOND the
// offset the recovery tailer commits (a short read of the preceding line and
// then a transient EIO → the five-second checkpoint commits offset 79 with an
// ordinal past every receipt) must survive the prune, or the replay from 79
// emits the answer twice. Only this transcript's readSync is fault-injected;
// the real tailer / checkpoint / receipt code and SQLite commits run.

/** Drive the reviewer's partial recovery against `file` for session `id`:
 *  reopen the ledger, tail with a short read of the first line then EIO, let
 *  the five-second checkpoint commit, prune, and hand back the committed
 *  cursor and the reopened ledger. */
async function partialRecovery(dir: string, file: string, prefixBytes: number, id: string, rows: Array<{ record: any; localId?: string }>, sessions: Session[]): Promise<{ ledger: Ledger; cp: NonNullable<ReturnType<Ledger["getCheckpoint"]>> }> {
  let ledger = Ledger.open(dir);
  // A successful short read followed by transient EIO is permitted by the fs
  // contract. Only the transcript fd is injected; SQLite remains real.
  const read = fs.readSync;
  vi.spyOn(fs, "readSync").mockImplementation(((fd: number, buf: Uint8Array, off: number, len: number, pos: number) => {
    let isTranscript = false;
    try { isTranscript = fs.readlinkSync(`/proc/self/fd/${fd}`) === file; } catch { /* not a path-backed fd */ }
    if (isTranscript) {
      if (pos > 0) throw Object.assign(new Error("injected transcript EIO"), { code: "EIO" });
      return read(fd, buf, off, Math.min(len, prefixBytes), pos);
    }
    return read(fd, buf, off, len, pos);
  }) as typeof fs.readSync);
  syncBuiltinESMExports();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  try {
    const b = mkSession(id, ledger); sessions.push(b); b.attachRelay(relayStub(rows), true);
    b.startTailer(file);
    await vi.advanceTimersByTimeAsync(5_100);
    const cp = ledger.getCheckpoint(id, "claude_transcript")!;
    expect(cp).toMatchObject({ ref: file, offset: prefixBytes });     // the partial recovery's cursor committed
    expect(cp.receiptOrd).toBeGreaterThanOrEqual(5_002);              // with an ordinal past every receipt
    ledger.prune(DEFAULT_PRUNE_POLICY);
    b.end("restart");
    ledger.close(); ledger = Ledger.open(dir);
    return { ledger, cp };
  } finally {
    vi.restoreAllMocks(); syncBuiltinESMExports(); vi.useRealTimers();
  }
}
const ANSWER_TEXT = "Already visible answer";
const answerEntry = (): any => ({ type: "assistant", uuid: "already-forwarded", timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "text", text: ANSWER_TEXT }], stop_reason: "end_turn" } });
const answersIn = (rows: Array<{ record: any }>) => rows.filter((x) => JSON.stringify(x.record).includes(ANSWER_TEXT));

test("#560 (review 939c279a): a partial recovery's checkpoint never covers a receipt the tailer observed beyond its committed byte — the answer is emitted exactly once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "joy-c10-partial-replay-"));
  const file = join(dir, "transcript.jsonl");
  let ledger = Ledger.open(dir);
  const id = "c10abcd1";
  const rows: Array<{ record: any; localId?: string }> = [];
  const sessions: Session[] = [];
  const prefix = JSON.stringify({ type: "system", uuid: "prefix", subtype: "local_command", content: "prefix" }) + "\n";
  const prefixBytes = Buffer.byteLength(prefix);
  writeFileSync(file, prefix + JSON.stringify(answerEntry()) + "\n");
  try {
    // Previous run: the real tailer forwards the answer (its line starts at
    // byte `prefixBytes`), then thousands of newer receipts land.
    const a = mkSession(id, ledger); sessions.push(a); a.attachRelay(relayStub(rows), true);
    ledger.setCheckpoint(id, "claude_transcript", file, 0);
    a.startTailer(file);
    expect(answersIn(rows)).toHaveLength(1);
    expect(ledger.getReceipt(id, "transcript_uuid", "already-forwarded")).toMatchObject({ transcriptPath: file, byteOffset: prefixBytes });
    ledger.addReceipts(id, Array.from({ length: 5_001 }, (_, n) => ({ kind: "transcript_uuid", ref: `newer-${n}` })));
    a.end("restart"); ledger.close();
    const r = await partialRecovery(dir, file, prefixBytes, id, rows, sessions);
    ledger = r.ledger;
    // The receipt's observed position is not below the committed offset:
    // the prune left it alone despite its low ordinal.
    expect(ledger.hasReceipt(id, "transcript_uuid", "already-forwarded")).toBe(true);
    expect(answersIn(rows)).toHaveLength(1);
    // The replacement replays from the committed cursor, reaches the answer
    // and skips it on the retained receipt.
    const c = mkSession(id, ledger, r.cp.offset); sessions.push(c); c.attachRelay(relayStub(rows), true);
    c.startTailer(file);
    expect(answersIn(rows)).toHaveLength(1);
  } finally {
    for (const s of sessions) s.end("restart");
    vi.restoreAllMocks(); syncBuiltinESMExports(); vi.useRealTimers();
    ledger.close(); rmSync(dir, { recursive: true, force: true });
  }
});

test("#560 (review 939c279a): a receipt from before positions were recorded is retained through the partial recovery and placed by the replay", async () => {
  const dir = mkdtempSync(join(tmpdir(), "joy-c10-partial-replay-unplaced-"));
  const file = join(dir, "transcript.jsonl");
  let ledger = Ledger.open(dir);
  const id = "c10abcd2";
  const rows: Array<{ record: any; localId?: string }> = [];
  const sessions: Session[] = [];
  const prefix = JSON.stringify({ type: "system", uuid: "prefix", subtype: "local_command", content: "prefix" }) + "\n";
  const prefixBytes = Buffer.byteLength(prefix);
  writeFileSync(file, prefix + JSON.stringify(answerEntry()) + "\n");
  try {
    // The reviewer's exact shape: the answer reaches the session without a
    // tailer position (as every receipt written before this change did).
    const a = mkSession(id, ledger); sessions.push(a); a.attachRelay(relayStub(rows), true);
    ledger.setCheckpoint(id, "claude_transcript", file, 0);
    a.onTranscriptEntry(answerEntry());
    expect(ledger.getReceipt(id, "transcript_uuid", "already-forwarded")).toMatchObject({ transcriptPath: null, byteOffset: null });
    ledger.addReceipts(id, Array.from({ length: 5_001 }, (_, n) => ({ kind: "transcript_uuid", ref: `newer-${n}` })));
    expect(answersIn(rows)).toHaveLength(1);
    a.end("restart"); ledger.close();
    const r = await partialRecovery(dir, file, prefixBytes, id, rows, sessions);
    ledger = r.ledger;
    expect(ledger.hasReceipt(id, "transcript_uuid", "already-forwarded")).toBe(true); // no position → never pruned by ordinal
    const c = mkSession(id, ledger, r.cp.offset); sessions.push(c); c.attachRelay(relayStub(rows), true);
    c.startTailer(file);
    expect(answersIn(rows)).toHaveLength(1);
    // Re-observed by the replay: the receipt now carries the position a
    // later cursor can cover.
    expect(ledger.getReceipt(id, "transcript_uuid", "already-forwarded")).toMatchObject({ transcriptPath: file, byteOffset: prefixBytes });
  } finally {
    for (const s of sessions) s.end("restart");
    vi.restoreAllMocks(); syncBuiltinESMExports(); vi.useRealTimers();
    ledger.close(); rmSync(dir, { recursive: true, force: true });
  }
});
