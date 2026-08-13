// OpencodeNormalizer unit tests. Event shapes mirror live captures from
// opencode 1.18.10 (`src/opencode/__fixtures__/daemon-path-proof.mjs` runs the
// same flow against a real server).
import { describe, it, expect } from "vitest";
import { OpencodeNormalizer, type OpencodeEffect } from "./normalize";
import type { OpencodeEvent } from "./opencodeClient";

const SID = "ses_test";
const AMID = "msg_asst1";

let seqCounter = 0;
function ev(type: string, data: Record<string, unknown>, opts?: { seq?: number; sid?: string }): OpencodeEvent {
  const seq = opts?.seq ?? ++seqCounter;
  return {
    id: `evt_${seq}`,
    type,
    durable: { aggregateID: opts?.sid ?? SID, seq },
    data: { sessionID: opts?.sid ?? SID, ...data },
  };
}

function kinds(effects: OpencodeEffect[]): string[] {
  return effects.map((e) => e.kind);
}
function wireTypes(effects: OpencodeEffect[]): string[] {
  return effects
    .filter((e): e is Extract<OpencodeEffect, { kind: "wire" }> => e.kind === "wire")
    .map((e) => (e.record.content as { data?: { ev?: { t?: string } } })?.data?.ev?.t ?? "?");
}

function freshNorm(): OpencodeNormalizer {
  seqCounter = 0;
  return new OpencodeNormalizer(SID);
}

describe("OpencodeNormalizer", () => {
  it("prompt.admitted opens the turn: confirm + thinking + turn-start", () => {
    const n = freshNorm();
    const fx = n.handle(ev("session.next.prompt.admitted", { messageID: "msg_user1", delivery: "queue" }));
    expect(kinds(fx)).toEqual(["confirmPrompt", "thinking", "wire"]);
    expect(wireTypes(fx)).toEqual(["turn-start"]);
    expect(n.currentTurn).toBe("msg_user1");
  });

  it("filters other sessions and dedupes by durable.seq", () => {
    const n = freshNorm();
    expect(n.handle(ev("session.next.prompt.admitted", { messageID: "msg_x" }, { sid: "ses_other" }))).toEqual([]);
    const first = ev("session.next.prompt.admitted", { messageID: "msg_user1" }, { seq: 5 });
    expect(n.handle(first)).toHaveLength(3);
    // SSE reconnect replays the same event — must be silent.
    expect(n.handle(first)).toEqual([]);
    expect(n.handle(ev("session.next.text.ended", { assistantMessageID: AMID, textID: "text-0", text: "late" }, { seq: 3 }))).toEqual([]);
  });

  it("full tool turn emits the claude-shaped sequence with stable localIds", () => {
    const n = freshNorm();
    n.handle(ev("session.next.prompt.admitted", { messageID: "msg_user1" }));
    expect(n.handle(ev("session.next.step.started", { assistantMessageID: AMID, model: { id: "accounts/fireworks/models/kimi-k3", providerID: "fireworks-ai" } })))
      .toEqual([{ kind: "model", code: "accounts/fireworks/models/kimi-k3" }]);

    const call = n.handle(ev("session.next.tool.called", { assistantMessageID: AMID, callID: "bash_0", tool: "bash", input: { command: "echo hi" } }));
    expect(wireTypes(call)).toEqual(["tool-call-start"]);
    expect((call[0] as { localId: string }).localId).toBe(`oc:${SID}:${AMID}:bash_0:tool-start`);

    const done = n.handle(ev("session.next.tool.success", { assistantMessageID: AMID, callID: "bash_0" }));
    expect(wireTypes(done)).toEqual(["tool-call-end"]);
    expect((done[0] as { localId: string }).localId).toBe(`oc:${SID}:${AMID}:bash_0:tool-end`);

    // Intermediate step: turn continues.
    expect(n.handle(ev("session.next.step.ended", { assistantMessageID: AMID, finish: "tool-calls" }))).toEqual([]);

    const text = n.handle(ev("session.next.text.ended", { assistantMessageID: "msg_asst2", textID: "text-0", text: "done" }));
    expect(wireTypes(text)).toEqual(["text"]);
    expect((text[0] as { localId: string }).localId).toBe(`oc:${SID}:msg_asst2:text-0:text`);

    // Terminal step: context gauge from tokens + turnDone.
    expect(n.handle(ev("session.next.step.ended", { assistantMessageID: "msg_asst2", finish: "stop", tokens: { input: 2615, output: 28, cache: { read: 100, write: 0 } } })))
      .toEqual([{ kind: "context", tokens: 2715 }, { kind: "turnDone", finish: "stop" }]);
  });

  it("step.failed / session.error → turnFailed with the provider message", () => {
    const n = freshNorm();
    n.handle(ev("session.next.prompt.admitted", { messageID: "msg_user1" }));
    expect(n.handle(ev("session.next.step.failed", { assistantMessageID: AMID, error: { type: "unknown", message: "HTTP 401" } })))
      .toEqual([{ kind: "turnFailed", message: "HTTP 401" }]);
    // No open turn (idempotent after session-side endTurn): silent.
    n.setTurn(null);
    expect(n.handle(ev("session.error", { error: { message: "boom" } }))).toEqual([]);
  });

  it("deltas and reasoning are silent (whole-block policy)", () => {
    const n = freshNorm();
    n.handle(ev("session.next.prompt.admitted", { messageID: "msg_user1" }));
    for (const t of ["session.next.text.started", "session.next.text.delta", "session.next.reasoning.started", "session.next.reasoning.delta", "session.next.reasoning.ended", "session.next.tool.input.delta"]) {
      expect(n.handle(ev(t, { assistantMessageID: AMID }))).toEqual([]);
    }
  });

  it("orphan text (no open turn) still surfaces under a synthetic turn", () => {
    const n = freshNorm();
    const fx = n.handle(ev("session.next.text.ended", { assistantMessageID: AMID, textID: "text-0", text: "hi" }));
    expect(wireTypes(fx)).toEqual(["text"]);
    expect((fx[0] as { localId: string }).localId).toBe(`oc:${SID}:${AMID}:text-0:text`);
  });

  it("closeOpenTools ends leftover tool cards", () => {
    const n = freshNorm();
    n.handle(ev("session.next.prompt.admitted", { messageID: "msg_user1" }));
    n.handle(ev("session.next.tool.called", { assistantMessageID: AMID, callID: "bash_0", tool: "bash", input: {} }));
    const fx = n.closeOpenTools();
    expect(wireTypes(fx)).toEqual(["tool-call-end"]);
    expect(n.closeOpenTools()).toEqual([]);
  });
});

describe("steer-into-open-turn", () => {
  it("admission while a turn is open confirms delivery without a second turn", () => {
    const n = freshNorm();
    const first = n.handle(ev("session.next.prompt.admitted", { messageID: "msg_user1", delivery: "steer" }));
    expect(wireTypes(first)).toEqual(["turn-start"]);
    // steered message joins the RUNNING turn: no turn-start, no thinking toggle
    const steer = n.handle(ev("session.next.prompt.admitted", { messageID: "msg_user2", delivery: "steer" }));
    expect(steer).toEqual([{ kind: "confirmPrompt", messageID: "msg_user2" }]);
    expect(n.currentTurn).toBe("msg_user1");
    // output continues under the original turn
    const text = n.handle(ev("session.next.text.ended", { assistantMessageID: AMID, textID: "text-0", text: "done with banana" }));
    expect(wireTypes(text)).toEqual(["text"]);
    expect(n.currentTurn).toBe("msg_user1");
  });
});

// ── messagesForReplay (reconcile ordering + checkpoint) ─────────────────────
import { messagesForReplay } from "./opencodeSession";

describe("messagesForReplay", () => {
  // GET /message returns NEWEST-first (verified live 2026-08-02).
  const history = [
    { id: "msg_a2", type: "assistant", finish: "stop", time: { created: 400 } },
    { id: "msg_u2", type: "user", time: { created: 300 } },
    { id: "msg_a1", type: "assistant", finish: "stop", time: { created: 200 } },
    { id: "msg_u1", type: "user", time: { created: 100 } },
  ];

  it("orders oldest-first regardless of server order", () => {
    expect(messagesForReplay(history).map((m) => m.id)).toEqual(["msg_u1", "msg_a1", "msg_u2", "msg_a2"]);
  });

  it("drops everything at or before the checkpoint", () => {
    expect(messagesForReplay(history, "msg_a1").map((m) => m.id)).toEqual(["msg_u2", "msg_a2"]);
    // checkpoint at the newest message → nothing to replay
    expect(messagesForReplay(history, "msg_a2")).toEqual([]);
  });

  it("unknown checkpoint (foreign session / rewound history) → full replay", () => {
    expect(messagesForReplay(history, "msg_gone").map((m) => m.id)).toEqual(["msg_u1", "msg_a1", "msg_u2", "msg_a2"]);
  });
});

describe("normalizer lastMessageId (checkpoint source)", () => {
  it("tracks the newest user/assistant id across a turn", () => {
    const n = new OpencodeNormalizer(SID);
    seqCounter = 0;
    expect(n.lastMessageId).toBeNull();
    n.handle(ev("session.next.prompt.admitted", { messageID: "msg_user1" }));
    expect(n.lastMessageId).toBe("msg_user1");
    n.handle(ev("session.next.step.started", { assistantMessageID: "msg_asst1", model: { id: "m" } }));
    expect(n.lastMessageId).toBe("msg_asst1");
    n.handle(ev("session.next.step.started", { assistantMessageID: "msg_asst2", model: { id: "m" } }));
    expect(n.lastMessageId).toBe("msg_asst2");
  });
});

// ── pickNewestSessionForCwd (continue) ──────────────────────────────────────
import { pickNewestSessionForCwd } from "./opencodeSession";

describe("pickNewestSessionForCwd", () => {
  const sessions = [
    { id: "ses_other", location: { directory: "/other/dir" }, time: { created: 1, updated: 900 } },
    { id: "ses_old", location: { directory: "/my/dir" }, time: { created: 1, updated: 100 } },
    { id: "ses_new", location: { directory: "/my/dir" }, time: { created: 2, updated: 500 } },
  ];

  it("picks the newest session in the SAME directory only", () => {
    // ses_other is globally newest — the directory filter must exclude it
    // (non-git dirs share opencode's "global" project).
    expect(pickNewestSessionForCwd(sessions, "/my/dir")).toBe("ses_new");
  });

  it("returns null when the cwd has no sessions", () => {
    expect(pickNewestSessionForCwd(sessions, "/fresh/dir")).toBeNull();
    expect(pickNewestSessionForCwd([], "/my/dir")).toBeNull();
  });

  it("falls back to time.created when updated is absent", () => {
    const s = [
      { id: "a", location: { directory: "/d" }, time: { created: 10 } },
      { id: "b", location: { directory: "/d" }, time: { created: 20 } },
    ];
    expect(pickNewestSessionForCwd(s, "/d")).toBe("b");
  });
});

// ── titleFromPrompt (auto-title) ────────────────────────────────────────────
import { titleFromPrompt } from "./opencodeSession";

describe("titleFromPrompt", () => {
  it("first line, whitespace collapsed", () => {
    expect(titleFromPrompt("  Fix the login bug\nand also tests ")).toBe("Fix the login bug");
    expect(titleFromPrompt("a   b\t c")).toBe("a b c");
  });
  it("clips long prompts on a word boundary with ellipsis", () => {
    const t = titleFromPrompt("Please refactor the authentication middleware to support rotating JWT signing keys");
    expect(t.length).toBeLessThanOrEqual(61);
    expect(t.endsWith("…")).toBe(true);
    expect(t).not.toMatch(/\s…$/);
  });
});

// ── extractJoyTitle + title effect ──────────────────────────────────────────
import { extractJoyTitle } from "./normalize";

describe("agent titles (<joy-title/>)", () => {
  it("extracts the title and strips the tag line", () => {
    const r = extractJoyTitle('Working on it.\n<joy-title value="Fix login flow" />\nDone.');
    expect(r.title).toBe("Fix login flow");
    expect(r.text).toBe("Working on it.\nDone.");
  });
  it("last tag wins; tag-only text leaves empty text", () => {
    const r = extractJoyTitle('<joy-title value="First" />\n<joy-title value="Second" />');
    expect(r.title).toBe("Second");
    expect(r.text).toBe("");
  });
  it("no tag → untouched", () => {
    expect(extractJoyTitle("plain text")).toEqual({ title: null, text: "plain text" });
  });
  it("normalizer emits a title effect and clean text", () => {
    const n = freshNorm();
    n.handle(ev("session.next.prompt.admitted", { messageID: "msg_user1" }));
    const fx = n.handle(ev("session.next.text.ended", { assistantMessageID: AMID, textID: "text-0", text: 'Created the file.\n<joy-title value="Create hello file" />' }));
    expect(fx[0]).toEqual({ kind: "title", value: "Create hello file" });
    expect(wireTypes(fx)).toEqual(["text"]);
  });
  it("tag-only reply emits ONLY the title (no empty text wire)", () => {
    const n = freshNorm();
    n.handle(ev("session.next.prompt.admitted", { messageID: "msg_user1" }));
    const fx = n.handle(ev("session.next.text.ended", { assistantMessageID: AMID, textID: "text-1", text: '<joy-title value="Just a title" />' }));
    expect(fx).toEqual([{ kind: "title", value: "Just a title" }]);
  });
});

// ── parseJoyTags (shared codex/opencode tag parser) ─────────────────────────
import { parseJoyTags } from "../domain/agentTagsPrompt";

describe("parseJoyTags", () => {
  it("title + notify + clean text", () => {
    const r = parseJoyTags('Deployed it.\n<joy-title value="Ship the deploy" />\n<joy-notify message="Deploy finished" detail="staging green" />\nAll done.');
    expect(r.title).toBe("Ship the deploy");
    expect(r.notifies).toEqual([{ headline: "Deploy finished", detail: "staging green" }]);
    expect(r.text).toBe("Deployed it.\nAll done.");
  });
  it("notify without detail", () => {
    const r = parseJoyTags('<joy-notify message="Need a decision" />');
    expect(r.notifies).toEqual([{ headline: "Need a decision", detail: null }]);
    expect(r.text).toBe("");
  });
  it("no tags → untouched fast path", () => {
    expect(parseJoyTags("plain")).toEqual({ title: null, notifies: [], text: "plain" });
  });
});
