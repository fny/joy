import { test, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { CodexNormalizer, type CodexEffect, type CodexNotification } from "./normalize";

// Deterministic turn-id minting so the wire `turn` field is assertable.
function normalizer() {
  let n = 0;
  return new CodexNormalizer(() => `turn-${++n}`);
}

// Reduce a notification stream to its effects, in order.
function run(notifs: CodexNotification[]): CodexEffect[] {
  const norm = normalizer();
  return notifs.flatMap((n) => norm.handle(n));
}

// Pull the wire variant payload (ev) out of a session-envelope wire record,
// so tests assert the logical event shape, not the random id/time.
function ev(e: CodexEffect): Record<string, unknown> | null {
  if (e.kind !== "wire") return null;
  const data = (e.record.content as any).data;
  return data?.ev ?? null;
}

// ── The real 0.144.6 capture (a turn that runs one shell command) ────────────
const CAPTURE: CodexNotification[] = JSON.parse(
  readFileSync(join(__dirname, "__fixtures__", "turn-command.capture.json"), "utf8"),
);

test("live capture → the exact claude-shaped wire sequence for a command turn", () => {
  const effects = run(CAPTURE);
  const wire = effects.filter((e) => e.kind === "wire").map((e) => ev(e));

  // turn-start → tool-call-start(CodexBash) → tool-call-end → text → turn-end
  expect(wire).toEqual([
    { t: "turn-start" },
    { t: "tool-call-start", call: expect.any(String), name: "CodexBash", title: "CodexBash", description: "", args: { command: "/bin/bash -lc 'echo hello-from-codex'", cwd: expect.any(String) } },
    { t: "tool-call-end", call: expect.any(String), result: expect.any(String) }, // the command output rides along (#68)
    { t: "text", text: "done" },
    { t: "turn-end", status: "completed" },
  ]);
});

test("all wire records in a turn share the codex turn id (used directly)", () => {
  const effects = run(CAPTURE);
  const turns = new Set(
    effects.filter((e) => e.kind === "wire").map((e) => ((e as any).record.content.data.turn)),
  );
  expect(turns.size).toBe(1);
  expect([...turns][0]).toBe("019f9261-f759-7062-91be-b1956956959a");
});

test("userMessage echo → confirmDispatch by clientId (no wire record)", () => {
  const effects = run(CAPTURE);
  const confirms = effects.filter((e) => e.kind === "confirmDispatch");
  expect(confirms).toEqual([{ kind: "confirmDispatch", clientId: "joy-local-1", turn: expect.any(String) }]);
});

test("thinking toggles on active status and off at turn end", () => {
  const effects = run(CAPTURE);
  const thinking = effects.filter((e) => e.kind === "thinking").map((e) => (e as any).value);
  // active → true (start), then idle + turn-end → false, false
  expect(thinking[0]).toBe(true);
  expect(thinking[thinking.length - 1]).toBe(false);
});

test("agentMessage completion stamps a receipt keyed on the item id", () => {
  const effects = run(CAPTURE);
  const receipts = effects.filter((e) => e.kind === "receipt");
  expect(receipts.length).toBe(1);
  expect((receipts[0] as any).turn).toBe("019f9261-f759-7062-91be-b1956956959a");
  expect(typeof (receipts[0] as any).uuid).toBe("string");
});

test("token usage → context effect", () => {
  const effects = run(CAPTURE);
  const ctx = effects.filter((e) => e.kind === "context");
  expect(ctx.length).toBeGreaterThan(0);
  expect(typeof (ctx[0] as any).tokens).toBe("number");
});

// ── Synthetic coverage for the tool variants not in the command fixture ──────
test("fileChange item → CodexPatch tool call", () => {
  const norm = normalizer();
  norm.handle({ method: "turn/started", params: { turn: { id: "t1" } } });
  const started = norm.handle({
    method: "item/started",
    params: { turnId: "t1", item: { type: "fileChange", id: "fc1", changes: [{ path: "a.ts", kind: "update", diff: "..." }] } },
  });
  // The tool `call` field is the CANONICAL (turn, type, ordinal) identity — NOT
  // the transient item id — so it matches across live vs history replay (#5).
  expect(ev(started[0])).toMatchObject({ t: "tool-call-start", name: "CodexPatch", call: "t1:fileChange:0", args: { changes: [{ path: "a.ts", kind: "update", diff: "..." }] } });
  const done = norm.handle({ method: "item/completed", params: { turnId: "t1", item: { type: "fileChange", id: "fc1", status: "completed" } } });
  expect(ev(done[0])).toEqual({ t: "tool-call-end", call: "t1:fileChange:0" });
});

test("mcpToolCall item → McpTool tool call", () => {
  const norm = normalizer();
  norm.handle({ method: "turn/started", params: { turn: { id: "t1" } } });
  const started = norm.handle({
    method: "item/started",
    params: { turnId: "t1", item: { type: "mcpToolCall", id: "m1", server: "fs", tool: "read", arguments: { path: "x" } } },
  });
  expect(ev(started[0])).toMatchObject({ t: "tool-call-start", name: "McpTool", call: "t1:mcpToolCall:0" });
});

test("interrupted turn → cancelled turn-end", () => {
  const norm = normalizer();
  norm.handle({ method: "turn/started", params: { turn: { id: "t1" } } });
  const end = norm.handle({ method: "turn/completed", params: { turn: { id: "t1", status: "interrupted" } } });
  expect(ev(end[0])).toEqual({ t: "turn-end", status: "cancelled" });
});

test("thread/settings/updated → model + effort effects (there is no thread.model)", () => {
  const norm = normalizer();
  const eff = norm.handle({ method: "thread/settings/updated", params: { threadId: "x", threadSettings: { model: "gpt-5.5", effort: "medium" } } });
  expect(eff).toEqual([{ kind: "model", code: "gpt-5.5" }, { kind: "effort", effort: "medium" }]);
});

test("open tool calls are closed when the turn ends", () => {
  const norm = normalizer();
  norm.handle({ method: "turn/started", params: { turn: { id: "t1" } } });
  norm.handle({ method: "item/started", params: { turnId: "t1", item: { type: "commandExecution", id: "c1", command: "sleep 1", cwd: "/" } } });
  // turn ends WITHOUT an item/completed for c1 → normalizer must close it.
  const end = norm.handle({ method: "turn/completed", params: { turn: { id: "t1", status: "completed" } } });
  const evs = end.filter((e) => e.kind === "wire").map((e) => (e as any).record.content.data.ev);
  expect(evs).toContainEqual({ t: "tool-call-end", call: "t1:commandExecution:0" });
  expect(evs).toContainEqual({ t: "turn-end", status: "completed" });
});

test("wire effects carry deterministic localIds keyed on the codex event identity", () => {
  const norm = normalizer();
  const tid = "T7";
  norm.handle({ method: "turn/started", params: { threadId: tid, turn: { id: "t1" } } });
  const ts = norm.handle({ method: "turn/started", params: { threadId: tid, turn: { id: "t1" } } });
  void ts;
  const started = norm.handle({ method: "item/started", params: { threadId: tid, turnId: "t1", item: { type: "commandExecution", id: "c1", command: "ls", cwd: "/" } } });
  const done = norm.handle({ method: "item/completed", params: { threadId: tid, turnId: "t1", item: { type: "commandExecution", id: "c1", status: "completed" } } });
  const end = norm.handle({ method: "turn/completed", params: { threadId: tid, turn: { id: "t1", status: "completed" } } });
  const lid = (e: any) => e.kind === "wire" ? e.localId : null;
  // Canonical (turn, type, ordinal) — stable across live vs history replay (#5).
  expect(lid(started[0])).toBe("codex:T7:turn:t1:item:commandExecution:0:tool-start");
  expect(lid(done[0])).toBe("codex:T7:turn:t1:item:commandExecution:0:tool-end");
  expect(lid(end.find((e: any) => e.kind === "wire" && e.record.content.data.ev.t === "turn-end"))).toBe("codex:T7:turn:t1:complete");
});

test("replaying the SAME events yields the SAME localIds (idempotent reconciliation)", () => {
  const build = () => {
    const n = new CodexNormalizer(() => "x");
    const out: string[] = [];
    const push = (effs: any[]) => { for (const e of effs) if (e.kind === "wire") out.push(e.localId); };
    push(n.handle({ method: "turn/started", params: { threadId: "T", turn: { id: "t1" } } }));
    push(n.handle({ method: "item/completed", params: { threadId: "T", turnId: "t1", item: { type: "agentMessage", id: "m1", text: "hi" } } }));
    push(n.handle({ method: "turn/completed", params: { threadId: "T", turn: { id: "t1", status: "completed" } } }));
    return out;
  };
  expect(build()).toEqual(build());
});

// ── #522: canonical identities are scoped per turn ───────────────────────────
// History (thread/read) reuses POSITIONAL item ids in every turn (item-0,
// item-1, …). A transient→canonical map keyed by the transient id alone let
// turn 2's `item-1` inherit turn 1's `commandExecution:0`, so recovery minted
// ids live delivery never produced: one answer duplicated, another suppressed
// against the wrong relay row. The exact two-turn sequence from the issue:
// turn 1 = user / command / answer, turn 2 = user / answer / answer.
const T1 = "019f9261-aaaa-7062-91be-000000000001";
const T2 = "019f9261-aaaa-7062-91be-000000000002";

function wireIds(notifs: CodexNotification[]): string[] {
  const n = new CodexNormalizer(() => "x");
  n.setThreadId("TH");
  const out: string[] = [];
  for (const notif of notifs) for (const e of n.handle(notif)) if (e.kind === "wire") out.push(e.localId);
  return out;
}

const TWO_TURNS_LIVE: CodexNotification[] = [
  { method: "turn/started", params: { threadId: "TH", turn: { id: T1 } } },
  { method: "item/started", params: { threadId: "TH", turnId: T1, item: { type: "userMessage", id: "msg_u1", clientId: "joy-1" } } },
  { method: "item/started", params: { threadId: "TH", turnId: T1, item: { type: "commandExecution", id: "call_1", command: "ls", cwd: "/" } } },
  { method: "item/completed", params: { threadId: "TH", turnId: T1, item: { type: "commandExecution", id: "call_1", status: "completed" } } },
  { method: "item/completed", params: { threadId: "TH", turnId: T1, item: { type: "agentMessage", id: "msg_a1", text: "one" } } },
  { method: "turn/completed", params: { threadId: "TH", turn: { id: T1, status: "completed" } } },
  { method: "turn/started", params: { threadId: "TH", turn: { id: T2 } } },
  { method: "item/started", params: { threadId: "TH", turnId: T2, item: { type: "userMessage", id: "msg_u2", clientId: "joy-2" } } },
  { method: "item/completed", params: { threadId: "TH", turnId: T2, item: { type: "agentMessage", id: "msg_a2", text: "two-a" } } },
  { method: "item/completed", params: { threadId: "TH", turnId: T2, item: { type: "agentMessage", id: "msg_a3", text: "two-b" } } },
  { method: "turn/completed", params: { threadId: "TH", turn: { id: T2, status: "completed" } } },
];

// The same two turns as #reconcileHistoryInner feeds them: positional ids that
// RESTART at item-0 in every turn, started+completed per item.
function historyTurn(tid: string, items: Record<string, unknown>[]): CodexNotification[] {
  const out: CodexNotification[] = [{ method: "turn/started", params: { turn: { id: tid } } }];
  items.forEach((item, i) => {
    const withId = { ...item, id: `item-${i}` };
    out.push({ method: "item/started", params: { turnId: tid, item: withId } });
    out.push({ method: "item/completed", params: { turnId: tid, item: withId } });
  });
  out.push({ method: "turn/completed", params: { turn: { id: tid, status: "completed" } } });
  return out;
}
const TWO_TURNS_HISTORY: CodexNotification[] = [
  ...historyTurn(T1, [
    { type: "userMessage", clientId: "joy-1" },
    { type: "commandExecution", command: "ls", cwd: "/", status: "completed" },
    { type: "agentMessage", text: "one" },
  ]),
  ...historyTurn(T2, [
    { type: "userMessage", clientId: "joy-2" },
    { type: "agentMessage", text: "two-a" },
    { type: "agentMessage", text: "two-b" },
  ]),
];

test("#522: a second turn reusing positional item ids gets its OWN canonical ids (live == history)", () => {
  const live = wireIds(TWO_TURNS_LIVE);
  const history = wireIds(TWO_TURNS_HISTORY);
  // Turn 2's two answers are agentMessage:0 and agentMessage:1 in BOTH paths —
  // never turn 1's commandExecution:0 / agentMessage:0 borrowed via `item-1`.
  const t2Texts = [`codex:TH:turn:${T2}:item:agentMessage:0:text`, `codex:TH:turn:${T2}:item:agentMessage:1:text`];
  expect(live.filter((id) => id.includes(`turn:${T2}:item`))).toEqual(t2Texts);
  expect(history.filter((id) => id.includes(`turn:${T2}:item`))).toEqual(t2Texts);
  expect(history).not.toContain(`codex:TH:turn:${T2}:item:commandExecution:0:text`);
  // And the whole live id set is reproduced by the replay (idempotent dedupe).
  for (const id of live) expect(history).toContain(id);
});

test("#522: the same transient id under two turns never shares a mapping, even across types", () => {
  const n = new CodexNormalizer(() => "x");
  n.setThreadId("TH");
  n.handle({ method: "turn/started", params: { turn: { id: T1 } } });
  n.handle({ method: "item/started", params: { turnId: T1, item: { type: "commandExecution", id: "item-1", command: "ls", cwd: "/" } } });
  n.handle({ method: "turn/completed", params: { turn: { id: T1, status: "completed" } } });
  n.handle({ method: "turn/started", params: { turn: { id: T2 } } });
  const eff = n.handle({ method: "item/completed", params: { turnId: T2, item: { type: "agentMessage", id: "item-1", text: "hi" } } });
  const wire = eff.find((e) => e.kind === "wire") as any;
  expect(wire.localId).toBe(`codex:TH:turn:${T2}:item:agentMessage:0:text`);
  expect(wire.record.content.data.turn).toBe(T2);
});

// A tool completion can land AFTER its turn's turn/completed and after the
// next turn/started. It used to be stamped with the CURRENT turn, so its
// localId became the next turn's `commandExecution:0:tool-end` — and the next
// turn's real completion then deduped away as a replay.
test("#523: a late tool completion (its turn ended with the tool open, the next turn has its own tool) stays on the turn that started it — the next turn's completion id is untouched", () => {
  const n = new CodexNormalizer(() => "x");
  n.setThreadId("TH");
  const wire = (effs: CodexEffect[]) => effs.filter((e) => e.kind === "wire") as Array<{ localId: string; record: any }>;
  n.handle({ method: "turn/started", params: { turn: { id: T1 } } });
  n.handle({ method: "item/started", params: { turnId: T1, item: { type: "commandExecution", id: "call_slow", command: "sleep", cwd: "/" } } });
  n.handle({ method: "turn/completed", params: { turn: { id: T1, status: "completed" } } }); // closes call_slow synthetically
  n.handle({ method: "turn/started", params: { turn: { id: T2 } } });
  // The straggler: codex reports call_slow done, tagged with ITS turn.
  const late = wire(n.handle({ method: "item/completed", params: { turnId: T1, item: { type: "commandExecution", id: "call_slow", status: "completed", exitCode: 0 } } }));
  expect(late).toHaveLength(1);
  expect(late[0].localId).toBe(`codex:TH:turn:${T1}:item:commandExecution:0:tool-end`); // dedupes against the synthetic close
  expect(late[0].record.content.data.turn).toBe(T1);
  expect(late[0].record.content.data.ev.call).toBe(`${T1}:commandExecution:0`);
  // Turn 2's own first command keeps ordinal 0 and its completion id intact.
  const start2 = wire(n.handle({ method: "item/started", params: { turnId: T2, item: { type: "commandExecution", id: "call_next", command: "ls", cwd: "/" } } }));
  const end2 = wire(n.handle({ method: "item/completed", params: { turnId: T2, item: { type: "commandExecution", id: "call_next", status: "completed" } } }));
  expect(start2[0].localId).toBe(`codex:TH:turn:${T2}:item:commandExecution:0:tool-start`);
  expect(end2[0].localId).toBe(`codex:TH:turn:${T2}:item:commandExecution:0:tool-end`);
  expect(end2[0].record.content.data.turn).toBe(T2);
});

test("#523: a late tool completion WITHOUT a turnId still resolves to the turn that started the item", () => {
  const n = new CodexNormalizer(() => "x");
  n.setThreadId("TH");
  n.handle({ method: "turn/started", params: { turn: { id: T1 } } });
  n.handle({ method: "item/started", params: { turnId: T1, item: { type: "commandExecution", id: "call_slow", command: "sleep", cwd: "/" } } });
  n.handle({ method: "turn/completed", params: { turn: { id: T1, status: "completed" } } });
  n.handle({ method: "turn/started", params: { turn: { id: T2 } } });
  const late = n.handle({ method: "item/completed", params: { item: { type: "commandExecution", id: "call_slow", status: "completed" } } }).filter((e) => e.kind === "wire") as any[];
  expect(late[0].localId).toBe(`codex:TH:turn:${T1}:item:commandExecution:0:tool-end`);
});
