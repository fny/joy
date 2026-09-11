// joy ask on the daemon's send op: the wrapper says answer="inline" and
// carries no reply-to (one answer channel — the turn), and an ask that would
// close a cycle of open asks is refused as would_deadlock.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { machineOps, askCycle } from "./operations";
import { resetCoordinators } from "./coordinator";
import { fakeCoordinatedSession } from "./coordinator.fakeDriver";
import { closeAllLedgers } from "./ledger";
import { queueFor } from "./queueFacade";

const send = machineOps.find((o) => o.name === "send")!;
let home: string;
beforeAll(() => { home = mkdtempSync(join(tmpdir(), "joy-ops-ask-")); process.env.JOY_HOME_DIR = home; });
afterAll(() => { closeAllLedgers(); resetCoordinators(); delete process.env.JOY_HOME_DIR; rmSync(home, { recursive: true, force: true }); });

function twoSessions() {
  const c = fakeCoordinatedSession("cccc0001", { agent: "claude", cwd: "/tmp/c", extra: { claudeSessionId: "sc", detectPermissionMode: () => "bypassPermissions" } });
  const x = fakeCoordinatedSession("abcd0002", { agent: "claude", cwd: "/tmp/x", extra: { claudeSessionId: "sx", detectPermissionMode: () => "bypassPermissions" } });
  const chat: Array<Record<string, unknown>> = [];
  const registry = {
    get: (id: string) => (id === "cccc0001" ? c.s : id === "abcd0002" ? x.s : undefined),
    nextChatId: () => `chat-${chat.length + 1}`,
    addChatMessage: (m: Record<string, unknown>) => { chat.push(m); },
  };
  return { c, x, registry, chat };
}
const call = (registry: unknown, params: Record<string, unknown>) => send.handler(registry as never, params, { via: "http" }) as Promise<Record<string, unknown>> | Record<string, unknown>;

describe("send with ask: true", () => {
  it("wraps with answer=\"inline\" and no reply-to, even for a joy: sender", async () => {
    const { registry, chat } = twoSessions();
    const r = await call(registry, { session_id: "abcd0002", text: "what is 2+2?", from: "joy:cccc0001", ask: true });
    expect(r.ok).toBe(true);
    const content = String(chat.at(-1)!.content);
    expect(content).toMatch(/^<joy-message from="joy:cccc0001"[^>]* answer="inline">/);
    expect(content).not.toContain("reply-to=");
  });

  it("a plain send from a joy: sender still stamps reply-to and no answer attribute", async () => {
    const { registry, chat } = twoSessions();
    await call(registry, { session_id: "abcd0002", text: "fyi", from: "joy:cccc0001" });
    const content = String(chat.at(-1)!.content);
    expect(content).toContain('reply-to="joy:cccc0001"');
    expect(content).not.toContain("answer=");
  });

  it("refuses the ask that would close a cycle while the first ask is still open", async () => {
    const { registry, x } = twoSessions();
    const first = await call(registry, { session_id: "abcd0002", text: "C asks X", from: "joy:cccc0001", ask: true });
    expect(first.ok).toBe(true);
    // X, still holding C's open ask, asks C back: that turn cannot run until X's ends.
    const back = await call(registry, { session_id: "cccc0001", text: "X asks C", from: "joy:abcd0002", ask: true });
    expect(back).toMatchObject({ error: "would_deadlock", chain: ["joy:abcd0002", "joy:cccc0001", "joy:abcd0002"] });
    expect(String(back.message)).toContain("waiting on your turn");
    expect(send.httpShape!(back).status).toBe(409);
    // A plain send back is fine (it queues, nobody waits on it).
    expect((await call(registry, { session_id: "cccc0001", text: "noted", from: "joy:abcd0002" })).ok).toBe(true);
    // Once C's ask reaches a terminal state the guard lets X ask C.
    const qid = String(first.queued_id);
    queueFor(x.s as never).cancel?.(qid);
    const cmd = queueFor(x.s as never).command(qid);
    if (cmd && !["completed", "failed", "cancelled", "interrupted"].includes(String(cmd.state))) {
      // The fake driver may not cancel; retire the target so the ask is stale.
      x.coordinator.retire("abcd0002", "killed");
    }
    expect(askCycle(registry as never, "abcd0002", "cccc0001")).toBeNull();
  });
});
