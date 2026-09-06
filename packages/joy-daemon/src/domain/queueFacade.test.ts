// The queue facade is a SESSION's view of the coordinator: command ids are
// global in the ledger, so every per-command method must refuse an id that
// belongs to another session (review 7652e686 — session b used to receive
// a's row from acceptCommand and could edit / cancel / move it by id).
import { test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger, CommandIdConflictError } from "./ledger";
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
