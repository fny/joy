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
  expect(confirms).toEqual([{ kind: "confirmDispatch", clientId: "joy-local-1" }]);
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
