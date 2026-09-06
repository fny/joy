// #466: the agy adapter must not advance its queue on `exit` while the child's
// stdout still holds unread events. One process per turn, and Node delivers
// `exit` while the pipe can still be full; the old exit handler started turn
// two immediately, so child one's remaining `agent_response` landed on turn
// two, its `result` closed turn two, and the real second answer was dropped.
// The spawn is mocked with an in-memory child; JOY_HOME_DIR is isolated.
import { test, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const H = vi.hoisted(() => ({ procs: [] as any[] }));

vi.mock("node:child_process", async (importOriginal) => {
  const orig = await importOriginal<typeof import("node:child_process")>();
  const { EventEmitter } = await import("node:events");
  const { PassThrough } = await import("node:stream");
  class FakeProc extends EventEmitter {
    stdout = new PassThrough();
    stderr = new PassThrough();
    pid = 1000 + H.procs.length;
    exitCode: number | null = null;
    signalCode: string | null = null;
    kill() { this.exitCode = 143; this.emit("exit", null); this.stdout.end(); return true; }
  }
  return { ...orig, spawn: vi.fn(() => { const p = new FakeProc(); H.procs.push(p); return p; }) };
});

import { AgySession } from "./agySession";

let home: string;
beforeAll(() => { home = mkdtempSync(join(tmpdir(), "joy-agy-")); process.env.JOY_HOME_DIR = home; });
afterAll(() => { delete process.env.JOY_HOME_DIR; rmSync(home, { recursive: true, force: true }); });

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));
const line = (o: unknown) => JSON.stringify(o) + "\n";
const answer = (idx: number, text: string) => line({ event: "step_update", step_update: { step_index: idx, step_type: "agent_response", state: "DONE", text_delta: text } });
const result = () => line({ event: "result", result: { status: "SUCCESS" } });

interface Sent { localId?: string; t: string; turn: string; text?: string; status?: string }
function harness(id: string) {
  const sent: Sent[] = [];
  const relay = new Proxy({}, {
    get: (_t, k) => k === "send"
      ? ((w: any, localId?: string) => {
        const d = w?.content?.data;
        if (!d?.ev) return; // e.g. the "⚠ agy: exit 1" user-message row — not a turn record
        sent.push({ localId, t: d.ev.t, turn: d.turn, text: d.ev.text, status: d.ev.status });
      })
      : k === "relaySessionId" ? "relay-1" : k === "metadataSnapshot" ? null : (() => Promise.resolve(true)),
  });
  const s = new AgySession({ id, cwd: home, status: "starting", startedAt: 0, conversationId: "conv-1" }, { relayClient: null, broadcast: () => {}, addChatMessage: () => {} });
  s.attachRelay(relay as any);
  s.beginWatching();
  return { s, sent };
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
