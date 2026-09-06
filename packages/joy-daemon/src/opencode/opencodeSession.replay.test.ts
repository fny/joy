// #573 — OpenCode history replay omits every user prompt.
//
// Resuming an existing opencode conversation into a new Joy card published
// the turn start and the assistant's answer but never the question, so the
// imported history permanently lost the user's side. The replay projection is
// pure, so the whole record stream a card would receive is asserted here.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { historyReplay, messageText, replayPlan, userHistoryBackfill, REPLAY_PROJECTION_KIND, REPLAY_PROJECTION_VERSION } from "./opencodeSession";
import { Ledger, closeAllLedgers } from "../domain/ledger";

const SID = "ses_abc";
const user = (id: string, text: string, created: number) => ({
  id, type: "user", time: { created }, content: [{ id: `${id}_p0`, type: "text", text }],
});
const assistant = (id: string, text: string, created: number, finish = "stop") => ({
  id, type: "assistant", finish, time: { created }, content: [{ id: `${id}_p0`, type: "text", text }],
});
const kinds = (out: ReturnType<typeof historyReplay>) => out.emissions.map((e) => `${e.record.role}:${(e.record.content as any).type ?? "text"}`);

describe("opencode history replay (#573)", () => {
  it("replays the user's question, not just the answer", () => {
    const out = historyReplay(SID, [user("msg_u1", "why is it slow?", 100), assistant("msg_a1", "because of the cache", 200)]);
    const userRow = out.emissions.find((e) => e.record.role === "user");
    expect(userRow, "the imported conversation kept the user's side").toBeDefined();
    expect((userRow!.record.content as any).text).toBe("why is it slow?");
    expect(userRow!.localId).toBe(`oc:${SID}:msg_u1:user`);
    // …and it comes BEFORE the turn it opened.
    expect(out.emissions.indexOf(userRow!)).toBe(0);
    expect(out.emissions[1].localId).toBe(`oc:${SID}:msg_u1:turn-start`);
  });

  it("stamps the stored message time so the row lands in history, not 'now'", () => {
    const out = historyReplay(SID, [user("msg_u1", "hi", 12_345)]);
    expect((out.emissions[0].record.meta as any).joyTime).toBe(12_345);
  });

  it("uses a stable id, so replaying twice is idempotent at the relay", () => {
    const msgs = [user("msg_u1", "hi", 100), assistant("msg_a1", "hello", 200)];
    expect(historyReplay(SID, msgs).emissions.map((e) => e.localId))
      .toEqual(historyReplay(SID, msgs).emissions.map((e) => e.localId));
  });

  it("skips a prompt THIS daemon submitted — the app already has that row", () => {
    const msgs = [user("msg_ours", "from the app", 100), assistant("msg_a1", "sure", 200), user("msg_theirs", "typed in the TUI", 300)];
    const out = historyReplay(SID, msgs, { ourPrompt: (mid) => mid === "msg_ours" });
    const users = out.emissions.filter((e) => e.record.role === "user");
    expect(users.map((e) => (e.record.content as any).text)).toEqual(["typed in the TUI"]);
    // The skip is only the user ROW — the turn itself is still replayed.
    expect(out.emissions.some((e) => e.localId === `oc:${SID}:msg_ours:turn-start`)).toBe(true);
  });

  it("keeps the rest of the projection intact (turn start, answer, turn end, checkpoint)", () => {
    const out = historyReplay(SID, [user("msg_u1", "q", 100), assistant("msg_a1", "a", 200)]);
    expect(kinds(out)).toEqual(["user:text", "session:session", "session:session", "session:session"]);
    expect(out.emissions.map((e) => e.localId)).toEqual([
      `oc:${SID}:msg_u1:user`,
      `oc:${SID}:msg_u1:turn-start`,
      `oc:${SID}:msg_a1:msg_a1_p0:text`,
      `oc:${SID}:msg_u1:turn-end`,
    ]);
    expect(out.completedThrough).toBe("msg_a1");
    // The assistant text still mirrors into the daemon chat log; the user row
    // does not (the chat log carries the user's own sends already).
    expect(out.emissions.filter((e) => e.chat).map((e) => e.chat)).toEqual(["a"]);
  });

  it("leaves an unfinished assistant message past the checkpoint", () => {
    const out = historyReplay(SID, [user("msg_u1", "q", 100), { ...assistant("msg_a1", "partial", 200), finish: undefined }]);
    expect(out.completedThrough).toBeNull();
  });

  it("emits nothing for a user message with no text", () => {
    const out = historyReplay(SID, [{ id: "msg_u1", type: "user", time: { created: 1 }, content: [] }]);
    expect(out.emissions.map((e) => e.localId)).toEqual([`oc:${SID}:msg_u1:turn-start`]);
  });

  it("reads text from parts or a plain string body", () => {
    expect(messageText(user("m", "  hello  ", 1))).toBe("hello");
    expect(messageText({ content: "plain body" })).toBe("plain body");
    expect(messageText({ content: [{ type: "tool", id: "t" }] })).toBe("");
  });
});

// #573 residual (Astra on f5cf85a3): a card whose `opencode_msg` checkpoint a
// PRE-FIX daemon wrote — the answer replayed, the question omitted — never got
// its missing prompt, because messagesForReplay drops everything at or below
// the checkpoint before the projection runs. The projection is versioned now:
// a stored version older than the current one runs ONE backfill pass over the
// delivered history, emitting the missing user rows under their stable ids.
describe("opencode replay projection version (#573 residual)", () => {
  const LOCAL = "local-session";
  let dir: string;
  let ledger: Ledger;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "oc-replay-")); ledger = Ledger.open(dir, { now: () => 1_000 }); });
  afterEach(() => { ledger.close(); closeAllLedgers(); rmSync(dir, { recursive: true, force: true }); });

  /** What #reconcileHistory does with the ledger around replayPlan. */
  const reconcile = (all: Array<Record<string, unknown>>, ourPrompt?: (mid: string) => boolean) => {
    const plan = replayPlan(SID, all, {
      deliveredThrough: ledger.getCheckpoint(LOCAL, "opencode_msg")?.ref || undefined,
      projectionVersion: Number(ledger.getCheckpoint(LOCAL, REPLAY_PROJECTION_KIND)?.ref ?? 0) || 0,
      ourPrompt: ourPrompt ?? ((mid) => ledger.ownsRuntimeRef(LOCAL, mid, "opencode_msg")),
    });
    if (plan.completedThrough) ledger.setCheckpoint(LOCAL, "opencode_msg", plan.completedThrough, 0, { throughSeq: "latest" });
    if (plan.completedThrough || plan.projectionStale) ledger.setCheckpoint(LOCAL, REPLAY_PROJECTION_KIND, String(REPLAY_PROJECTION_VERSION), 0, { throughSeq: "latest" });
    return plan;
  };
  // The reviewer's fixture: question + finished answer, and a checkpoint an
  // older daemon wrote after replaying only the answer (no version row).
  const msgs = () => [user("u", "question", 1), assistant("a", "answer", 2)];
  const seedPreFixCheckpoint = () => ledger.setCheckpoint(LOCAL, "opencode_msg", "a", 0);

  it("a pre-fix checkpoint gets its missing question backfilled once; the next replay emits nothing", () => {
    seedPreFixCheckpoint();
    const first = reconcile(msgs());
    expect(first.projectionStale).toBe(true);
    expect(first.emissions.map((e) => e.localId)).toEqual([`oc:${SID}:u:user`]);
    expect((first.emissions[0].record.content as any).text).toBe("question");
    expect((first.emissions[0].record.meta as any).joyTime).toBe(1);
    // Nothing new completed, so the delivered mark stays put and the version is stamped on its own.
    expect(ledger.getCheckpoint(LOCAL, "opencode_msg")?.ref).toBe("a");
    expect(ledger.getCheckpoint(LOCAL, REPLAY_PROJECTION_KIND)?.ref).toBe(String(REPLAY_PROJECTION_VERSION));
    const second = reconcile(msgs());
    expect(second.projectionStale).toBe(false);
    expect(second.emissions).toEqual([]);
  });

  it("the backfill dedupes a prompt this daemon submitted, exactly like the live path", () => {
    seedPreFixCheckpoint();
    ledger.addReceipt(LOCAL, { kind: "opencode_msg", ref: "u" });
    const plan = reconcile(msgs());
    expect(plan.projectionStale).toBe(true);
    expect(plan.emissions).toEqual([]);
    // …and the pass is still marked done.
    expect(ledger.getCheckpoint(LOCAL, REPLAY_PROJECTION_KIND)?.ref).toBe(String(REPLAY_PROJECTION_VERSION));
    expect(reconcile(msgs()).projectionStale).toBe(false);
  });

  it("backfills only history at or below the checkpoint; the tail replays whole, in order", () => {
    seedPreFixCheckpoint();
    const all = [...msgs(), user("u2", "follow-up", 3), assistant("a2", "more", 4)];
    const plan = reconcile(all);
    expect(plan.emissions.map((e) => e.localId)).toEqual([
      `oc:${SID}:u:user`,
      `oc:${SID}:u2:user`,
      `oc:${SID}:u2:turn-start`,
      `oc:${SID}:a2:a2_p0:text`,
      `oc:${SID}:u2:turn-end`,
    ]);
    expect(plan.completedThrough).toBe("a2");
    expect(ledger.getCheckpoint(LOCAL, "opencode_msg")?.ref).toBe("a2");
    expect(reconcile(all).emissions).toEqual([]);
  });

  it("a checkpoint this daemon wrote carries the version, so a restart never backfills", () => {
    const first = reconcile(msgs());
    expect(first.emissions.map((e) => e.localId)).toContain(`oc:${SID}:u:user`);
    expect(ledger.getCheckpoint(LOCAL, "opencode_msg")?.ref).toBe("a");
    expect(ledger.getCheckpoint(LOCAL, REPLAY_PROJECTION_KIND)?.ref).toBe(String(REPLAY_PROJECTION_VERSION));
    const again = reconcile(msgs());
    expect(again.projectionStale).toBe(false);
    expect(again.emissions).toEqual([]);
  });

  it("an unknown checkpoint (server rewound) replays everything and needs no backfill", () => {
    ledger.setCheckpoint(LOCAL, "opencode_msg", "gone", 0);
    const plan = reconcile(msgs());
    expect(plan.emissions.filter((e) => e.localId.endsWith(":user")).map((e) => e.localId)).toEqual([`oc:${SID}:u:user`]);
    expect(plan.replayed).toBe(2);
  });

  it("userHistoryBackfill skips assistant messages, owned prompts and textless prompts", () => {
    const delivered = [user("mine", "app send", 1), assistant("a", "x", 2), { id: "blank", type: "user", time: { created: 3 }, content: [] }, user("tui", "typed in the TUI", 4)];
    const out = userHistoryBackfill(SID, delivered, { ourPrompt: (mid) => mid === "mine" });
    expect(out.map((e) => e.localId)).toEqual([`oc:${SID}:tui:user`]);
  });
});
