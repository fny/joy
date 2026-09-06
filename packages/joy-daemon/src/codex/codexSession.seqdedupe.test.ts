import { test, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { CodexSession } from "./codexSession";
import { ledgerFor } from "../domain/ledger";
import type { SessionDeps } from "../claude/session";

// gpt-5.6-sol M2 finding #3b: the relay's confirmed cursor can REDELIVER the
// same seq after a crash-before-cursor-persist. Accepting it twice would create
// a second turn. The ledger dedupes by (session, seq), so a redelivered seq is
// the same command.

let home: string;
beforeAll(() => { home = mkdtempSync(join(tmpdir(), "joy-codex-seqdedupe-")); process.env.JOY_HOME_DIR = home; });
afterAll(() => { delete process.env.JOY_HOME_DIR; rmSync(home, { recursive: true, force: true }); });

const deps: SessionDeps = { relayClient: null, broadcast: () => {}, addChatMessage: () => {} };

function freshSession(id: string): CodexSession {
  return new CodexSession(
    { id, tmuxWindow: "none", cwd: "/tmp", status: "starting", startedAt: 0 },
    deps,
  );
}

test("re-enqueuing the same relay seq does not queue a duplicate", () => {
  const id = `test-seqdedupe-${process.pid}`;
  const s = freshSession(id);
  const a = s.enqueue("hello", { seq: 5, mirrorToRelay: false });
  const b = s.enqueue("hello", { seq: 5, mirrorToRelay: false }); // redelivery of the same seq
  expect(b.id).toBe(a.id);
  expect(s.queueState().pendingCount).toBe(1);
  s.enqueue("world", { seq: 6, mirrorToRelay: false }); // a genuinely new seq
  expect(s.queueState().pendingCount).toBe(2);
  expect(ledgerFor().listPending(id).map((r) => r.seq)).toEqual([5, 6]);
  s.end("killed");
  expect(ledgerFor().listPending(id)).toEqual([]); // a killed session will never deliver
});
