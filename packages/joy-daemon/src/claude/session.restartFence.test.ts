// #481: a failed OLD dispatch must not overwrite the replacement's queue.
//
// The interleaving (registry.#retire + #replace, with a tmux write in flight):
//   1. session A drains: shifts m1, awaits the tmux write of m1
//   2. restart: A.takeQueuedForRestart() carries m2; A.end("restart")
//   3. replacement B (same session id) enqueues m2 → spool = [m2]
//   4. A's awaited write FAILS (its tmux server died with it)
// #drainOnce used to requeue m1 on the dead instance and persist under the
// shared id → spool = [m1]: the next daemon restart restored the cancelled
// prompt and lost the carried one. Uses an isolated JOY_HOME_DIR. The spool
// is the ledger now: the fence is its generation check, and `loadQueue` here
// reads the queued rows the way a fresh Session does.
import { test, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Session } from "./session";
import { ledgerFor } from "../domain/ledger";
const loadQueue = (id: string) => ledgerFor().listPending(id, ["queued"]);
import type { TmuxDriver } from "../tmux/driver";

let home: string;
beforeAll(() => { home = mkdtempSync(join(tmpdir(), "joy-restart-fence-")); process.env.JOY_HOME_DIR = home; });
afterAll(() => { delete process.env.JOY_HOME_DIR; rmSync(home, { recursive: true, force: true }); });

const READY = "──────\n❯\n──────\n  ⏵⏵ bypass permissions on";
const deps = { relayClient: null, broadcast: () => {}, addChatMessage: () => {} } as any;
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fakeTmux(pane: string, literal: (text: string) => Promise<{ ok: boolean; out: string }>): TmuxDriver {
  const ok = async () => ({ ok: true, out: "" });
  return {
    captureFresh: async () => ({ ok: true, out: pane }),
    captureCached: () => ({ ok: true, out: pane }),
    key: ok, command: ok, commandOnce: ok,
    literal: (_t: string, text: string) => literal(text),
    runSync: () => ({ ok: true, out: "" }),
    track() {}, untrack() {},
  } as unknown as TmuxDriver;
}

test("#481: an old dispatch failing after restart does not requeue or clobber the replacement's spool", async () => {
  const id = "fence-481";
  let failWrite!: () => void;
  const inFlightWrite = new Promise<{ ok: boolean; out: string }>((r) => { failWrite = () => r({ ok: false, out: "" }); });

  // A: ready pane, but the write of the first prompt hangs (tmux round-trip in flight).
  const a = new Session({ id, tmuxWindow: `joy:${id}`, cwd: home, flags: [], status: "active", startedAt: 0, tmux: fakeTmux(READY, () => inFlightWrite) }, deps);
  a.enqueue("first prompt");
  a.enqueue("second prompt");
  await vi.waitFor(() => expect(a.queueState().inFlight).toBe("first prompt"));
  expect(a.queueState().queue.map((q) => q.text)).toEqual(["second prompt"]);

  // Restart, exactly as registry.#retire / #replace do it.
  const carried = a.takeQueuedForRestart();
  expect(carried.map((q) => q.text)).toEqual(["second prompt"]);
  expect(a.end("restart")).toBe(true);
  // B: not at the prompt yet (still booting), so it holds its queue and persists it.
  const b = new Session({ id, tmuxWindow: `joy:${id}`, cwd: home, flags: [], status: "starting", startedAt: 0, tmux: fakeTmux("claude@host:~$ claude\n", async () => ({ ok: true, out: "" })) }, deps);
  for (const q of carried) b.enqueue(q.text, { id: q.id, source: q.source, mirrorToRelay: q.mirrorToRelay, seq: q.seq, visible: q.visible });
  expect(loadQueue(id).map((q) => q.text)).toEqual(["second prompt"]);

  // Now A's write fails — its tmux server was killed by the restart.
  failWrite();
  await settle(50);

  // The replacement's spool is intact: the cancelled prompt was NOT restored
  // over the carried one, and the dead instance did not pause or requeue.
  expect(loadQueue(id).map((q) => q.text)).toEqual(["second prompt"]);
  expect(a.queueState().pendingCount).toBe(0);
  expect(a.queueState().paused).toBe(false);
  expect(a.queueItemState(carried[0].id)).toBe("pending"); // carried → still pending from A's view
  expect(b.queueState().queue.map((q) => q.text)).toEqual(["second prompt"]);

  // A "next daemon restart" reloads the spool: the carried prompt, not the cancelled one.
  const c = new Session({ id, tmuxWindow: `joy:${id}`, cwd: home, flags: [], status: "starting", startedAt: 0, tmux: fakeTmux("booting", async () => ({ ok: true, out: "" })) }, deps);
  expect(c.queueState().queue.map((q) => q.text)).toEqual(["second prompt"]);
  c.end("killed");
  b.end("killed");
});

test("#481: an old dispatch whose write SUCCEEDS after restart is abandoned, not tracked", async () => {
  const id = "fence-481-late-ok";
  let finishWrite!: () => void;
  const inFlightWrite = new Promise<{ ok: boolean; out: string }>((r) => { finishWrite = () => r({ ok: true, out: "" }); });
  const a = new Session({ id, tmuxWindow: `joy:${id}`, cwd: home, flags: [], status: "active", startedAt: 0, tmux: fakeTmux(READY, () => inFlightWrite) }, deps);
  a.enqueue("only prompt");
  await vi.waitFor(() => expect(a.queueState().inFlight).toBe("only prompt"));
  a.takeQueuedForRestart();
  a.end("restart");
  finishWrite();
  await settle(50);
  // No submit Enter pending, no echo timeout armed, nothing persisted.
  expect(a.busy()).toBe(false);
  expect(loadQueue(id)).toEqual([]);
});

test("a retired instance never writes the queue spool (fence at the write)", () => {
  const id = "fence-481-ended";
  const a = new Session({ id, tmuxWindow: `joy:${id}`, cwd: home, flags: [], status: "active", startedAt: 0, tmux: fakeTmux("booting", async () => ({ ok: true, out: "" })) }, deps);
  a.end("restart");
  expect(() => a.enqueue("ghost")).toThrow(/session ended/);
  expect(loadQueue(id)).toEqual([]);
});
