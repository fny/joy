import { test, expect, afterEach } from "vitest";
import { RelaySession, encodeToolCallEnd } from "./relay";
import { registerV2CardPublisher, unregisterV2CardPublisher, registerV2SessionId, v2SessionIdFor } from "./v2Card";

// RelaySession is a local card holder: every metadata write merges into its
// snapshot and publishes the WHOLE card through the v2 publisher the nucleus
// lane registers per session. No network client is involved in the merge.
const ID = "rs-test";

function newSession() {
  return new RelaySession({ client: {} as any, relaySessionId: ID, metadata: { path: "/x" } });
}

afterEach(() => unregisterV2CardPublisher(ID));

// Concurrent writers must NOT clobber each other: each patch reads the
// already-merged card, so every field survives.
test("concurrent metadata writes don't clobber (joy__state survives a queue/summary write)", async () => {
  const published: Record<string, unknown>[] = [];
  registerV2CardPublisher(ID, (m) => { published.push({ ...m }); });
  const s = newSession();

  await Promise.all([
    s.updateJoyState("detached"),
    s.updateSummary("My Title"),
  ]);

  const meta = s.metadataSnapshot!;
  expect(meta.joy__state).toBe("detached");
  expect((meta.summary as any)?.text).toBe("My Title");
  expect(meta.path).toBe("/x");
  // both writes published, the last one carrying the full merged card
  expect(published.length).toBe(2);
  expect(published[1].joy__state).toBe("detached");
  expect((published[1].summary as any)?.text).toBe("My Title");
});

test("serialized writes accumulate across many concurrent patches", async () => {
  const s = newSession();
  await Promise.all([
    s.updateJoyState("running"),
    s.updateSummary("T"),
    s.updateRetry({ attempt: 1, total: 5, nextAt: 0, status: 500 }),
    s.updateQueue({ queue: ["a"], inFlight: false, paused: false } as any),
  ]);
  const meta = s.metadataSnapshot!;
  expect(meta.joy__state).toBe("running");
  expect((meta.summary as any)?.text).toBe("T");
  expect(meta.joy__retry).toBeTruthy();
  expect(meta.joy__queue).toBeTruthy();
});

// archive() reports whether the archived card actually reached the relay —
// end("killed") surfaces this so a dead session never lingers in the app.
test("archive publishes joy__state:'archived' and reports the publish outcome", async () => {
  const s = newSession();
  // no publisher registered (not v2-bound) → merged locally, publish false
  expect(await s.archive()).toBe(false);
  expect(s.metadataSnapshot!.joy__state).toBe("archived");

  let seen: Record<string, unknown> | null = null;
  registerV2CardPublisher(ID, async (m) => { seen = m; });
  expect(await s.archive()).toBe(true);
  expect(seen!.joy__state).toBe("archived");

  registerV2CardPublisher(ID, async () => { throw new Error("lane down"); });
  expect(await s.archive()).toBe(false);
});

test("receipts are delivered immediately when a sink is set, else buffered", () => {
  const s = newSession();
  const got: string[] = [];
  s.stampReceiptOnLastQueued({ uuid: "m1", turn: "t1" });
  s.setReceiptSink((r) => got.push(r.uuid));
  expect(got).toEqual(["m1"]);
  s.stampReceiptOnLastQueued({ uuid: "m2", turn: "t1" });
  expect(got).toEqual(["m1", "m2"]);
});

test("v2 session id registry: pushes deep-link by RELAY id, not the local one", () => {
  // The app keys sessions by the relay id; a push stamped with the local id
  // routed to "Session has been deleted" for every notification.
  expect(v2SessionIdFor("8f7c8f88")).toBeNull();
  registerV2SessionId("8f7c8f88", "afa555f9-3c2f-4c63-a06a-f3eff18e0421");
  expect(v2SessionIdFor("8f7c8f88")).toBe("afa555f9-3c2f-4c63-a06a-f3eff18e0421");
  // Unbinding drops the mapping so a stale id can never be deep-linked.
  unregisterV2CardPublisher("8f7c8f88");
  expect(v2SessionIdFor("8f7c8f88")).toBeNull();
});

test("encodeToolCallEnd carries the tool output and failure flag", () => {
  const ok = encodeToolCallEnd("call-1", { turn: "t", result: "listing\n" });
  const ev = (ok.content as unknown as { data: { ev: Record<string, unknown> } }).data.ev;
  expect(ev).toEqual({ t: "tool-call-end", call: "call-1", result: "listing\n" });
  const failed = encodeToolCallEnd("call-2", { turn: "t", result: "exit 1", isError: true });
  expect((failed.content as unknown as { data: { ev: Record<string, unknown> } }).data.ev).toMatchObject({ isError: true, result: "exit 1" });
  // Nothing textual → the record is exactly what it always was.
  const bare = encodeToolCallEnd("call-3", { turn: "t" });
  expect((bare.content as unknown as { data: { ev: Record<string, unknown> } }).data.ev).toEqual({ t: "tool-call-end", call: "call-3" });
});
