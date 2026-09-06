// PiSession adapter behaviour against a fake `pi --mode rpc` child: the spawn
// is mocked with an in-memory process whose stdin we read and whose stdout we
// feed JSONL events; JOY_HOME_DIR is isolated so window records are ours.
// Covers #575 (turn ids collide across restarts), #576 (continue never
// records the pi session id), #577 (rejected prompt/steer ignored), #578
// (tool output / isError dropped) and #115 (/title must be a handled command).
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
    /** Every JSONL command the daemon wrote to stdin, parsed. */
    commands: any[] = [];
    pid = 2000 + H.procs.length;
    exitCode: number | null = null;
    signalCode: string | null = null;
    constructor() {
      super();
      let buf = "";
      this.stdin.on("data", (c: Buffer) => {
        buf += String(c);
        const lines = buf.split("\n"); buf = lines.pop() ?? "";
        for (const l of lines) if (l.trim()) this.commands.push(JSON.parse(l));
      });
    }
    kill() { this.exitCode = 143; this.emit("exit", null); this.stdout.end(); return true; }
  }
  return { ...orig, spawn: vi.fn(() => { const p = new FakeProc(); H.procs.push(p); return p; }) };
});

import { PiSession, type PiInit } from "./piSession";
import { loadWindowRecord } from "../domain/windowRecord";

let home: string;
beforeAll(() => { home = mkdtempSync(join(tmpdir(), "joy-pi-")); process.env.JOY_HOME_DIR = home; });
afterAll(() => { delete process.env.JOY_HOME_DIR; rmSync(home, { recursive: true, force: true }); });

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));
const line = (o: unknown) => JSON.stringify(o) + "\n";
const lastSpawnArgs = () => vi.mocked(spawn).mock.calls.at(-1)![1] as string[];

interface Sent { localId?: string; role: string; t?: string; turn?: string; text?: string; status?: string; ev?: any }
function harness(id: string, init: Partial<PiInit> = {}) {
  const sent: Sent[] = [];
  const chat: { role: string; content: string; event_status?: string }[] = [];
  const relay = new Proxy({}, {
    get: (_t, k) => k === "send"
      ? ((w: any, localId?: string) => {
        const d = w?.content?.data;
        if (d?.ev) sent.push({ localId, role: "session", t: d.ev.t, turn: d.turn, text: d.ev.text, status: d.ev.status, ev: d.ev });
        else sent.push({ localId, role: w.role, text: w?.content?.text });
      })
      : k === "relaySessionId" ? "relay-1" : k === "metadataSnapshot" ? null : (() => Promise.resolve(true)),
  });
  const s = new PiSession({ id, cwd: home, status: "starting", startedAt: 0, ...init }, { relayClient: null, broadcast: () => {}, addChatMessage: (m) => { chat.push({ role: m.role, content: m.content, event_status: m.event_status }); } });
  s.attachRelay(relay as any);
  s.beginWatching();
  const p = H.procs.at(-1)!;
  return { s, sent, chat, p };
}

test("#575: turn ids do not collide across a restart of the same joy session", async () => {
  H.procs.length = 0;
  const gen1 = harness("pi-575");
  gen1.p.stdout.write(line({ type: "turn_start" }));
  await vi.waitFor(() => expect(gen1.sent.filter((e) => e.t === "turn-start")).toHaveLength(1));
  const t1 = gen1.sent.find((e) => e.t === "turn-start")!.turn!;
  gen1.p.stdout.write(line({ type: "turn_end", message: { content: [{ type: "text", text: "one" }] } }));
  await vi.waitFor(() => expect(gen1.sent.filter((e) => e.t === "turn-end")).toHaveLength(1));
  gen1.s.end("restart");

  const gen2 = harness("pi-575");
  gen2.p.stdout.write(line({ type: "turn_start" }));
  await vi.waitFor(() => expect(gen2.sent.filter((e) => e.t === "turn-start")).toHaveLength(1));
  const t2 = gen2.sent.find((e) => e.t === "turn-start")!.turn!;
  expect(t2).not.toBe(t1);
  expect(gen2.sent.find((e) => e.t === "turn-start")!.localId).not.toBe(gen1.sent.find((e) => e.t === "turn-start")!.localId);
  gen2.s.end("killed");
});

test("#576: continueLast records the pi session id the get_state response names", async () => {
  H.procs.length = 0;
  const { s, p } = harness("pi-576", { continueLast: true });
  expect(lastSpawnArgs()).toContain("-c");
  expect(s.piSessionId).toBeUndefined();
  await vi.waitFor(() => expect(p.commands.some((c: any) => c.type === "get_state")).toBe(true));
  p.stdout.write(line({ type: "response", command: "get_state", success: true, data: { model: { id: "m-1" }, sessionId: "sess-abc", isStreaming: false } }));
  await vi.waitFor(() => expect(s.piSessionId).toBe("sess-abc"));
  expect(loadWindowRecord("pi-576")?.piSettings?.sessionId).toBe("sess-abc");
  s.end("killed");
});

test("#577: a rejected prompt is surfaced instead of silently dropped", async () => {
  H.procs.length = 0;
  const { s, p, sent, chat } = harness("pi-577");
  s.enqueue("do the thing", { mirrorToRelay: false });
  await vi.waitFor(() => expect(p.commands.some((c: any) => c.type === "prompt")).toBe(true));
  const cmd = p.commands.find((c: any) => c.type === "prompt");
  expect(cmd.message).toBe("do the thing");
  expect(typeof cmd.id).toBe("string"); // correlatable
  p.stdout.write(line({ type: "response", id: cmd.id, command: "prompt", success: false, error: "no model configured" }));
  await vi.waitFor(() => expect(sent.some((e) => e.role === "user" && /rejected/.test(e.text ?? ""))).toBe(true));
  const note = sent.find((e) => e.role === "user" && /rejected/.test(e.text ?? ""))!;
  expect(note.text).toContain("no model configured");
  expect(chat).toEqual([expect.objectContaining({ role: "event", event_status: "error", content: expect.stringContaining("no model configured") })]);
  // A success response for a later prompt produces no note.
  s.enqueue("again", { mirrorToRelay: false });
  await vi.waitFor(() => expect(p.commands.filter((c: any) => c.type === "prompt")).toHaveLength(2));
  const cmd2 = p.commands.filter((c: any) => c.type === "prompt")[1];
  p.stdout.write(line({ type: "response", id: cmd2.id, command: "prompt", success: true }));
  await settle(20);
  expect(sent.filter((e) => e.role === "user")).toHaveLength(1);
  s.end("killed");
});

test("#577: a prompt that never reaches pi's stdin is surfaced too", async () => {
  H.procs.length = 0;
  const { s, p, sent } = harness("pi-577-stdin");
  p.stdin.destroy(); // pi shut its stdin
  await settle(10);
  s.enqueue("into the void", { mirrorToRelay: false });
  expect(sent.some((e) => e.role === "user" && /rejected/.test(e.text ?? ""))).toBe(true);
  s.end("killed");
});

test("#578: tool_execution_end forwards the result text and the error flag", async () => {
  H.procs.length = 0;
  const { s, p, sent } = harness("pi-578");
  p.stdout.write(line({ type: "turn_start" }));
  p.stdout.write(line({ type: "tool_execution_start", toolCallId: "call-1", toolName: "bash", args: { command: "rm -rf /" } }));
  p.stdout.write(line({ type: "tool_execution_end", toolCallId: "call-1", toolName: "bash", result: { content: [{ type: "text", text: "permission denied" }], details: {} }, isError: true }));
  p.stdout.write(line({ type: "tool_execution_end", toolCallId: "call-2", toolName: "read", result: { content: [{ type: "text", text: "line 1" }, { type: "text", text: "line 2" }] }, isError: false }));
  await vi.waitFor(() => expect(sent.filter((e) => e.t === "tool-call-end")).toHaveLength(2));
  const [failed, ok] = sent.filter((e) => e.t === "tool-call-end").map((e) => e.ev);
  expect(failed).toMatchObject({ call: "call-1", result: "permission denied", isError: true });
  expect(ok).toMatchObject({ call: "call-2", result: "line 1\nline 2" });
  expect(ok.isError).toBeUndefined();
  s.end("killed");
});

test("#115: /title and /joy-prompt report themselves as handled commands", async () => {
  H.procs.length = 0;
  const { s, p } = harness("pi-115");
  const titled = s.enqueue("/title Release review", { mirrorToRelay: false });
  expect(titled.handled).toBe("command");
  expect(s.summary).toBe("Release review");
  expect(p.commands.filter((c: any) => c.type === "prompt")).toHaveLength(0); // never forwarded
  const reinjected = s.enqueue("/joy-prompt", { mirrorToRelay: false });
  expect(reinjected.handled).toBe("command");
  const plain = s.enqueue("hello", { mirrorToRelay: false });
  expect(plain.handled).toBeUndefined();
  s.end("killed");
});
