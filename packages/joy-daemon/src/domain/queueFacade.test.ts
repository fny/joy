// The queue facade is a SESSION's view of the coordinator: command ids are
// global in the ledger, so every per-command method must refuse an id that
// belongs to another session (review 7652e686 — session b used to receive
// a's row from acceptCommand and could edit / cancel / move it by id).
import { test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandIdConflictError, Ledger, RelayTurnConflictError } from "./ledger";
import { SessionCoordinator } from "./coordinator";
import { FakeDriver, FakeClock, settle } from "./coordinator.fakeDriver";
import { queueFor } from "./queueFacade";

let dir: string;
let ledger: Ledger;
let clock: FakeClock;
let coord: SessionCoordinator;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "queue-facade-"));
  clock = new FakeClock();
  ledger = Ledger.open(dir, { now: () => clock.now });
  coord = new SessionCoordinator({ ledger, now: () => clock.now, schedule: clock.schedule, log: () => {} });
});
afterEach(() => { ledger.close(); rmSync(dir, { recursive: true, force: true }); });

/** A session whose driver never answers a submit: the first accepted
 *  command sits in `submitting`, every later one stays `queued`. */
function session(id: string): FakeDriver {
  const d = new FakeDriver(id, ledger.openGeneration(id, "codex"));
  coord.adopt(id, d);
  d.ready();
  return d;
}

test("accept-in-b-after-a: a caller id session a owns is refused for session b (CommandIdConflictError), b owns no command, a's row is untouched", async () => {
  session("a"); session("b");
  const qa = queueFor({ id: "a" }, coord);
  const qb = queueFor({ id: "b" }, coord);
  const mine = qa.accept("mine", { id: "same" });
  expect(mine.id).toBe("same");
  expect(() => qb.accept("stolen", { id: "same" })).toThrow(CommandIdConflictError);
  await settle();
  expect(ledger.listCommands("b")).toEqual([]);
  expect(qb.state().commands).toEqual([]);
  expect(ledger.getCommand("same")).toMatchObject({ sessionId: "a", text: "mine" });
  // The owner re-accepting its own id is the dedupe, not a second row.
  expect(qa.accept("again", { id: "same" })).toMatchObject({ id: "same" });
  expect(ledger.listCommands("a")).toHaveLength(1);
});

test("every facade lookup / mutation refuses a command id owned by another session: itemState, edit, reorder, cancel, waitFor", async () => {
  session("a"); session("b");
  const qa = queueFor({ id: "a" }, coord);
  const qb = queueFor({ id: "b" }, coord);
  const head = qa.accept("a-head");         // submitting (the driver never answers)
  const queued = qa.accept("a-queued");     // queued: editable / movable / cancellable by its owner
  const other = qa.accept("a-other");
  qb.accept("b-head"); const bq = qb.accept("b-queued");
  await settle();
  expect(ledger.getCommand(queued.id)?.state).toBe("queued");
  const before = ledger.listCommands("a").map((c) => [c.id, c.text, c.state, c.position, c.payloadVersion]);

  // Foreign ids through b's facade: unknown, and nothing changes.
  expect(qb.itemState(queued.id)).toBe("unknown");
  expect(qb.itemState(head.id)).toBe("unknown");
  expect(qb.edit(queued.id, "hijacked")).toBe(false);
  expect(qb.reorder(other.id, 0)).toBe(false);
  expect(qb.cancel(queued.id)).toBe(false);
  expect(qb.cancel(head.id)).toBe(false);
  await expect(qb.waitFor(queued.id, ["completed"], { timeoutMs: 0 })).resolves.toEqual({ state: null });
  await settle();
  expect(ledger.listCommands("a").map((c) => [c.id, c.text, c.state, c.position, c.payloadVersion])).toEqual(before);
  expect(ledger.getCommand(queued.id)?.cancelRequestedAt).toBeNull();
  expect(qb.state().commands.map((c) => c.id)).not.toContain(queued.id);

  // The same calls from the owner still work.
  expect(qa.itemState(queued.id)).toBe("pending");
  expect(qa.edit(queued.id, "edited")).toBe(true);
  expect(ledger.getCommand(queued.id)).toMatchObject({ text: "edited", payloadVersion: 2 });
  expect(qa.reorder(other.id, 0)).toBe(true);
  expect(ledger.listPending("a", ["queued"]).map((c) => c.id)).toEqual([other.id, queued.id]);
  expect(qa.cancel(queued.id)).toBe(true);
  expect(ledger.getCommand(queued.id)?.state).toBe("cancelled");
  await expect(qa.waitFor(queued.id, ["cancelled"], { timeoutMs: 0 })).resolves.toEqual({ state: "cancelled", reason: "cancelled" });
  // And b's own queued row is b's to move.
  expect(qb.reorder(bq.id, 0)).toBe(true);
  expect(qb.itemState(bq.id)).toBe("pending");
});

test("command(id): the durable row with its terminal reason and the runtime turn its attempt bound (#498); another session's id is null", async () => {
  session("a"); session("b");
  const qa = queueFor({ id: "a" }, coord);
  const qb = queueFor({ id: "b" }, coord);
  const head = qa.accept("a-head");     // submitting: the driver never answers
  const queued = qa.accept("a-queued");
  await settle();
  expect(qa.command(head.id)).toMatchObject({ id: head.id, text: "a-head", state: "submitting", terminalReason: null, runtimeTurnId: null, attempts: 1 });
  expect(qa.command(queued.id)).toMatchObject({ state: "queued", attempts: 0 });
  expect(qb.command(head.id)).toBeNull();
  expect(qa.command("nope")).toBeNull();
  // the runtime names the turn on the attempt: the facade reports it
  const attempt = ledger.latestAttempt(head.id)!;
  ledger.setAttemptTurn(attempt.id, "T-runtime");
  expect(qa.command(head.id)?.runtimeTurnId).toBe("T-runtime");
  // a terminal row keeps its reason
  expect(qa.cancel(queued.id)).toBe(true);
  await settle();
  expect(qa.command(queued.id)).toMatchObject({ state: "cancelled", terminalReason: "cancelled" });
});

test("a relay turn session a's row carries is refused for session b under a DIFFERENT command id (RelayTurnConflictError): b owns nothing, a's row is untouched, b's facade never sees a's id (review 11cf51b5)", async () => {
  session("a"); session("b");
  const qa = queueFor({ id: "a" }, coord);
  const qb = queueFor({ id: "b" }, coord);
  const mine = qa.accept("mine", { id: "a-id", relayTurnId: "shared-turn" });
  expect(mine.id).toBe("a-id");
  expect(() => qb.accept("theirs", { id: "b-id", relayTurnId: "shared-turn" })).toThrow(RelayTurnConflictError);
  await settle();
  expect(ledger.listCommands("b")).toEqual([]);
  expect(qb.state().commands).toEqual([]);
  expect(qb.itemState("a-id")).toBe("unknown");
  expect(ledger.getCommand("a-id")).toMatchObject({ sessionId: "a", text: "mine", relayTurnId: "shared-turn" });
  expect(ledger.getCommand("b-id")).toBeNull();
  // The owner re-offering the turn is the dedupe, not a second row.
  expect(qa.accept("again", { id: "a-id-2", relayTurnId: "shared-turn" })).toMatchObject({ id: "a-id" });
  expect(ledger.listCommands("a")).toHaveLength(1);
});

test("waitFor re-checks ownership after the wait: an id pruned and re-accepted by another session meanwhile is unknown, never the other session's state", async () => {
  session("a"); session("b");
  const qa = queueFor({ id: "a" }, coord);
  const qb = queueFor({ id: "b" }, coord);
  qa.accept("a-head");                       // submitting (the driver never answers)
  const q = qa.accept("a-queued");
  await settle();
  const ac = new AbortController();
  const wait = qa.waitFor(q.id, ["completed"], { timeoutMs: 60_000, signal: ac.signal });
  expect(qa.cancel(q.id)).toBe(true);        // cancelled: not an awaited state, the wait continues
  await settle();
  clock.now += 8 * 24 * 3_600_000;
  ledger.prune();                            // the terminal row is gone...
  expect(ledger.getCommand(q.id)).toBeNull();
  expect(qb.accept("b reuses the id", { id: q.id }).id).toBe(q.id); // ...and its id is b's now
  await settle();
  ac.abort();
  await expect(wait).resolves.toEqual({ state: null });
  expect(ledger.getCommand(q.id)).toMatchObject({ sessionId: "b", text: "b reuses the id" });
});
