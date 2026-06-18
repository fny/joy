import { test, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { RelaySession } from "./relay";

// A mock RelayClient that simulates the server's optimistic-concurrency check:
// an update succeeds only if expectedVersion matches the server's current
// version, otherwise it returns version-mismatch with the current version.
function mockClient() {
  let serverVersion = 0;
  return {
    serverVersion: () => serverVersion,
    updateSessionMetadata: async (_sid: string, expectedVersion: number, _enc: string) => {
      if (expectedVersion !== serverVersion) {
        return { result: "version-mismatch", version: serverVersion };
      }
      serverVersion += 1;
      return { result: "success", version: serverVersion };
    },
    // unused by mergeMetadata
    trackSession() {}, untrackSession() {}, subscribe() { return () => {}; },
    emitAlive() {},
  };
}

function newSession(client: any) {
  return new RelaySession({
    client,
    relaySessionId: "rs-test",
    sessionKey: new Uint8Array(randomBytes(32)),
    variant: "dataKey",
    metadata: {},
    metadataVersion: 0,
  } as any);
}

// Two metadata writers firing concurrently must NOT clobber each other. Before
// the serialization fix, both read the same base (V0) and the loser re-sent its
// stale blob on the version-mismatch retry, erasing the winner's field.
test("concurrent metadata writes don't clobber (joy__state survives a queue/summary write)", async () => {
  const client = mockClient();
  const s = newSession(client);

  await Promise.all([
    s.updateJoyState("detached"),
    s.updateSummary("My Title"),
  ]);

  const meta = (s as any).metadata as Record<string, unknown>;
  expect(meta.joy__state).toBe("detached");
  expect((meta.summary as any)?.text).toBe("My Title");
  // both writes landed → server advanced twice
  expect(client.serverVersion()).toBe(2);
});

test("serialized writes accumulate across many concurrent patches", async () => {
  const client = mockClient();
  const s = newSession(client);

  await Promise.all([
    s.updateJoyState("running"),
    s.updateSummary("T"),
    s.updateRetry({ attempt: 1, total: 5, nextAt: 0, status: 500 }),
    s.updateQueue({ queue: ["a"], inFlight: false, paused: false } as any),
  ]);

  const meta = (s as any).metadata as Record<string, unknown>;
  expect(meta.joy__state).toBe("running");
  expect((meta.summary as any)?.text).toBe("T");
  expect(meta.joy__retry).toBeTruthy();
  expect(meta.joy__queue).toBeTruthy();
});
