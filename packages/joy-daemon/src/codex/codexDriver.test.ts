// CodexDriver: the app-server's answers mapped onto the coordinator's
// vocabulary. Submit: accepted with the turn id; an explicit JSON-RPC
// refusal is a transient rejection (busy ones flagged); anything else is
// `unknown` (it MIGHT have landed). Interrupt names the turn or is a noop.
// Reconcile reads thread/read: present → accepted/running, absent → absent
// on a fresh spawn, unknown on a rejoin (held, at most once).
import { test, expect } from "vitest";
import { CodexDriver, codexTurnStatus, type CodexRuntimePort, type CodexTurnClient } from "./codexDriver";
import { JsonRpcResponseError } from "./appServerClient";
import type { AttemptRef, CommandView } from "../domain/coordinator";

const cmd: CommandView = { id: "c1", sessionId: "s1", text: "hi", origin: "local", source: "rpc", seq: null, relayTurnId: null, relayCommandId: null, visible: true, mirrorToRelay: true, payloadVersion: 1, createdAt: 0 };
const ref = (over: Partial<AttemptRef> = {}): AttemptRef => ({ attemptId: "a1", commandId: "c1", attemptNo: 1, runtimeRef: "c1", token: "t", runtimeTurnId: null, ...over });

function port(client: Partial<CodexTurnClient> | null, over: Partial<CodexRuntimePort> = {}): CodexRuntimePort & { effortCleared: number } {
  const p = {
    sessionId: "s1", effortCleared: 0,
    threadId: () => "TH",
    client: () => client as CodexTurnClient | null,
    permissionMode: () => "default",
    pendingEffort: () => "high",
    effortApplied() { p.effortCleared++; },
    activeTurnId: () => null,
    rejoined: () => false,
    handleCommand: () => null,
    mirrorAccepted: () => {},
    log: () => {},
    ...over,
  };
  return p;
}

test("submit: turn/start ok → accepted with the turn id; the pending effort is applied once", async () => {
  const calls: unknown[] = [];
  const p = port({ turnStart: async (...a) => { calls.push(a); return { turnId: "T1" }; } });
  const d = new CodexDriver(p, 1);
  expect(await d.submit(cmd, ref(), new AbortController().signal)).toEqual({ kind: "accepted", runtimeTurnId: "T1" });
  expect(calls[0]).toEqual(["TH", "hi", { clientUserMessageId: "c1", permissionMode: "default", effort: "high" }]);
  expect(p.effortCleared).toBe(1);
});

test("submit: a JSON-RPC refusal is a transient rejection; a busy one is flagged; a transport error is unknown", async () => {
  const d1 = new CodexDriver(port({ turnStart: async () => { throw new JsonRpcResponseError(-32602, "invalid argument"); } }), 1);
  expect(await d1.submit(cmd, ref(), new AbortController().signal)).toEqual({ kind: "rejected", permanent: false, busy: false, detail: "-32602: invalid argument" });
  const d2 = new CodexDriver(port({ turnStart: async () => { throw new JsonRpcResponseError(-1, "turn already active"); } }), 1);
  expect(await d2.submit(cmd, ref(), new AbortController().signal)).toMatchObject({ kind: "rejected", busy: true });
  const d3 = new CodexDriver(port({ turnStart: async () => { throw new Error("request timed out"); } }), 1);
  expect(await d3.submit(cmd, ref(), new AbortController().signal)).toMatchObject({ kind: "unknown" });
  const d4 = new CodexDriver(port(null), 1);
  expect(await d4.submit(cmd, ref(), new AbortController().signal)).toMatchObject({ kind: "rejected", busy: true });
});

test("interrupt: names the attempt's turn, falls back to the active turn for a session-wide abort, noop without one", async () => {
  const interrupted: string[] = [];
  const client = { turnInterrupt: async (_t: string, turn: string) => { interrupted.push(turn); } };
  const d = new CodexDriver(port(client, { activeTurnId: () => "T-live" }), 1);
  expect(await d.interrupt({ attempt: ref({ runtimeTurnId: "T9" }) })).toEqual({ kind: "sent" });
  expect(await d.interrupt({ attempt: null })).toEqual({ kind: "sent" });
  expect(interrupted).toEqual(["T9", "T-live"]);
  const quiet = new CodexDriver(port(client, { activeTurnId: () => null }), 1);
  expect(await quiet.interrupt({ attempt: ref() })).toEqual({ kind: "noop" });
  const broken = new CodexDriver(port({ turnInterrupt: async () => { throw new Error("socket closed"); } }), 1);
  expect(await broken.interrupt({ attempt: ref({ runtimeTurnId: "T9" }) })).toMatchObject({ kind: "failed" });
});

test("reconcile: a clientId in history is accepted (running when in progress on a rejoined server); one missing is absent on a fresh spawn, unknown on a rejoin", async () => {
  const thread = { thread: { turns: [
    { id: "T1", status: "completed", items: [{ type: "userMessage", clientId: "c1" }] },
    { id: "T2", status: "inProgress", items: [{ type: "userMessage", clientUserMessageId: "c2#a2" }] },
  ] } };
  const client = { threadRead: async () => thread };
  const pending = [ref(), ref({ attemptId: "a2", commandId: "c2", runtimeRef: "c2#a2" }), ref({ attemptId: "a3", commandId: "c3", runtimeRef: "c3" })];
  const fresh = new CodexDriver(port(client, { rejoined: () => false }), 1);
  expect(await fresh.reconcile(pending)).toEqual([
    { attemptId: "a1", outcome: "accepted", runtimeTurnId: "T1" },
    { attemptId: "a2", outcome: "accepted", runtimeTurnId: "T2" },
    { attemptId: "a3", outcome: "absent" },
  ]);
  const rejoined = new CodexDriver(port(client, { rejoined: () => true }), 1);
  expect(await rejoined.reconcile(pending)).toEqual([
    { attemptId: "a1", outcome: "accepted", runtimeTurnId: "T1" },
    { attemptId: "a2", outcome: "running", runtimeTurnId: "T2" },
    { attemptId: "a3", outcome: "unknown" },
  ]);
  const down = new CodexDriver(port(null), 1);
  expect(await down.reconcile(pending)).toEqual(pending.map((p) => ({ attemptId: p.attemptId, outcome: "unknown" })));
});

test("codexTurnStatus maps interrupted/cancelled → cancelled, failed → failed, anything else → completed", () => {
  expect(codexTurnStatus("interrupted")).toBe("cancelled");
  expect(codexTurnStatus("cancelled")).toBe("cancelled");
  expect(codexTurnStatus("failed")).toBe("failed");
  expect(codexTurnStatus("completed")).toBe("completed");
  expect(codexTurnStatus("")).toBe("completed");
});
