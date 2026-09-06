// #573 — OpenCode history replay omits every user prompt.
//
// Resuming an existing opencode conversation into a new Joy card published
// the turn start and the assistant's answer but never the question, so the
// imported history permanently lost the user's side. The replay projection is
// pure, so the whole record stream a card would receive is asserted here.
import { describe, it, expect } from "vitest";
import { historyReplay, messageText } from "./opencodeSession";

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
