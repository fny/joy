// #590: stopping a control client whose attach spawn is about to fail must not
// leave the child's asynchronous 'error' unhandled (an unhandled 'error' event
// is thrown at the event loop and kills the daemon). child_process.spawn is
// replaced with a fake so the failure can be delivered AFTER stop().
import { test, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";

class FakeStream extends EventEmitter {
  writable = true;
  write(): boolean { return true; }
  end(): void {}
  destroy(): void {}
  setEncoding(): this { return this; }
}
class FakeProc extends EventEmitter {
  pid = 4242;
  stdin = new FakeStream();
  stdout = new FakeStream();
  stderr = null;
  killed = 0;
  kill(): boolean { this.killed++; return true; }
}
let last: FakeProc | null = null;

vi.mock("child_process", async (importOriginal) => {
  const orig = await importOriginal<typeof import("child_process")>();
  return { ...orig, spawn: () => { last = new FakeProc(); return last as unknown as import("child_process").ChildProcess; } };
});
vi.mock("./shell", () => ({ run: () => ({ ok: true, out: "" }), tmuxArgv: () => ["tmux"] }));

beforeEach(() => { last = null; });

test("a spawn 'error' delivered after stop() is absorbed, not thrown (#590)", async () => {
  const { TmuxControlClient } = await import("./controlClient");
  const client = new TmuxControlClient("joy-test");
  expect(last).not.toBeNull();
  const proc = last!;
  client.stop();
  expect(proc.killed).toBe(1);
  // EventEmitter throws synchronously from emit('error') when no listener is
  // attached — exactly what Node does with a late ENOENT. Both the process and
  // its stdin pipe can carry one.
  expect(() => proc.emit("error", Object.assign(new Error("spawn tmux ENOENT"), { code: "ENOENT" }))).not.toThrow();
  expect(() => proc.stdin.emit("error", new Error("EPIPE"))).not.toThrow();
  // And the lifecycle handlers really are gone: a late 'exit' must not schedule a
  // reconnect (a stopped client spawns nothing more).
  proc.emit("exit", 1);
  await new Promise((r) => setTimeout(r, 20));
  expect(last).toBe(proc);
});

test("the same holds for the client retired by a disconnect (#590)", async () => {
  const { TmuxControlClient } = await import("./controlClient");
  const client = new TmuxControlClient("joy-test");
  const first = last!;
  first.emit("exit", 1); // → #onExit retires `first` and schedules a reconnect
  expect(() => first.emit("error", new Error("late ENOENT"))).not.toThrow();
  expect(() => first.stdin.emit("error", new Error("EPIPE"))).not.toThrow();
  client.stop();
});
