import { test, expect } from "vitest";
import { CodexSession } from "./codexSession";
import { clearCodexInbound } from "./codexInboundStore";
import { clearCheckpoint } from "./codexCheckpointStore";
import type { SessionDeps } from "../claude/session";

// gpt-5.6-sol M2 finding #3b: the relay's confirmed cursor can REDELIVER the
// same seq after a crash-before-cursor-persist. Spooling it twice would create
// a second turn. The spool dedupes by seq, so a redelivered seq is a no-op.

const deps: SessionDeps = { relayClient: null, broadcast: () => {}, addChatMessage: () => {} };

function freshSession(id: string): CodexSession {
  return new CodexSession(
    { id, tmuxWindow: "none", cwd: "/tmp", status: "starting", startedAt: 0 },
    deps,
  );
}

test("re-enqueuing the same relay seq does not spool a duplicate", () => {
  const id = `test-seqdedupe-${process.pid}`;
  clearCodexInbound(id); clearCheckpoint(id);
  const s = freshSession(id);
  s.enqueue("hello", { seq: 5, mirrorToRelay: false });
  s.enqueue("hello", { seq: 5, mirrorToRelay: false }); // redelivery of the same seq
  expect(s.queueState().pendingCount).toBe(1);
  s.enqueue("world", { seq: 6, mirrorToRelay: false }); // a genuinely new seq
  expect(s.queueState().pendingCount).toBe(2);
  clearCodexInbound(id); clearCheckpoint(id);
});
