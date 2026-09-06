// Ledger API contract: acceptance = commit, five distinct identities,
// dedupe against pending rows AND retained receipts, generation fence,
// cancel-before-dispatch, outbox order + backpressure, pending checkpoints.
import { test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Ledger, ledgerFor, closeAllLedgers, SessionEndedError, StaleGenerationError, StaleCommandError, LedgerWriteError,
  OUTBOX_MAX_ROWS,
} from "./ledger";

let dir: string;
let now = 1_000_000;
let ledger: Ledger;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "ledger-")); now = 1_000_000; ledger = Ledger.open(dir, { now: () => now }); });
afterEach(() => { ledger.close(); closeAllLedgers(); rmSync(dir, { recursive: true, force: true }); });

const accept = (sessionId: string, text: string, extra: Partial<Parameters<Ledger["acceptCommand"]>[0]> = {}) =>
  ledger.acceptCommand({ sessionId, text, source: "rpc", visible: true, mirrorToRelay: true, ...extra });

test("open creates the database with WAL + FULL and a schema version", () => {
  expect(existsSync(join(dir, "ledger.sqlite"))).toBe(true);
  expect(ledger.getMeta("version")).toBe("1");
  expect((ledger.db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toBe("wal");
  expect((ledger.db.prepare("PRAGMA synchronous").get() as { synchronous: number }).synchronous).toBe(2);
});

test("acceptCommand returns the committed row; listPending keeps FIFO order", () => {
  const a = accept("s1", "one");
  const b = accept("s1", "two", { seq: 7, source: "relay", visible: false });
  expect(a.deduped).toBe("none");
  expect(a.row?.state).toBe("queued");
  expect(b.row?.origin).toBe("relay");
  expect(ledger.listPending("s1").map((c) => c.text)).toEqual(["one", "two"]);
  expect(ledger.getCommand(a.id)?.mirrorToRelay).toBe(true);
});

test("a re-pulled relay seq dedupes against the pending row (same id, no second row)", () => {
  const first = accept("s1", "hello", { seq: 3, source: "relay" });
  const again = accept("s1", "hello", { seq: 3, source: "relay" });
  expect(again).toMatchObject({ id: first.id, deduped: "pending" });
  expect(ledger.listPending("s1")).toHaveLength(1);
});

test("a seq delivered and then pruned still dedupes through the retained receipt (#516)", () => {
  const gen = ledger.openGeneration("s1", "claude");
  const c = accept("s1", "hello", { seq: 3, source: "relay" });
  const att = ledger.recordAttempt(c.id, gen, "hello");
  ledger.confirmDelivery(c.id, [{ kind: "transcript_uuid", ref: "u1" }, { kind: "seq", ref: "3" }], { attemptId: att.id });
  expect(ledger.getCommand(c.id)).toMatchObject({ state: "completed", terminalReason: "delivered" });
  expect(ledger.getAttempt(att.id)?.state).toBe("done");
  // Still deduped while the terminal row exists...
  expect(accept("s1", "hello", { seq: 3, source: "relay" })).toMatchObject({ id: c.id, deduped: "receipt" });
  // ...and after retention removes the command row, the receipt answers.
  now += 8 * 24 * 3_600_000;
  ledger.prune({ terminalOlderThanMs: 7 * 24 * 3_600_000, observationsOlderThanMs: 30 * 24 * 3_600_000 });
  expect(ledger.getCommand(c.id)).toBeNull();
  expect(ledger.hasReceipt("s1", "seq", "3")).toBe(false); // receipts follow the same 7-day retention...
  // ...so re-add one to show the receipt path alone dedupes.
  ledger.addReceipt("s1", { kind: "seq", ref: "3", commandId: c.id });
  const r = accept("s1", "hello", { seq: 3, source: "relay" });
  expect(r.deduped).toBe("receipt");
  expect(r.id).toBe(c.id);
  expect(ledger.listPending("s1")).toHaveLength(0);
});

test("a closed generation refuses new commands (#553); a fresh one accepts again", () => {
  const g = ledger.openGeneration("s1", "codex");
  accept("s1", "ok");
  ledger.closeGeneration("s1", g, "killed");
  expect(() => accept("s1", "late")).toThrow(SessionEndedError);
  expect(ledger.getCommand(ledger.listCommands("s1")[0].id)?.state).toBe("interrupted"); // killed: nothing will deliver it
  ledger.openGeneration("s1", "codex");
  expect(accept("s1", "again").deduped).toBe("none");
});

test("restart keeps queued rows and turns in-flight ones into an explicit unknown", () => {
  const g = ledger.openGeneration("s1", "claude");
  const a = accept("s1", "typed");
  const b = accept("s1", "waiting");
  const att = ledger.recordAttempt(a.id, g, "typed");
  ledger.closeGeneration("s1", g, "restart");
  expect(ledger.getCommand(a.id)?.state).toBe("unknown");
  expect(ledger.getAttempt(att.id)?.state).toBe("unknown");
  expect(ledger.getCommand(b.id)?.state).toBe("queued");
  const g2 = ledger.openGeneration("s1", "claude");
  expect(g2).toBe(g + 1);
  expect(ledger.requeueCommand(a.id)).toBe(true);
  expect(ledger.listPending("s1").map((c) => c.id)).toEqual([a.id, b.id]);
  // The unknown attempt is still matchable: a late echo dedupes instead of mirroring.
  expect(ledger.matchAttemptByRef("s1", "typed")?.id).toBe(att.id);
});

test("generation fence: an attempt for a superseded generation is refused and the row untouched (#481)", () => {
  const g1 = ledger.openGeneration("s1", "claude");
  const c = accept("s1", "x");
  ledger.openGeneration("s1", "claude");
  expect(() => ledger.recordAttempt(c.id, g1, "x")).toThrow(StaleGenerationError);
  expect(ledger.getCommand(c.id)?.state).toBe("queued");
  expect(ledger.attemptsForCommand(c.id)).toEqual([]);
  expect(() => ledger.recordObservation({ sessionId: "s1", generation: g1, kind: "echo" })).toThrow(StaleGenerationError);
});

test("recordAttempt refuses a cancel-requested command and cancels it instead (#77/#35)", () => {
  const g = ledger.openGeneration("s1", "claude");
  const c = accept("s1", "x");
  const a = ledger.recordAttempt(c.id, g, "x");
  ledger.settleAttempt(a.id, "unknown");
  expect(ledger.requestCancel(c.id)?.cancelRequestedAt).toBe(now);
  expect(ledger.getCommand(c.id)?.state).toBe("unknown"); // in flight: flag only
  ledger.requeueCommand(c.id);
  expect(() => ledger.recordAttempt(c.id, g, "x")).toThrow(StaleCommandError);
  expect(ledger.getCommand(c.id)).toMatchObject({ state: "cancelled", terminalReason: "cancelled" });
});

test("requestCancel on a queued row cancels it at once; edit/reorder only touch queued rows", () => {
  const g = ledger.openGeneration("s1", "claude");
  const a = accept("s1", "a"), b = accept("s1", "b"), c = accept("s1", "c");
  expect(ledger.reorderCommand(c.id, 0)).toBe(true);
  expect(ledger.listPending("s1").map((x) => x.text)).toEqual(["c", "a", "b"]);
  expect(ledger.editCommand(b.id, "B")).toBe(true);
  expect(ledger.getCommand(b.id)).toMatchObject({ text: "B", payloadVersion: 2 });
  ledger.recordAttempt(c.id, g, "c");
  expect(ledger.editCommand(c.id, "C")).toBe(false);
  expect(ledger.reorderCommand(c.id, 2)).toBe(false);
  expect(ledger.requestCancel(a.id)?.state).toBe("cancelled");
  expect(ledger.listPending("s1").map((x) => x.text)).toEqual(["c", "B"]);
  // reorder around a non-queued (submitting) head keeps it at the head
  const d = accept("s1", "d");
  expect(ledger.reorderCommand(d.id, 0)).toBe(true);
  expect(ledger.listPending("s1").map((x) => x.text)).toEqual(["c", "d", "B"]);
});

test("transition is a CAS; a terminal transition clears active_op and settles awaiting attempts", () => {
  const g = ledger.openGeneration("s1", "codex");
  const c = accept("s1", "x");
  const a = ledger.recordAttempt(c.id, g, "client-1", "op-1");
  expect(ledger.getCommand(c.id)).toMatchObject({ state: "submitting", activeOp: "op-1" });
  expect(ledger.transition(c.id, ["queued"], "accepted")).toBe(false);
  expect(ledger.transition(c.id, ["submitting"], "failed", { terminalReason: "boom" })).toBe(true);
  expect(ledger.getCommand(c.id)).toMatchObject({ state: "failed", activeOp: null, terminalReason: "boom" });
  expect(ledger.getAttempt(a.id)?.state).toBe("superseded");
});

test("identical texts pair with attempts in submission order (#437)", () => {
  const g = ledger.openGeneration("s1", "claude");
  const a = accept("s1", "yes"), b = accept("s1", "yes");
  const a1 = ledger.recordAttempt(a.id, g, "yes");
  now += 1;
  const b1 = ledger.recordAttempt(b.id, g, "yes");
  expect(ledger.matchAttemptByRef("s1", "yes")?.id).toBe(a1.id);
  ledger.confirmDelivery(a.id, { kind: "transcript_uuid", ref: "u1" }, { attemptId: a1.id });
  expect(ledger.matchAttemptByRef("s1", "yes")?.id).toBe(b1.id);
  ledger.confirmDelivery(b.id, { kind: "transcript_uuid", ref: "u2" }, { attemptId: b1.id });
  expect(ledger.matchAttemptByRef("s1", "yes")).toBeNull();
  expect(ledger.ownsRuntimeRef("s1", "yes", "transcript_uuid")).toBe(true);
  expect(ledger.ownsRuntimeRef("s1", "no", "transcript_uuid")).toBe(false);
});

test("outbox: persisted order per session, idempotent on runtime_event_id, bind stamps unbound rows", () => {
  const seqs = ledger.enqueueOutbound([
    { sessionId: "loc1", kind: "output", runtimeEventId: "rec:1", sealed: false, body: { a: 1 } },
    { sessionId: "loc2", kind: "output", runtimeEventId: "rec:2", sealed: false, body: { a: 2 } },
    { sessionId: "loc1", kind: "terminal", runtimeEventId: "term:1", relayTurnId: "t1", sealed: false, body: { terminalState: "completed" } },
  ]);
  expect(seqs).toEqual([1, 2, 3]);
  expect(ledger.enqueueOutbound([{ sessionId: "loc1", kind: "output", runtimeEventId: "rec:1", sealed: false, body: {} }])).toEqual([1]);
  expect(ledger.sessionsWithOutbound()).toEqual(["loc1", "loc2"]);
  expect(ledger.hasTerminalFor("t1")).toBe(true);
  expect(ledger.bindOutbound("loc1", "v2x", { sealed: true, keyB64: "a2V5" })).toBe(2);
  expect(ledger.nextOutbound("loc1")).toMatchObject({ seq: 1, v2SessionId: "v2x", sealed: true, keyB64: "a2V5", body: { a: 1 } });
  expect(ledger.nextOutbound("loc2")?.v2SessionId).toBeNull();
  ledger.failOutbound(1, "503", now + 5_000);
  expect(ledger.nextOutbound("loc1")).toMatchObject({ seq: 1, attempts: 1, lastError: "503", nextRetryAt: now + 5_000 });
  ledger.ackOutbound(1);
  expect(ledger.nextOutbound("loc1")?.seq).toBe(3);
  ledger.dropOutbound(3, "409 turn_terminal");
  expect(ledger.nextOutbound("loc1")).toBeNull();
  expect(ledger.hasTerminalFor("t1")).toBe(false);
  expect(ledger.getOutbound(3)?.lastError).toMatch(/^dropped: 409/);
});

test("outbox backpressure reports a session over the row cap", () => {
  const rows = Array.from({ length: OUTBOX_MAX_ROWS + 1 }, (_, i) => ({ sessionId: "loc1", kind: "output" as const, runtimeEventId: `r:${i}`, sealed: false, body: { i } }));
  ledger.enqueueOutbound(rows);
  expect(ledger.outboundPressure("loc1")).toMatchObject({ rows: OUTBOX_MAX_ROWS + 1, over: true });
  expect(ledger.sessionsOverPressure()).toEqual(["loc1"]);
  ledger.ackOutbound(1);
  expect(ledger.outboundPressure("loc1").over).toBe(false);
});

test("a checkpoint stays pending until its outputs are acked; a crash before that replays from the old cursor (#67)", () => {
  ledger.setCheckpoint("s1", "claude_transcript", "/t.jsonl", 100);
  ledger.enqueueOutbound([{ sessionId: "s1", kind: "output", runtimeEventId: "r1", sealed: false, body: {} }]);
  expect(ledger.setCheckpoint("s1", "claude_transcript", "/t.jsonl", 200, { throughSeq: "latest" })).toEqual({ committed: false });
  expect(ledger.getCheckpoint("s1", "claude_transcript")).toMatchObject({ offset: 100, pendingOffset: 200, pendingThroughSeq: 1 });
  // A newer pending overwrites the older pending (monotone), still held.
  ledger.enqueueOutbound([{ sessionId: "s1", kind: "output", runtimeEventId: "r2", sealed: false, body: {} }]);
  ledger.setCheckpoint("s1", "claude_transcript", "/t.jsonl", 300, { throughSeq: "latest" });
  expect(ledger.getCheckpoint("s1", "claude_transcript")).toMatchObject({ offset: 100, pendingOffset: 300, pendingThroughSeq: 2 });
  ledger.ackOutbound(1);
  expect(ledger.getCheckpoint("s1", "claude_transcript")?.offset).toBe(100); // seq 2 still unacked
  ledger.ackOutbound(2);
  expect(ledger.getCheckpoint("s1", "claude_transcript")).toMatchObject({ offset: 300, pendingRef: null, pendingThroughSeq: null });
  // Nothing outstanding: a checkpoint commits directly.
  expect(ledger.setCheckpoint("s1", "claude_transcript", "/t.jsonl", 400, { throughSeq: "latest" })).toEqual({ committed: true });
  // Another session's rows never hold this one's checkpoint.
  ledger.enqueueOutbound([{ sessionId: "s2", kind: "output", runtimeEventId: "r3", sealed: false, body: {} }]);
  expect(ledger.setCheckpoint("s1", "claude_transcript", "/t.jsonl", 500, { throughSeq: "latest" })).toEqual({ committed: true });
});

test("recordObservation commits the echo, its receipts, the command transition and the checkpoint together", () => {
  const g = ledger.openGeneration("s1", "codex");
  const c = accept("s1", "x", { seq: 9, source: "relay" });
  const a = ledger.recordAttempt(c.id, g, "client-1");
  ledger.settleAttempt(a.id, "accepted", { runtimeTurnId: "turn-1" });
  const r = ledger.recordObservation({ sessionId: "s1", generation: g, attemptId: a.id, kind: "echo", ref: "client-1" }, {
    receipts: [{ kind: "codex_client", ref: "client-1", commandId: c.id, attemptId: a.id }, { kind: "seq", ref: "9", commandId: c.id, attemptId: a.id }],
    attempt: { id: a.id, outcome: "done" },
    command: { id: c.id, to: "completed", terminalReason: "delivered" },
    outbox: [{ sessionId: "s1", kind: "output", runtimeEventId: "rec:9", sealed: false, body: { ev: "user" } }],
    checkpoint: { kind: "codex_turn", ref: "turn-1", offset: 0 },
  });
  expect(r.outboxSeqs).toEqual([1]);
  expect(ledger.getCommand(c.id)?.state).toBe("completed");
  expect(ledger.getAttempt(a.id)).toMatchObject({ state: "done", runtimeTurnId: "turn-1" });
  expect(ledger.getReceipt("s1", "seq", "9")?.attemptId).toBe(a.id);
  expect(ledger.getCheckpoint("s1", "codex_turn")).toMatchObject({ ref: "turn-1", pendingRef: "turn-1", pendingThroughSeq: 1, offset: 0 });
  ledger.ackOutbound(1);
  expect(ledger.getCheckpoint("s1", "codex_turn")?.pendingRef).toBeNull();
  expect(ledger.listObservations("s1", "echo")).toHaveLength(1);
});

test("spawn intents, jobs and receipts round-trip; prune removes only settled rows", () => {
  ledger.spawnIntent("cmd-1", "loc1");
  ledger.spawnIntent("cmd-1", "loc2"); // a retry that chose a different local id wins
  expect(ledger.lookupSpawnIntent("cmd-1")).toBe("loc2");
  ledger.bindSpawnIntent("cmd-1");
  expect(ledger.listSpawnIntents()[0].boundAt).toBe(now);
  ledger.putJob({ id: "s1", sessionId: "s1", kind: "handoff", payload: { role: "source", path: "/n.md" } });
  expect(ledger.getJob("s1")?.payload).toEqual({ role: "source", path: "/n.md" });
  expect(ledger.listJobs("handoff").map((j) => j.id)).toEqual(["s1"]);
  expect(ledger.deleteJob("s1")).toBe(true);
  expect(ledger.getJob("s1")).toBeNull();

  const g = ledger.openGeneration("s1", "claude");
  const live = accept("s1", "still queued");
  const done = accept("s1", "done");
  ledger.recordAttempt(done.id, g, "done");
  ledger.confirmDelivery(done.id, { kind: "transcript_uuid", ref: "u-done" });
  ledger.enqueueOutbound([{ sessionId: "s1", kind: "output", runtimeEventId: "r-live", sealed: false, body: {} }, { sessionId: "s1", kind: "output", runtimeEventId: "r-acked", sealed: false, body: {} }]);
  ledger.ackOutbound(2);
  now += 8 * 24 * 3_600_000;
  const pruned = ledger.prune();
  expect(pruned).toMatchObject({ commands: 1, outbox: 1, receipts: 1 });
  expect(ledger.getCommand(live.id)?.state).toBe("queued");
  expect(ledger.getCommand(done.id)).toBeNull();
  expect(ledger.attemptsForCommand(done.id)).toEqual([]); // cascaded
  expect(ledger.nextOutbound("s1")?.runtimeEventId).toBe("r-live");
});

test("ledgerFor caches one handle per state dir and reopens after close", () => {
  const a = ledgerFor(dir);
  expect(ledgerFor(dir)).toBe(a);
  a.close();
  const b = ledgerFor(dir);
  expect(b).not.toBe(a);
  expect(b.closed).toBe(false);
  expect(a.closed).toBe(true);
});

test("tx: a throw inside rolls back everything and surfaces as LedgerWriteError", () => {
  expect(() => ledger.tx(() => {
    accept("s1", "inside");
    throw new Error("boom");
  })).toThrow(LedgerWriteError);
  expect(ledger.listPending("s1")).toEqual([]);
});
