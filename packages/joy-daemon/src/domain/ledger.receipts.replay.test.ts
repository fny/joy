// #560 through a real Claude Session (review 0133a2fb): an answer forwarded
// AFTER the committed transcript cursor keeps its receipt through a prune,
// even with thousands of newer receipts over the cap and a newer cursor held
// pending behind unacked output — so the replacement session's replay from
// the committed cursor does not emit the answer a second time. Both
// emissions would lack a stable occurrence id (no localId, a fresh
// runtimeEventId per emission), so nothing downstream would dedupe them.
import { test, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
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
function mkSession(id: string, ledger: Ledger): Session {
  return new Session(
    { id, tmuxWindow: `joy:j-${id}`, cwd: join(home, "cwd"), flags: [], status: "active", startedAt: 0, tmux: fakeTmux(READY), claudeSessionId: "replay-runtime-sid" } as any,
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
