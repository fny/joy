import { test, expect } from "vitest";
import { CodexNormalizer, type CodexEffect, type CodexNotification } from "./normalize";

// gpt-5.6-sol M2 finding #5, the decisive live finding: per-ITEM ids DIFFER
// between live notifications (agentMessage=msg_…, command=call_…) and thread/read
// history (positional item-N). Keying wire dedup on the transient id therefore
// DOUBLE-SHOWS items across a restart. The fix is a canonical (turn, type,
// ordinal) identity. This test proves the LIVE stream and the HISTORY replay of
// the SAME logical turn produce IDENTICAL wire localIds (so the append layer
// dedupes them) even though every transient id differs.

function localIds(notifs: CodexNotification[]): string[] {
  const n = new CodexNormalizer(() => "should-not-be-used");
  n.setThreadId("TH");
  const out: string[] = [];
  for (const notif of notifs) {
    for (const e of n.handle(notif) as CodexEffect[]) if (e.kind === "wire") out.push(e.localId);
  }
  return out;
}

const TURN = "019f9261-aaaa-7062-91be-000000000001";

// LIVE: transient ids are the codex runtime ids (msg_/call_), and each item
// arrives as started + completed notifications.
const LIVE: CodexNotification[] = [
  { method: "turn/started", params: { threadId: "TH", turn: { id: TURN } } },
  { method: "item/started", params: { threadId: "TH", turnId: TURN, item: { type: "userMessage", id: "msg_u", clientId: "joy-1" } } },
  { method: "item/started", params: { threadId: "TH", turnId: TURN, item: { type: "commandExecution", id: "call_9f", command: "ls", cwd: "/" } } },
  { method: "item/completed", params: { threadId: "TH", turnId: TURN, item: { type: "commandExecution", id: "call_9f", status: "completed" } } },
  { method: "item/completed", params: { threadId: "TH", turnId: TURN, item: { type: "agentMessage", id: "msg_ab", text: "done" } } },
  { method: "turn/completed", params: { threadId: "TH", turn: { id: TURN, status: "completed" } } },
];

// HISTORY (thread/read replay): SAME logical items, but positional ids (item-N),
// fed started+completed for every item — exactly how CodexSession#reconcileHistory
// drives the normalizer.
const HISTORY: CodexNotification[] = [
  { method: "turn/started", params: { turn: { id: TURN } } },
  { method: "item/started", params: { turnId: TURN, item: { type: "userMessage", id: "item-0", clientId: "joy-1" } } },
  { method: "item/completed", params: { turnId: TURN, item: { type: "userMessage", id: "item-0", clientId: "joy-1" } } },
  { method: "item/started", params: { turnId: TURN, item: { type: "commandExecution", id: "item-1", command: "ls", cwd: "/" } } },
  { method: "item/completed", params: { turnId: TURN, item: { type: "commandExecution", id: "item-1", status: "completed" } } },
  { method: "item/started", params: { turnId: TURN, item: { type: "agentMessage", id: "item-2", text: "done" } } },
  { method: "item/completed", params: { turnId: TURN, item: { type: "agentMessage", id: "item-2", text: "done" } } },
  { method: "turn/completed", params: { turn: { id: TURN, status: "completed" } } },
];

test("live and history replay produce IDENTICAL wire localIds despite differing item ids", () => {
  const live = localIds(LIVE);
  const history = localIds(HISTORY);
  // Every localId the live stream emits is reproduced by the history replay, so
  // the relay append layer dedupes a reconnect replay to a no-op.
  for (const id of live) expect(history).toContain(id);
  // And the concrete canonical identities we expect:
  expect(live).toContain(`codex:TH:turn:${TURN}:start`);
  expect(live).toContain(`codex:TH:turn:${TURN}:item:commandExecution:0:tool-start`);
  expect(live).toContain(`codex:TH:turn:${TURN}:item:commandExecution:0:tool-end`);
  expect(live).toContain(`codex:TH:turn:${TURN}:item:agentMessage:0:text`);
  expect(live).toContain(`codex:TH:turn:${TURN}:complete`);
});

test("history replay confirms the user-message dispatch (drains the inbound spool)", () => {
  const n = new CodexNormalizer(() => "x");
  n.setThreadId("TH");
  const confirms: string[] = [];
  for (const notif of HISTORY) {
    for (const e of n.handle(notif)) if (e.kind === "confirmDispatch") confirms.push(e.clientId);
  }
  // finding #3a: feeding item/started(userMessage) during replay MUST emit a
  // confirmDispatch so the spooled inbound entry is removed (not resent).
  expect(confirms).toContain("joy-1");
});
