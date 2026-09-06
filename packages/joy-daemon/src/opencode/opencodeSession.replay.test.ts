// #573 — OpenCode history replay omits every user prompt.
//
// Resuming an existing opencode conversation into a new Joy card published
// the turn start and the assistant's answer but never the question, so the
// imported history permanently lost the user's side. The replay projection is
// pure, so the whole record stream a card would receive is asserted here.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The session-level block below runs the real OpencodeSession start/reconcile
// path against a real SQLite ledger; only the opencode server + HTTP client
// are faked (history GET + the live event stream).
const fake = vi.hoisted(() => ({
  clients: [] as Array<{ listener?: (e: unknown) => void }>,
  history: null as null | ((sid: string) => Promise<Array<Record<string, unknown>>>),
}));
vi.mock("./opencodeClient", () => ({
  OpencodeClient: class {
    listener?: (e: unknown) => void;
    constructor() { fake.clients.push(this); }
    onEvent(fn: (e: unknown) => void) { this.listener = fn; }
    subscribeEvents() {}
    messages(sid: string) { return fake.history!(sid); }
    close() {}
  },
  spawnOpencodeServer: () => ({ proc: new EventEmitter(), port: Promise.resolve(12345) }),
  isOpencodeServerPid: () => false,
  killOpencodeServerPid: async () => true,
}));

import { OpencodeSession, historyReplay, messageText, replayPlan, userHistoryBackfill, REPLAY_PROJECTION_KIND, REPLAY_PROJECTION_VERSION } from "./opencodeSession";
import { Ledger, closeAllLedgers } from "../domain/ledger";
import { SessionCoordinator } from "../domain/coordinator";
import type { WireRecord } from "../relay/relay";

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
    if (plan.projectionStale) ledger.setCheckpoint(LOCAL, REPLAY_PROJECTION_KIND, String(REPLAY_PROJECTION_VERSION), 0, { throughSeq: "latest" });
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

// #573 residual, wave F10 (Astra on 294b4cf4): the live event subscription
// starts BEFORE the history fetch, and a live turn completing during (or
// after a failed) initial fetch stamped the projection version on its own —
// the backfill of the old prefix never ran, and the version it certified hid
// the missing question for good. Real OpencodeSession start + reconcile
// against a real SQLite ledger; only the server/client are faked.
describe("opencode backfill vs live delivery (#573 residual, wave F10)", () => {
  const LOCAL = "abcdef10";
  const OC = "ses_f10";
  const history = () => [user("u", "old question", 1), assistant("a", "old answer", 2)];
  const recent = () => [user("u2", "new question", 3), assistant("a2", "new answer", 4)];
  const tick = () => new Promise((r) => setTimeout(r, 5));
  const until = async (fn: () => boolean) => { for (let n = 0; n < 400; n++) { if (fn()) return; await tick(); } throw new Error("wait expired"); };

  let dir: string;
  let ledger: Ledger;
  let sessions: OpencodeSession[];
  let records: Array<{ record: WireRecord; id?: string }>;
  let homeBefore: string | undefined;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "oc-f10-"));
    homeBefore = process.env.JOY_HOME_DIR;
    process.env.JOY_HOME_DIR = dir; // window records land here, not in ~/.joy
    ledger = Ledger.open(dir);
    sessions = []; records = []; fake.clients = [];
    fake.history = async () => history();
    // A mark an older daemon wrote after replaying only the answer: the
    // question is behind it, and no version row exists.
    ledger.setCheckpoint(LOCAL, "opencode_msg", "a", 0);
  });
  afterEach(() => {
    for (const s of sessions) s.end("restart");
    ledger.close(); closeAllLedgers();
    rmSync(dir, { recursive: true, force: true });
    if (homeBefore === undefined) delete process.env.JOY_HOME_DIR; else process.env.JOY_HOME_DIR = homeBefore;
  });

  const noop = () => {};
  function open(): OpencodeSession {
    const coordinator = new SessionCoordinator({ ledger });
    const s = new OpencodeSession(
      { id: LOCAL, cwd: dir, status: "starting", startedAt: Date.now(), opencodeSessionId: OC },
      { ledger, coordinator, broadcast: noop, addChatMessage: noop } as any,
    );
    // A relay whose send() spools to the real outbox, so the pending-until-
    // acked checkpoint rule is the real one.
    const relay: any = {
      relaySessionId: LOCAL, outboundPersistDegraded: false,
      setReceiptSink: noop, start: noop, stop: noop, pausePull: noop,
      updateJoyState: noop, updateQueue: noop, setThinking: noop, updateModelCode: noop,
      updateContext: noop, updateSummary: noop, archive: async () => true,
      send(record: WireRecord, id?: string) {
        records.push({ record, id });
        ledger.enqueueOutbound([{ sessionId: LOCAL, kind: "output", runtimeEventId: id ?? `anon:${records.length}`, body: record, sealed: false }]);
      },
    };
    s.attachRelay(relay);
    sessions.push(s);
    s.beginWatching();
    return s;
  }
  const userRows = () => records.filter((r) => r.record.role === "user").map((r) => r.id);
  const ackAll = () => { for (const row of ledger.pendingOutbound(LOCAL)) ledger.ackOutbound(row.seq); };
  const restart = (s: OpencodeSession) => { s.end("restart"); ledger.close(); ledger = Ledger.open(dir); records = []; };
  const version = () => ledger.getCheckpoint(LOCAL, REPLAY_PROJECTION_KIND);
  /** The new turn arrives live: prompt admitted, one text part, finished. The
   *  prompt is THIS daemon's (an `opencode_msg` receipt), so the app already
   *  has its row — the live case the reviewer's fixture ran. */
  function completeLiveTurn(): void {
    ledger.addReceipt(LOCAL, { kind: "opencode_msg", ref: "u2" });
    let seq = 0;
    const emit = (type: string, data: Record<string, unknown>) =>
      fake.clients.at(-1)!.listener!({ type, id: `ev${++seq}`, durable: { seq, aggregateID: OC }, data: { sessionID: OC, ...data } });
    emit("session.next.prompt.admitted", { messageID: "u2" });
    emit("session.next.step.started", { assistantMessageID: "a2" });
    emit("session.next.text.ended", { assistantMessageID: "a2", textID: "a2_p0", text: "new answer" });
    emit("session.next.step.ended", { assistantMessageID: "a2", finish: "stop" });
  }

  it("a live turn completing while the history fetch is held does not certify the version; the old question is still backfilled once", async () => {
    let release!: (msgs: Array<Record<string, unknown>>) => void;
    let requested = false;
    fake.history = () => { requested = true; return new Promise((r) => { release = r; }); };
    let s = open();
    await until(() => requested);

    completeLiveTurn();
    ackAll();
    // Delivery moved on; the projection version did not.
    expect(ledger.getCheckpoint(LOCAL, "opencode_msg")?.ref).toBe("a2");
    expect(version()).toBeNull();
    expect(userRows()).toEqual([]);

    release([...history(), ...recent()]);
    await until(() => s.status === "active");
    // The pass ran against the boundary captured at fetch start ("a"): the
    // question behind it is backfilled, exactly once, and the live-advanced
    // mark is not rewound.
    expect(userRows()).toEqual([`oc:${OC}:u:user`]);
    expect(ledger.getCheckpoint(LOCAL, "opencode_msg")?.ref).toBe("a2");
    expect(version()).toMatchObject({ ref: "", pendingRef: String(REPLAY_PROJECTION_VERSION) });
    ackAll();
    expect(version()?.ref).toBe(String(REPLAY_PROJECTION_VERSION));

    restart(s);
    fake.history = async () => [...history(), ...recent()];
    s = open();
    await until(() => s.status === "active");
    expect(userRows()).toEqual([]);
  });

  it("a failed initial history GET leaves the migration pending through a live turn; the next successful reconcile backfills once", async () => {
    fake.history = async () => { throw new Error("503 history unavailable"); };
    let s = open();
    await until(() => s.status === "active");
    expect(version()).toBeNull();

    completeLiveTurn();
    ackAll();
    expect(ledger.getCheckpoint(LOCAL, "opencode_msg")?.ref).toBe("a2");
    expect(version()).toBeNull(); // still pending: nothing ran over the old prefix

    restart(s);
    fake.history = async () => [...history(), ...recent()];
    s = open();
    await until(() => s.status === "active");
    expect(userRows()).toEqual([`oc:${OC}:u:user`]);
    expect(version()).toMatchObject({ ref: "", pendingRef: String(REPLAY_PROJECTION_VERSION) });
    ackAll();
    expect(version()?.ref).toBe(String(REPLAY_PROJECTION_VERSION));

    restart(s);
    s = open();
    await until(() => s.status === "active");
    expect(userRows()).toEqual([]);
  });

  it("control: the normal recovery path backfills once, keeps the version pending until acked, and a later restart emits nothing", async () => {
    let s = open();
    await until(() => s.status === "active");
    expect(userRows()).toEqual([`oc:${OC}:u:user`]);
    expect(version()).toMatchObject({ ref: "", pendingRef: String(REPLAY_PROJECTION_VERSION) });

    // Reopened before the ack: the same stable id again, no second outbox row.
    restart(s);
    s = open();
    await until(() => s.status === "active");
    expect(userRows()).toEqual([`oc:${OC}:u:user`]);
    expect(ledger.pendingOutbound(LOCAL)).toHaveLength(1);
    ackAll();
    expect(version()?.ref).toBe(String(REPLAY_PROJECTION_VERSION));

    restart(s);
    s = open();
    await until(() => s.status === "active");
    expect(userRows()).toEqual([]);
  });
});

// #629 (seen by the #573 residual agent, out of its scope): the live path never
// mirrored a prompt typed in the opencode TUI. Such a prompt reached the card
// only through the history backfill, and only while the projection version
// was < 2 — once v2 was certified, every later TUI prompt stayed off the card
// until another backfill. The admission carries the prompt body, so the live
// path emits the user row itself: the replay's stable `oc:<sid>:<mid>:user`
// id, before the turn bracket, at the message's own time. A prompt this
// daemon submitted stays suppressed exactly as before (the app has its row).
describe("opencode live foreign prompt mirror (#629)", () => {
  const LOCAL = "abcdef29";
  const OC = "ses_629";
  const TYPED_AT = 1_700_000_000_000;
  const tick = () => new Promise((r) => setTimeout(r, 5));
  const until = async (fn: () => boolean) => { for (let n = 0; n < 400; n++) { if (fn()) return; await tick(); } throw new Error("wait expired"); };

  let dir: string;
  let ledger: Ledger;
  let sessions: OpencodeSession[];
  let records: Array<{ record: WireRecord; id?: string }>;
  let homeBefore: string | undefined;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "oc-629-"));
    homeBefore = process.env.JOY_HOME_DIR;
    process.env.JOY_HOME_DIR = dir;
    ledger = Ledger.open(dir);
    sessions = []; records = []; fake.clients = [];
    fake.history = async () => [];
  });
  afterEach(() => {
    for (const s of sessions) s.end("restart");
    ledger.close(); closeAllLedgers();
    rmSync(dir, { recursive: true, force: true });
    if (homeBefore === undefined) delete process.env.JOY_HOME_DIR; else process.env.JOY_HOME_DIR = homeBefore;
  });

  const noop = () => {};
  /** A resumed card (so the reconcile runs) against an opencode session with
   *  the given stored history; the relay stub spools to the real outbox. */
  async function open(history: Array<Record<string, unknown>> = []): Promise<OpencodeSession> {
    fake.history = async () => history;
    const coordinator = new SessionCoordinator({ ledger });
    const s = new OpencodeSession(
      { id: LOCAL, cwd: dir, status: "starting", startedAt: Date.now(), opencodeSessionId: OC },
      { ledger, coordinator, broadcast: noop, addChatMessage: noop } as any,
    );
    const relay: any = {
      relaySessionId: LOCAL, outboundPersistDegraded: false,
      setReceiptSink: noop, start: noop, stop: noop, pausePull: noop,
      updateJoyState: noop, updateQueue: noop, setThinking: noop, updateModelCode: noop,
      updateContext: noop, updateSummary: noop, archive: async () => true,
      send(record: WireRecord, id?: string) {
        records.push({ record, id });
        ledger.enqueueOutbound([{ sessionId: LOCAL, kind: "output", runtimeEventId: id ?? `anon:${records.length}`, body: record, sealed: false }]);
      },
    };
    s.attachRelay(relay);
    sessions.push(s);
    s.beginWatching();
    await until(() => s.status === "active");
    return s;
  }
  const ids = () => records.map((r) => r.id);
  const userRows = () => records.filter((r) => r.record.role === "user");
  const ackAll = () => { for (const row of ledger.pendingOutbound(LOCAL)) ledger.ackOutbound(row.seq); };
  const restart = (s: OpencodeSession) => { s.end("restart"); ledger.close(); ledger = Ledger.open(dir); records = []; };
  let seq = 0;
  const emit = (type: string, data: Record<string, unknown>) =>
    fake.clients.at(-1)!.listener!({ type, id: `ev${++seq}`, durable: { seq, aggregateID: OC }, data: { sessionID: OC, ...data } });
  /** The live events of a prompt: received, then admitted (both carry the
   *  body on 1.18.10), then the answer's first text. Unfinished on purpose:
   *  the turn's completion would move the delivered mark past it. */
  const livePrompt = (mid: string, text: string) => {
    emit("session.next.prompted", { messageID: mid, prompt: { text }, timestamp: TYPED_AT });
    emit("session.next.prompt.admitted", { messageID: mid, prompt: { text }, delivery: "queue", timestamp: TYPED_AT + 500 });
    emit("session.next.step.started", { assistantMessageID: `a_${mid}` });
    emit("session.next.text.ended", { assistantMessageID: `a_${mid}`, textID: `a_${mid}_p0`, text: "answer" });
  };
  /** The projection certified at the current version: whatever follows is
   *  the live path's doing, never a backfill's. */
  const certifyProjection = () => { ackAll(); expect(ledger.getCheckpoint(LOCAL, REPLAY_PROJECTION_KIND)?.ref).toBe(String(REPLAY_PROJECTION_VERSION)); };

  it("a prompt typed in the TUI lands as one user row — the replay's id, before its turn start, at its own time", async () => {
    await open();
    certifyProjection();
    livePrompt("u1", "typed in the TUI");
    expect(userRows().map((r) => r.id)).toEqual([`oc:${OC}:u1:user`]);
    expect((userRows()[0].record.content as any).text).toBe("typed in the TUI");
    expect((userRows()[0].record.meta as any).joyTime).toBe(TYPED_AT);
    expect(ids().indexOf(`oc:${OC}:u1:user`)).toBeLessThan(ids().indexOf(`oc:${OC}:u1:turn-start`));
  });

  it("a prompt this daemon submitted gets no extra row — the app already has it", async () => {
    await open();
    certifyProjection();
    // The admission's `opencode_msg` receipt is the ownership the replay
    // and the backfill check too (#573).
    ledger.addReceipt(LOCAL, { kind: "opencode_msg", ref: "u_mine" });
    livePrompt("u_mine", "from the app");
    expect(userRows()).toEqual([]);
    expect(ids()).toContain(`oc:${OC}:u_mine:turn-start`);
  });

  it("the reconcile after a live mirror emits the same id — one outbox row, never a second bubble", async () => {
    let s = await open();
    certifyProjection();
    livePrompt("u1", "typed in the TUI");
    expect(userRows().map((r) => r.id)).toEqual([`oc:${OC}:u1:user`]);
    expect(ledger.pendingOutbound(LOCAL).filter((r) => r.runtimeEventId === `oc:${OC}:u1:user`)).toHaveLength(1);

    // Restart before the turn finished: the delivered mark is still behind
    // the prompt, so the replay projects it again — under the same id.
    restart(s);
    s = await open([user("u1", "typed in the TUI", TYPED_AT), { ...assistant("a_u1", "answer", TYPED_AT + 1000), finish: undefined }]);
    expect(userRows().map((r) => r.id)).toEqual([`oc:${OC}:u1:user`]);
    expect(ledger.pendingOutbound(LOCAL).filter((r) => r.runtimeEventId === `oc:${OC}:u1:user`)).toHaveLength(1);
  });
});
