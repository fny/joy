// #481: a failed OLD dispatch must not overwrite the replacement's queue.
//
// The interleaving (registry.#retire + #replace, with a tmux write in flight):
//   1. session A dispatches m1: the coordinator's attempt is committed, the
//      tmux write of m1 is awaited
//   2. restart: A.end("restart") — the coordinator retires A's generation:
//      m2 stays queued for the replacement, m1 (typed, never submitted) is an
//      explicit `unknown`
//   3. replacement B (same session id) adopts the same rows; once ready it
//      reconciles m1 (nothing landed → absent → re-typed by B, at least once)
//   4. A's awaited write FAILS (its tmux server died with it)
// The old #drainOnce requeued m1 on the dead instance and persisted it under
// the shared id → spool = [m1]. Now the rows are the coordinator's and every
// write is generation-fenced: the dead instance changes nothing. Uses an
// isolated JOY_HOME_DIR.
import { test, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Session } from "./session";
import { queueFor } from "../domain/queueFacade";
import { ledgerFor } from "../domain/ledger";
const loadQueue = (id: string) => ledgerFor().listPending(id, ["queued"]);
import type { TmuxDriver } from "../tmux/driver";

let home: string;
beforeAll(() => { home = mkdtempSync(join(tmpdir(), "joy-restart-fence-")); process.env.JOY_HOME_DIR = home; });
afterAll(() => { delete process.env.JOY_HOME_DIR; rmSync(home, { recursive: true, force: true }); });

const READY = "──────\n❯\n──────\n  ⏵⏵ bypass permissions on";
const deps = { relayClient: null, broadcast: () => {}, addChatMessage: () => {} } as any;
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fakeTmux(pane: string, literal: (text: string) => Promise<{ ok: boolean; out: string }>): TmuxDriver & { keys: string[] } {
  const ok = async () => ({ ok: true, out: "" });
  const keys: string[] = [];
  return {
    keys,
    captureFresh: async () => ({ ok: true, out: pane }),
    captureCached: () => ({ ok: true, out: pane }),
    key: async (_t: string, ...ks: string[]) => { keys.push(...ks); return { ok: true, out: "" }; },
    command: ok, commandOnce: ok,
    literal: (_t: string, text: string) => literal(text),
    runSync: () => ({ ok: true, out: "" }),
    track() {}, untrack() {},
  } as unknown as TmuxDriver & { keys: string[] };
}

test("#481: an old dispatch failing after restart does not requeue or clobber the replacement's queue", async () => {
  const id = "fence-481";
  let failWrite!: () => void;
  const inFlightWrite = new Promise<{ ok: boolean; out: string }>((r) => { failWrite = () => r({ ok: false, out: "" }); });

  // A: ready pane, but the write of the first prompt hangs (tmux round-trip in flight).
  const a = new Session({ id, tmuxWindow: `joy:${id}`, cwd: home, flags: [], status: "active", startedAt: 0, tmux: fakeTmux(READY, () => inFlightWrite) }, deps);
  a.beginWatching();
  const first = queueFor(a).accept("first prompt", { visible: true });
  const second = queueFor(a).accept("second prompt", { visible: true });
  await vi.waitFor(() => expect(queueFor(a).state().inFlight).toBe("first prompt"));
  expect(queueFor(a).state().queue.map((q) => q.text)).toEqual(["second prompt"]);

  // Restart, exactly as registry.#retire / #replace do it: the rows stay.
  expect(a.end("restart")).toBe(true);
  expect(ledgerFor().getCommand(first.id)?.state).toBe("unknown");   // typed, never submitted: no delivery evidence
  expect(ledgerFor().getCommand(second.id)?.state).toBe("queued");   // carried by the ledger, not by memory
  // B: not at the prompt yet (still booting), so it holds the queue.
  const bTmux = fakeTmux("claude@host:~$ claude\n", async () => ({ ok: true, out: "" }));
  const b = new Session({ id, tmuxWindow: `joy:${id}`, cwd: home, flags: [], status: "starting", startedAt: 0, tmux: bTmux }, deps);
  b.beginWatching();
  expect(loadQueue(id).map((q) => q.text)).toEqual(["second prompt"]);

  // Now A's write fails — its tmux server was killed by the restart.
  failWrite();
  await settle(50);

  // The replacement's queue is intact: the dead instance neither requeued,
  // paused nor duplicated anything, and armed no Enter for the dead write.
  expect(loadQueue(id).map((q) => q.text)).toEqual(["second prompt"]);
  expect(queueFor(b).state().paused).toBe(false);
  expect(ledgerFor().listCommands(id).map((c) => c.text)).toEqual(["first prompt", "second prompt"]);
  // B, once ready, reconciles the unknown first prompt: nothing landed in the
  // dead process, so it is re-typed by B — once — ahead of the second prompt.
  await vi.waitFor(() => expect(ledgerFor().getCommand(first.id)?.state).toBe("queued"), { timeout: 4_000 });
  expect(loadQueue(id).map((q) => q.text)).toEqual(["first prompt", "second prompt"]);
  expect(ledgerFor().attemptsForCommand(first.id).map((x) => x.state)).toEqual(["superseded"]);
  expect(bTmux.keys).toEqual([]); // still booting: nothing typed yet
  b.end("killed");
  expect(loadQueue(id)).toEqual([]);
});

test("#481: an old dispatch whose write SUCCEEDS after restart is abandoned, not tracked", async () => {
  const id = "fence-481-late-ok";
  let finishWrite!: () => void;
  const inFlightWrite = new Promise<{ ok: boolean; out: string }>((r) => { finishWrite = () => r({ ok: true, out: "" }); });
  const aTmux = fakeTmux(READY, () => inFlightWrite);
  const a = new Session({ id, tmuxWindow: `joy:${id}`, cwd: home, flags: [], status: "active", startedAt: 0, tmux: aTmux }, deps);
  a.beginWatching();
  const only = queueFor(a).accept("only prompt", { visible: true });
  await vi.waitFor(() => expect(queueFor(a).state().inFlight).toBe("only prompt"));
  a.end("restart");
  finishWrite();
  await settle(500);
  // No submit Enter pending or sent, no echo timeout armed, nothing re-queued
  // by the dead instance: the row is the explicit unknown the retire left.
  expect(aTmux.keys).not.toContain("Enter");
  expect(ledgerFor().getCommand(only.id)?.state).toBe("unknown");
  expect(loadQueue(id)).toEqual([]);
});

test("a retired instance never accepts into the queue (fence at the write)", () => {
  const id = "fence-481-ended";
  const a = new Session({ id, tmuxWindow: `joy:${id}`, cwd: home, flags: [], status: "active", startedAt: 0, tmux: fakeTmux("booting", async () => ({ ok: true, out: "" })) }, deps);
  a.end("restart");
  expect(() => queueFor(a).accept("ghost", { visible: true })).toThrow(/session ended/);
  expect(loadQueue(id)).toEqual([]);
});
