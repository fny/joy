// #628 (Wave F29) — a takeover that cannot PROVE the recorded server's group
// is gone must not start a second one.
//
// The recorded pid belongs to a LAUNCHER that has usually already exited, so
// recovery decides from what it left behind. When the platform could not list
// processes at all, "nothing found" is the absence of a search, not the
// absence of the server: the reap answers `unknown`, and this session must
// retry and then refuse rather than open a second server on the same
// conversation (#71). `unowned` — an answer a search actually reached — is
// still permission to start fresh.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type ReapOutcome = "unowned" | "gone" | "alive" | "unknown";
const fake = vi.hoisted(() => ({
  spawned: 0,
  reapCalls: 0,
  outcome: "unknown" as "unowned" | "gone" | "alive" | "unknown",
}));

// Only the server + its client are faked; the session's own recovery logic is
// the thing under test.
vi.mock("./opencodeClient", () => ({
  OpencodeClient: class {
    onEvent() {}
    subscribeEvents() {}
    async createSession() { return { id: "ses_f29" }; }
    close() {}
  },
  spawnOpencodeServer: () => {
    fake.spawned++;
    return { proc: new EventEmitter(), port: Promise.resolve(12345), marker: "tok", startedAt: "start" };
  },
  isOpencodeServerPid: () => false,
  killOpencodeServerPid: async () => true,
  reapRecordedOpencodeServer: async () => { fake.reapCalls++; return fake.outcome; },
}));

import { OpencodeSession } from "./opencodeSession";
import { Ledger, closeAllLedgers } from "../domain/ledger";
import { SessionCoordinator } from "../domain/coordinator";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("takeover refuses a second server it could not rule out (#628 F29)", () => {
  let dir: string;
  let ledger: Ledger;
  let homeBefore: string | undefined;
  const sessions: OpencodeSession[] = [];
  const noop = () => {};

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "oc-f29-"));
    homeBefore = process.env.JOY_HOME_DIR;
    process.env.JOY_HOME_DIR = dir; // window records land here, not in ~/.joy
    ledger = Ledger.open(dir);
    fake.spawned = 0;
    fake.reapCalls = 0;
  });
  afterEach(() => {
    for (const s of sessions.splice(0)) s.end("restart");
    ledger.close(); closeAllLedgers();
    rmSync(dir, { recursive: true, force: true });
    if (homeBefore === undefined) delete process.env.JOY_HOME_DIR; else process.env.JOY_HOME_DIR = homeBefore;
  });

  function open(): OpencodeSession {
    const coordinator = new SessionCoordinator({ ledger });
    const s = new OpencodeSession(
      { id: "sess-f29", cwd: dir, status: "starting", startedAt: Date.now(), opencodeServerPid: 4242 },
      { ledger, coordinator, broadcast: noop, addChatMessage: noop } as never,
    );
    const relay = {
      relaySessionId: "sess-f29", outboundPersistDegraded: false,
      setReceiptSink: noop, start: noop, stop: noop, pausePull: noop,
      updateJoyState: noop, updateQueue: noop, setThinking: noop, updateModelCode: noop,
      updateContext: noop, updateSummary: noop, archive: async () => true, send: noop,
    };
    s.attachRelay(relay as never);
    sessions.push(s);
    s.beginWatching();
    return s;
  }

  it("an 'unknown' verdict is retried and then refused — no second server is spawned", async () => {
    fake.outcome = "unknown" satisfies ReapOutcome;
    const s = open();
    for (let i = 0; i < 200 && s.status !== "ended"; i++) await sleep(25);
    expect(s.status).toBe("ended");
    expect(fake.reapCalls).toBeGreaterThan(1); // retried, rather than giving up at once
    expect(fake.spawned).toBe(0);              // and never started one on top of it
  }, 20_000);

  it("a searched 'unowned' verdict does let a fresh server start", async () => {
    fake.outcome = "unowned" satisfies ReapOutcome;
    const s = open();
    for (let i = 0; i < 200 && fake.spawned === 0; i++) await sleep(25);
    expect(fake.spawned).toBe(1);
    expect(fake.reapCalls).toBe(1);
    s.end("restart");
  }, 20_000);
});
