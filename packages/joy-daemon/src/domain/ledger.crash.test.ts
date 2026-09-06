// Crash-recovery invariants (design §1.6). Each test drives a real
// ledger.sqlite in a temp dir, "crashes" by dropping the Ledger object
// without close() and re-opening, and injects write failures through the
// underlying node:sqlite handle.
import { test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Ledger, LedgerWriteError, StaleGenerationError } from "./ledger";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "ledger-crash-")); });
afterEach(() => { vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });

const reopen = () => Ledger.open(dir);
const accept = (l: Ledger, sessionId: string, text: string, seq?: number) =>
  l.acceptCommand({ sessionId, text, source: seq != null ? "relay" : "rpc", seq, visible: false, mirrorToRelay: false });

// accept → dispatch
test("a command the caller was told ok about is there after a crash; a failed commit leaves no row", () => {
  const l1 = Ledger.open(dir);
  l1.openGeneration("s1", "claude");
  const ok = accept(l1, "s1", "durable", 1);
  // Inject: the COMMIT of the next accept fails.
  const exec = DatabaseSync.prototype.exec;
  vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (this: DatabaseSync, sql: string) {
    if (sql === "COMMIT") throw new Error("SQLITE_FULL: database or disk is full");
    return exec.call(this, sql);
  });
  expect(() => accept(l1, "s1", "lost", 2)).toThrow(LedgerWriteError);
  vi.restoreAllMocks();
  // crash: no close()
  const l2 = reopen();
  expect(l2.listPending("s1").map((c) => c.id)).toEqual([ok.id]);
  expect(l2.commandForSeq("s1", 2)).toBeNull();
  l2.close();
});

// dispatch → echo
test("an attempt that was submitting at the crash is unknown after reopen; the command is not re-listed as queued", () => {
  const l1 = Ledger.open(dir);
  const g = l1.openGeneration("s1", "codex");
  const c = accept(l1, "s1", "hello", 5);
  const a = l1.recordAttempt(c.id, g, "client-1");
  const l2 = reopen(); // crash
  // The next daemon opens its generation: the stale one closes as superseded.
  const g2 = l2.openGeneration("s1", "codex");
  expect(g2).toBe(g + 1);
  expect(l2.attemptsAwaiting("s1", ["submitting", "unknown"]).map((x) => ({ id: x.id, state: x.state }))).toEqual([{ id: a.id, state: "unknown" }]);
  expect(l2.listPending("s1", ["queued"])).toEqual([]);
  expect(l2.getCommand(c.id)?.state).toBe("unknown");
  // Only an explicit reconcile decision puts it back on the queue.
  expect(() => l2.recordAttempt(c.id, g2, "client-2")).toThrow();
  l2.requeueCommand(c.id);
  const a2 = l2.recordAttempt(c.id, g2, "client-2");
  expect(a2.attemptNo).toBe(2);
  l2.close();
});

// echo → checkpoint
test("receipt + command transition + checkpoint are one commit: all or none", () => {
  const l1 = Ledger.open(dir);
  const g = l1.openGeneration("s1", "codex");
  const c = accept(l1, "s1", "hello", 5);
  const a = l1.recordAttempt(c.id, g, "client-1");
  l1.settleAttempt(a.id, "accepted");
  // Fail on the checkpoint statement — the last write of the observation.
  const prepare = DatabaseSync.prototype.prepare;
  vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (this: DatabaseSync, sql: string) {
    if (/INSERT OR REPLACE INTO checkpoints/.test(sql)) throw new Error("EIO");
    return prepare.call(this, sql);
  });
  expect(() => l1.recordObservation({ sessionId: "s1", generation: g, attemptId: a.id, kind: "echo", ref: "client-1" }, {
    receipts: [{ kind: "codex_client", ref: "client-1", commandId: c.id, attemptId: a.id }, { kind: "seq", ref: "5", commandId: c.id }],
    attempt: { id: a.id, outcome: "done" },
    command: { id: c.id, to: "completed", terminalReason: "delivered" },
    checkpoint: { kind: "codex_turn", ref: "turn-1", offset: 0 },
  })).toThrow(LedgerWriteError);
  vi.restoreAllMocks();
  let l2 = reopen();
  expect(l2.hasReceipt("s1", "codex_client", "client-1")).toBe(false);
  expect(l2.getCommand(c.id)?.state).toBe("accepted");
  expect(l2.getAttempt(a.id)?.state).toBe("accepted");
  expect(l2.getCheckpoint("s1", "codex_turn")).toBeNull();
  // Without the fault: everything lands, and a redelivered seq is a receipt hit (#516).
  l2.openGeneration("s1", "codex");
  const g2 = l2.currentGeneration("s1")!.generation;
  l2.recordObservation({ sessionId: "s1", generation: g2, attemptId: a.id, kind: "echo", ref: "client-1" }, {
    receipts: [{ kind: "codex_client", ref: "client-1", commandId: c.id, attemptId: a.id }, { kind: "seq", ref: "5", commandId: c.id }],
    attempt: { id: a.id, outcome: "done" },
    command: { id: c.id, to: "completed", terminalReason: "delivered" },
    checkpoint: { kind: "codex_turn", ref: "turn-1", offset: 0 },
  });
  l2 = reopen();
  expect(l2.hasReceipt("s1", "codex_client", "client-1")).toBe(true);
  expect(l2.getCommand(c.id)?.state).toBe("completed");
  expect(l2.getCheckpoint("s1", "codex_turn")?.ref).toBe("turn-1");
  expect(accept(l2, "s1", "hello", 5).deduped).toBe("receipt");
  l2.close();
});

// terminal → ack
test("a terminal outcome is on disk the moment it is known; a reopen still has it to send", () => {
  const l1 = Ledger.open(dir);
  const g = l1.openGeneration("s1", "claude");
  l1.enqueueOutbound([{ sessionId: "s1", kind: "output", runtimeEventId: "rec:1", relayTurnId: "t1", v2SessionId: "v2", sealed: false, body: { ev: "text" } }]);
  l1.recordObservation({ sessionId: "s1", generation: g, kind: "turn_ended", ref: "t1" }, {
    outbox: [{ sessionId: "s1", kind: "terminal", runtimeEventId: "term:t1", relayTurnId: "t1", v2SessionId: "v2", sealed: false, body: { type: "terminal", terminalState: "failed" } }],
  });
  const l2 = reopen(); // crash before any POST
  expect(l2.sessionsWithOutbound()).toEqual(["s1"]);
  expect(l2.nextOutbound("s1")).toMatchObject({ kind: "output", runtimeEventId: "rec:1" }); // outputs first
  expect(l2.hasTerminalFor("t1")).toBe(true);
  l2.ackOutbound(1);
  expect(l2.nextOutbound("s1")).toMatchObject({ kind: "terminal", body: { terminalState: "failed" } });
  // A permanent refusal drops it; the line is empty and the turn no longer has a pending terminal.
  l2.dropOutbound(2, "409 turn_terminal");
  expect(l2.nextOutbound("s1")).toBeNull();
  expect(l2.hasTerminalFor("t1")).toBe(false);
  l2.close();
});

// generation fence
test("a write naming generation N after N+1 opened is refused and the row untouched (#481)", () => {
  const l1 = Ledger.open(dir);
  const g1 = l1.openGeneration("s1", "claude");
  const c = accept(l1, "s1", "carried");
  const l2 = reopen(); // crash; the next daemon takes over the id
  const g2 = l2.openGeneration("s1", "claude");
  expect(g2).toBe(g1 + 1);
  // The old generation's late callback (l1 is still alive in the old process's memory).
  expect(() => l1.recordAttempt(c.id, g1, "carried")).toThrow(StaleGenerationError);
  expect(l2.getCommand(c.id)?.state).toBe("queued");
  expect(l2.attemptsForCommand(c.id)).toEqual([]);
  expect(l2.recordAttempt(c.id, g2, "carried").generation).toBe(g2);
  l1.close(); l2.close();
});

test("a checkpoint held by unacked outputs is not advanced across a crash; the ack after reopen promotes it", () => {
  const l1 = Ledger.open(dir);
  l1.setCheckpoint("s1", "claude_transcript", "/t.jsonl", 10);
  l1.enqueueOutbound([{ sessionId: "s1", kind: "output", runtimeEventId: "r1", sealed: false, body: {} }]);
  l1.setCheckpoint("s1", "claude_transcript", "/t.jsonl", 20, { throughSeq: "latest" });
  const l2 = reopen();
  expect(l2.getCheckpoint("s1", "claude_transcript")).toMatchObject({ offset: 10, pendingOffset: 20 }); // replay from 10
  l2.ackOutbound(1);
  expect(l2.getCheckpoint("s1", "claude_transcript")).toMatchObject({ offset: 20, pendingOffset: null });
  l2.close();
});
