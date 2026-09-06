// #466: the agy adapter must not advance its queue on `exit` while the child's
// stdout still holds unread events. One process per turn, and Node delivers
// `exit` while the pipe can still be full; the old exit handler started turn
// two immediately, so child one's remaining `agent_response` landed on turn
// two, its `result` closed turn two, and the real second answer was dropped.
// The spawn is mocked with an in-memory child; JOY_HOME_DIR is isolated.
// The same harness drives #467 (buffered text on a dead turn), #468 (pending
// --continue across restart), #469 (/title across restart) and #56 (prompt
// over stdin, not argv).
import { test, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawn } from "node:child_process";

const H = vi.hoisted(() => ({ procs: [] as any[] }));

vi.mock("node:child_process", async (importOriginal) => {
  const orig = await importOriginal<typeof import("node:child_process")>();
  const { EventEmitter } = await import("node:events");
  const { PassThrough } = await import("node:stream");
  class FakeProc extends EventEmitter {
    stdout = new PassThrough();
    stderr = new PassThrough();
    stdin = new PassThrough();
    /** Everything the daemon wrote to stdin, and whether it closed it. */
    stdinText = "";
    stdinEnded = false;
    pid = 1000 + H.procs.length;
    exitCode: number | null = null;
    signalCode: string | null = null;
    constructor() {
      super();
      this.stdin.on("data", (c: Buffer) => { this.stdinText += String(c); });
      this.stdin.on("end", () => { this.stdinEnded = true; });
    }
    kill() { this.exitCode = 143; this.emit("exit", null); this.stdout.end(); return true; }
  }
  return { ...orig, spawn: vi.fn(() => { const p = new FakeProc(); H.procs.push(p); return p; }) };
});

import { AgySession, type AgyInit } from "./agySession";
import { loadWindowRecord } from "../domain/windowRecord";

let home: string;
beforeAll(() => { home = mkdtempSync(join(tmpdir(), "joy-agy-")); process.env.JOY_HOME_DIR = home; });
afterAll(() => { delete process.env.JOY_HOME_DIR; rmSync(home, { recursive: true, force: true }); });

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));
const line = (o: unknown) => JSON.stringify(o) + "\n";
const answer = (idx: number, text: string) => line({ event: "step_update", step_update: { step_index: idx, step_type: "agent_response", state: "DONE", text_delta: text } });
const delta = (idx: number, text: string) => line({ event: "step_update", step_update: { step_index: idx, step_type: "agent_response", state: "ACTIVE", text_delta: text } });
const result = () => line({ event: "result", result: { status: "SUCCESS" } });
const lastSpawnArgs = () => vi.mocked(spawn).mock.calls.at(-1)![1] as string[];

interface Sent { localId?: string; t: string; turn: string; text?: string; status?: string }
function harness(id: string, init: Partial<AgyInit> = {}) {
  const sent: Sent[] = [];
  const summaries: string[] = [];
  const chat: { role: string; content: string }[] = [];
  const relay = new Proxy({}, {
    get: (_t, k) => k === "send"
      ? ((w: any, localId?: string) => {
        const d = w?.content?.data;
        if (!d?.ev) return; // e.g. the "⚠ agy: exit 1" user-message row — not a turn record
        sent.push({ localId, t: d.ev.t, turn: d.turn, text: d.ev.text, status: d.ev.status });
      })
      : k === "updateSummary" ? ((t: string) => { summaries.push(t); return Promise.resolve(); })
      : k === "relaySessionId" ? "relay-1" : k === "metadataSnapshot" ? null : (() => Promise.resolve(true)),
  });
  const s = new AgySession({ id, cwd: home, status: "starting", startedAt: 0, conversationId: "conv-1", ...init }, { relayClient: null, broadcast: () => {}, addChatMessage: (m) => { chat.push({ role: m.role, content: m.content }); } });
  s.attachRelay(relay as any);
  s.beginWatching();
  return { s, sent, summaries, chat };
}

test("#466: exit before stdout drains does not advance the queue; late lines stay on their own turn", async () => {
  H.procs.length = 0;
  const { s, sent } = harness("agy-466");
  s.enqueue("first", { mirrorToRelay: false });
  s.enqueue("second", { mirrorToRelay: false });
  await vi.waitFor(() => expect(H.procs).toHaveLength(1));
  const p1 = H.procs[0];
  const t1 = sent.find((e) => e.t === "turn-start")!.turn;

  // Child one exits while its answer and result are still in the pipe.
  p1.exitCode = 0; p1.emit("exit", 0);
  await settle(30);
  expect(H.procs).toHaveLength(1);                       // turn two NOT started yet
  expect(sent.filter((e) => e.t === "turn-end")).toEqual([]); // turn one still open
  expect(s.queueState().inFlight).toBe("first");

  // The pipe drains: these belong to turn ONE.
  p1.stdout.write(answer(1, "answer one"));
  p1.stdout.write(result());
  p1.stdout.end();
  await vi.waitFor(() => expect(H.procs).toHaveLength(2));
  const p2 = H.procs[1];
  const starts = sent.filter((e) => e.t === "turn-start");
  expect(starts).toHaveLength(2);
  const t2 = starts[1].turn;
  expect(t2).not.toBe(t1);
  // Ordering on the wire: turn one's text and end BEFORE turn two's start.
  const kinds = sent.map((e) => `${e.t}@${e.turn === t1 ? "t1" : "t2"}`);
  expect(kinds).toEqual(["turn-start@t1", "text@t1", "turn-end@t1", "turn-start@t2"]);
  expect(sent.find((e) => e.t === "text")).toMatchObject({ turn: t1, text: "answer one" });
  expect(sent.find((e) => e.t === "turn-end")).toMatchObject({ turn: t1, status: "completed" });

  // Turn two's answer is not discarded and lands on turn two.
  p2.stdout.write(answer(1, "answer two"));
  p2.stdout.write(result());
  p2.stdout.end();
  p2.exitCode = 0; p2.emit("exit", 0);
  await vi.waitFor(() => expect(sent.filter((e) => e.t === "turn-end")).toHaveLength(2));
  expect(sent.filter((e) => e.t === "text").map((e) => [e.turn, e.text])).toEqual([[t1, "answer one"], [t2, "answer two"]]);
  expect(sent.filter((e) => e.t === "turn-end").map((e) => [e.turn, e.status])).toEqual([[t1, "completed"], [t2, "completed"]]);
  // The queue settles only once child two's stdout has closed too.
  await vi.waitFor(() => expect(s.queueState().inFlight).toBeNull());
  expect(s.busy()).toBe(false);

  // Finalization is idempotent: a duplicate exit or a late error changes nothing.
  const n = sent.length;
  p1.emit("exit", 0); p1.emit("error", new Error("late"));
  p2.emit("exit", 0);
  await settle(20);
  expect(sent).toHaveLength(n);
  expect(H.procs).toHaveLength(2);
  s.end("killed");
});

test("#466: stdout closing BEFORE exit still waits for the exit status", async () => {
  H.procs.length = 0;
  const { s, sent } = harness("agy-466-order");
  s.enqueue("only", { mirrorToRelay: false });
  await vi.waitFor(() => expect(H.procs).toHaveLength(1));
  const p = H.procs[0];
  p.stdout.write(answer(0, "done"));
  p.stdout.end(); // EOF first — no result line: the exit code decides the status
  await settle(20);
  expect(sent.filter((e) => e.t === "turn-end")).toEqual([]);
  expect(s.queueState().inFlight).toBe("only");
  p.exitCode = 1; p.emit("exit", 1);
  await vi.waitFor(() => expect(sent.filter((e) => e.t === "turn-end")).toHaveLength(1));
  expect(sent.find((e) => e.t === "turn-end")).toMatchObject({ status: "failed" });
  expect(sent.find((e) => e.t === "text")).toMatchObject({ text: "done" }); // the drained answer was kept
  await vi.waitFor(() => expect(s.queueState().inFlight).toBeNull());
  s.end("killed");
});

test("#467: text buffered when the child dies without `result` reaches relay AND chat, once, before the turn end", async () => {
  H.procs.length = 0;
  const { s, sent, chat } = harness("agy-467");
  s.enqueue("crash", { mirrorToRelay: false });
  await vi.waitFor(() => expect(H.procs).toHaveLength(1));
  const p = H.procs[0];
  p.stdout.write(delta(1, "partial "));
  p.stdout.write(delta(1, "answer"));
  await settle(20);
  expect(sent.filter((e) => e.t === "text")).toEqual([]); // still buffering (no DONE yet)
  p.stdout.end(); p.exitCode = 1; p.emit("exit", 1);
  await vi.waitFor(() => expect(sent.filter((e) => e.t === "turn-end")).toHaveLength(1));
  expect(sent.map((e) => e.t)).toEqual(["turn-start", "text", "turn-end"]);
  expect(sent.find((e) => e.t === "text")).toMatchObject({ text: "partial answer" });
  expect(sent.find((e) => e.t === "turn-end")).toMatchObject({ status: "failed" });
  expect(chat).toEqual([{ role: "assistant", content: "partial answer" }]);
  // Nothing is re-flushed by the (idempotent) late exit/error paths.
  p.emit("exit", 1); p.emit("error", new Error("late"));
  await settle(20);
  expect(sent.filter((e) => e.t === "text")).toHaveLength(1);
  expect(chat).toHaveLength(1);
  s.end("killed");
});

test("#467: a cancelled turn flushes its buffered text too", async () => {
  H.procs.length = 0;
  const { s, sent, chat } = harness("agy-467-cancel");
  s.enqueue("stop me", { mirrorToRelay: false });
  await vi.waitFor(() => expect(H.procs).toHaveLength(1));
  H.procs[0].stdout.write(delta(2, "half an answer"));
  await settle(20);
  await s.abort();
  expect(sent.map((e) => e.t)).toEqual(["turn-start", "text", "turn-end"]);
  expect(sent.find((e) => e.t === "text")).toMatchObject({ text: "half an answer" });
  expect(sent.find((e) => e.t === "turn-end")).toMatchObject({ status: "cancelled" });
  expect(chat).toEqual([{ role: "assistant", content: "half an answer" }]);
  s.end("killed");
});

test("#468: a pending --continue survives a restart until the conversation id is learned", async () => {
  H.procs.length = 0;
  const id = "agy-468";
  // Created with continueLast, restarted before the first prompt ran: the
  // registry rebuilds it from the record, which carried no flag and no id.
  const gen1 = harness(id, { conversationId: undefined, continueLast: true });
  gen1.s.end("restart");
  const gen2 = harness(id, { conversationId: undefined });
  gen2.s.enqueue("hello", { mirrorToRelay: false });
  await vi.waitFor(() => expect(H.procs).toHaveLength(1));
  expect(lastSpawnArgs()).toContain("--continue");
  expect(lastSpawnArgs()).not.toContain("--conversation");

  // The first turn names the conversation: the flag is spent, the id is kept.
  H.procs[0].stdout.write(line({ event: "init", conversation_id: "conv-learned" }));
  await settle(20);
  const rec = loadWindowRecord(id)!;
  expect(rec.agySettings?.conversationId).toBe("conv-learned");
  expect((rec.agySettings as { continueLast?: boolean }).continueLast).toBeUndefined();
  gen2.s.end("restart");
  const gen3 = harness(id, { conversationId: rec.agySettings?.conversationId });
  gen3.s.enqueue("again", { mirrorToRelay: false });
  await vi.waitFor(() => expect(H.procs).toHaveLength(2));
  expect(lastSpawnArgs()).not.toContain("--continue");
  expect(lastSpawnArgs().slice(lastSpawnArgs().indexOf("--conversation"))).toEqual(expect.arrayContaining(["--conversation", "conv-learned"]));
  gen3.s.end("killed");
});

test("#469: a /title survives a restart along with its lock", async () => {
  H.procs.length = 0;
  const id = "agy-469";
  const gen1 = harness(id);
  gen1.s.enqueue("/title Release review", { mirrorToRelay: false });
  expect(gen1.s.summary).toBe("Release review");
  expect(gen1.summaries).toEqual(["Release review"]);
  gen1.s.end("restart");

  const gen2 = harness(id);
  expect(gen2.s.summary).toBe("Release review");            // restored from the record
  expect(gen2.summaries).toEqual(["Release review"]);       // pushed onto the rebuilt card
  gen2.s.enqueue("please look at the flaky test", { mirrorToRelay: false }); // the lock still holds
  expect(gen2.s.summary).toBe("Release review");
  expect(gen2.summaries).toEqual(["Release review"]);
  gen2.s.end("killed");
});

test("#56: the prompt travels over stdin as a stream-json user message, never in argv", async () => {
  H.procs.length = 0;
  const { s } = harness("agy-56");
  const big = "x".repeat(200_000); // > MAX_ARG_STRLEN (128 KiB): E2BIG as an argument
  s.enqueue(big, { mirrorToRelay: false });
  await vi.waitFor(() => expect(H.procs).toHaveLength(1));
  const args = lastSpawnArgs();
  expect(args.some((a) => a.includes("xxxx"))).toBe(false);
  expect(args).toContain("--input-format");
  expect(args[args.indexOf("--input-format") + 1]).toBe("stream-json");
  const p = H.procs[0];
  await vi.waitFor(() => expect(p.stdinEnded).toBe(true)); // EOF ends the single-turn process
  const lines = p.stdinText.trim().split("\n");
  expect(lines).toHaveLength(1);
  expect(JSON.parse(lines[0])).toEqual({ event: "user", message: { role: "user", content: big } });
  s.end("killed");
});
