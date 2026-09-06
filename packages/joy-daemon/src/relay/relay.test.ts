import { test, expect, afterEach, vi } from "vitest";
import tweetnacl from "tweetnacl";
import { RelaySession, RelayClient, encodeToolCallEnd, joyMessageFrom, joyMessageFromLabel, encryptWire, decryptWire } from "./relay";
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

test("joy-message provenance: from and from-label are read from the daemon's wrapper", () => {
  const text = '<joy-message from="joy:774a97e6" from-label="Claude Code (claude-opus-5) · Greet CLI" reply-to="joy:774a97e6">\nhi\n</joy-message>';
  expect(joyMessageFrom(text)).toBe("joy:774a97e6");
  expect(joyMessageFromLabel(text)).toBe("Claude Code (claude-opus-5) · Greet CLI");
  expect(joyMessageFromLabel('<joy-message from="cli">\nhi\n</joy-message>')).toBeNull();
});

// ── #587: redundancy is judged inside the chain, after earlier writes apply ──

test("a clear queued behind a pending publish is NOT dropped (#587)", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  registerV2CardPublisher(ID, async () => { await gate; }); // every publish parks until released
  const s = newSession();
  void s.updateSummary("blocker");                  // occupies the chain
  const set = s.updateCompacting({ since: 1 } as any); // queued behind it
  const clear = s.updateCompacting(null);           // used to return early: joy__compacting still empty at CALL time
  release();
  await Promise.all([set, clear]);
  expect(s.metadataSnapshot!.joy__compacting).toBeNull();
});

test("a value set and reverted while the chain is blocked ends where it was reverted to (#587)", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  registerV2CardPublisher(ID, async () => { await gate; });
  const s = newSession();
  await Promise.resolve();
  void s.updateModelCode("old");
  release();
  await Promise.resolve();
  // Block again, then B then back to A while B's publish is pending.
  let release2!: () => void;
  const gate2 = new Promise<void>((r) => { release2 = r; });
  registerV2CardPublisher(ID, async () => { await gate2; });
  void s.updateSummary("blocker");
  const toNew = s.updateModelCode("new");
  const back = s.updateModelCode("old");           // used to be skipped: metadata still said "old"
  release2();
  await Promise.all([toNew, back]);
  expect(s.metadataSnapshot!.currentModelCode).toBe("old");
});

test("redundant writes are still skipped (control)", async () => {
  const published: unknown[] = [];
  registerV2CardPublisher(ID, (m) => { published.push(m); });
  const s = newSession();
  await s.updateCompacting(null);       // nothing set → no write
  await s.updateJoyState("running");
  await s.updateJoyState("running");    // unchanged → no write
  await s.updateQueue({ queue: [], inFlight: false, paused: false } as any); // empty on empty → no write
  expect(published.length).toBe(1);
});

// ── #118: push bodies carry no conversation content by default ───────────────

test("the 'done' push body never carries the reply snippet or the AI title unless opted in (#118)", () => {
  const saved = process.env.JOY_PUSH_SNIPPETS;
  delete process.env.JOY_PUSH_SNIPPETS;
  try {
    const sent: Array<{ kind: string; title: string; body: string }> = [];
    const client = { sendSessionPushEvent: async (_id: string, kind: string, title: string, body: string) => { sent.push({ kind, title, body }); } };
    const s = new RelaySession({ client: client as any, relaySessionId: ID, metadata: { host: "box", path: "/home/u/proj", summary: { text: "Rotating the prod DB password" } } });
    s.notify("done", "The new password is hunter2 — saved to .env");
    s.notify("permission", undefined);
    s.notify("question", undefined);
    expect(sent.map((x) => x.body)).toEqual(["Finished", "Permission needed", "Clarification needed"]);
    expect(sent.every((x) => x.title === "box/proj")).toBe(true);
    for (const x of sent) { expect(x.body).not.toContain("hunter2"); expect(x.body).not.toContain("prod DB"); }
    // Opt-in restores the richer bodies.
    process.env.JOY_PUSH_SNIPPETS = "1";
    s.notify("done", "The new password is hunter2");
    expect(sent[3].body).toBe("The new password is hunter2");
  } finally {
    if (saved === undefined) delete process.env.JOY_PUSH_SNIPPETS; else process.env.JOY_PUSH_SNIPPETS = saved;
  }
});

// ── #61: machine metadata is a version-checked merge over a FRESH read ───────

function fakeMachineRelay(machineKey: Uint8Array) {
  const kp = tweetnacl.box.keyPair();
  const creds = { token: "tok", serverUrl: "http://relay.test", machineId: "m-61", encryption: { type: "dataKey" as const, publicKey: kp.publicKey, machineKey } };
  const row: { metadata: Record<string, unknown>; version: number; dataKey: string | null } = { metadata: { displayName: "A", host: "old" }, version: 1, dataKey: "k" };
  const writes: Array<{ method: string; blob: Record<string, unknown>; expected?: number }> = [];
  let failGets = 0;
  let mismatchOnce = false;
  const seal = (m: Record<string, unknown>) => Buffer.from(encryptWire(machineKey, m)).toString("base64");
  const open = (b64: string) => decryptWire(machineKey, new Uint8Array(Buffer.from(b64, "base64"))) as Record<string, unknown>;
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetchImpl = async (input: any, init?: any): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body) : {};
    if (url.pathname === "/joy/v2/machines/m-61" && method === "GET") {
      if (failGets > 0) { failGets--; return json(503, { error: "unavailable" }); }
      return json(200, { machine: { id: "m-61", metadata: seal(row.metadata), metadataVersion: row.version, dataEncryptionKey: row.dataKey, daemonStateVersion: 7 } });
    }
    if (url.pathname === "/joy/v2/machines/m-61" && method === "PATCH") {
      const blob = open(body.metadata);
      writes.push({ method, blob, expected: body.expectedMetadataVersion });
      if (mismatchOnce) { mismatchOnce = false; return json(200, { result: "version-mismatch", metadataVersion: row.version, daemonStateVersion: 7 }); }
      if (body.expectedMetadataVersion !== row.version) return json(200, { result: "version-mismatch", metadataVersion: row.version, daemonStateVersion: 7 });
      row.metadata = blob; row.version++;
      return json(200, { result: "success", metadataVersion: row.version, daemonStateVersion: 7 });
    }
    if (url.pathname === "/joy/v2/machines" && method === "POST") {
      const blob = open(body.metadata);
      writes.push({ method, blob });
      row.metadata = blob; row.version++; row.dataKey = body.dataEncryptionKey;
      return json(200, { machine: { id: "m-61", metadataVersion: row.version, daemonStateVersion: 7 } });
    }
    return json(404, { error: "nope" });
  };
  return { creds, row, writes, fetchImpl, setFailGets: (n: number) => { failGets = n; }, mismatchOnce: () => { mismatchOnce = true; } };
}

test("a command-scan push right after an app rename carries the NEW name (#61)", async () => {
  const key = new Uint8Array(32).fill(5);
  const relay = fakeMachineRelay(key);
  vi.stubGlobal("fetch", relay.fetchImpl);
  try {
    const client = new RelayClient(relay.creds as any);
    expect(await client.getOrCreateMachine({ homeDir: "/home/u" })).toBe(true);
    expect(relay.row.metadata.displayName).toBe("A");
    expect(relay.row.metadata.homeDir).toBe("/home/u");
    // The app renames the machine on the relay (invisible to the daemon)…
    relay.row.metadata = { ...relay.row.metadata, displayName: "B" }; relay.row.version++;
    // …and a scan push follows within the old 60s cache window.
    expect(await client.getOrCreateMachine({ homeDir: "/home/u", slashCommands: ["/x"] })).toBe(true);
    expect(relay.row.metadata.displayName).toBe("B");
    expect(relay.row.metadata.slashCommands).toEqual(["/x"]);
    // Every existing-row write was a version-checked PATCH, never a blind full POST.
    expect(relay.writes.every((w) => w.method === "PATCH" && typeof w.expected === "number")).toBe(true);
  } finally { vi.unstubAllGlobals(); }
});

test("a version mismatch re-reads and retries with the other writer's fields; a failed read writes nothing (#61)", async () => {
  const key = new Uint8Array(32).fill(6);
  const relay = fakeMachineRelay(key);
  vi.stubGlobal("fetch", relay.fetchImpl);
  try {
    const client = new RelayClient(relay.creds as any);
    relay.mismatchOnce();
    relay.row.metadata = { ...relay.row.metadata, displayName: "C" };
    expect(await client.getOrCreateMachine({ homeDir: "/h" })).toBe(true);
    expect(relay.writes.length).toBe(2); // mismatch, then the retry
    expect(relay.row.metadata.displayName).toBe("C");
    const before = relay.writes.length;
    relay.setFailGets(1);
    expect(await client.getOrCreateMachine({ homeDir: "/h" })).toBe(false);
    expect(relay.writes.length).toBe(before); // no write on an unknown row state
    expect(relay.row.metadata.displayName).toBe("C");
  } finally { vi.unstubAllGlobals(); }
});

test("a machine with no row yet is created with the full POST (control)", async () => {
  const key = new Uint8Array(32).fill(7);
  const relay = fakeMachineRelay(key);
  const impl = relay.fetchImpl;
  let missing = true;
  vi.stubGlobal("fetch", async (input: any, init?: any) => {
    const url = new URL(String(input));
    if (missing && url.pathname === "/joy/v2/machines/m-61" && (init?.method ?? "GET") === "GET") return new Response(JSON.stringify({ error: "machine_not_found" }), { status: 404 });
    if (url.pathname === "/joy/v2/machines" && init?.method === "POST") missing = false;
    return impl(input, init);
  });
  try {
    const client = new RelayClient(relay.creds as any);
    expect(await client.getOrCreateMachine({ homeDir: "/h" })).toBe(true);
    expect(relay.writes.map((w) => w.method)).toEqual(["POST"]);
    expect(relay.row.metadata.displayName).toBeUndefined();
  } finally { vi.unstubAllGlobals(); }
});
