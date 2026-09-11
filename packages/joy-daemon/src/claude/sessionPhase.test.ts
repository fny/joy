// The session phase machine, exhaustively: every (phase fixture, observation)
// pair has exactly one answer in EXPECTED — the phase the step lands in. A
// pair missing from the table fails, so a new observation or phase cannot be
// added without deciding it for every row. The scenario tests below pin the
// timed rules the table cannot: leases, poll counts, debounces, staleness.
import { test, expect, describe } from "vitest";
import {
  stepPhase, phaseOf, createPhaseState, turnClosedByHook, turnRunning, hookSaysIdle, transcriptOwnsTerminal,
  OBSERVATION_TYPES, PHASE_KINDS, HOOK_TIEBREAK_IDLE_POLLS, HOOKLESS_IDLE_POLLS, HOOK_NEEDS_INPUT_STALE_MS,
  type PhaseState, type Observation, type PaneRead, type Effect, type Phase,
} from "./sessionPhase";

const T = 1_000_000;
const FRAME = (over: Partial<PaneRead> = {}): PaneRead => ({ generating: false, readyPrompt: true, inputEmpty: true, dialog: null, login: null, ...over });
const GENERATING = FRAME({ generating: true, readyPrompt: false });
const IDLE_BOX = FRAME();
const AMBIGUOUS = FRAME({ readyPrompt: false }); // no box the parser can place
const TYPED_AHEAD = FRAME({ inputEmpty: false });
const PICKER = { title: "Select model", options: ["Opus", "Sonnet"], autoAnswer: null };
const CONFIRM = { title: "Switch model?", options: ["Yes", "No"], autoAnswer: ["Enter"] };
const LOGIN = { url: "https://claude.ai/oauth" };

// ── fixtures: one representative state per phase kind (busy twice, with and without hooks) ──
function fixture(name: string): PhaseState {
  const s = createPhaseState(name === "starting" ? "starting" : "active");
  switch (name) {
    case "starting": case "idle": return s;
    case "busy/hook":
      s.hooks = { live: true, since: T - 60_000 };
      s.hookTurn = { open: true, at: T - 1_000 };
      s.transcriptTurn = { since: T - 500 };
      s.thinking = { ...s.thinking, on: true, leaseUntil: T + 170_000 };
      return s;
    case "busy/transcript":
      s.transcriptTurn = { since: T - 500 };
      s.thinking = { ...s.thinking, on: true };
      return s;
    case "dialog": {
      const key = `${PICKER.title} ${PICKER.options.join(" ")}`;
      s.dialog = { observedKey: key, firstSeenAt: T - 6_000, answered: false, pendingKey: null, current: { title: PICKER.title, options: PICKER.options, since: T - 6_000 }, currentKey: key };
      return s;
    }
    case "needs_input":
      s.hooks = { live: true, since: T - 60_000 };
      s.hookTurn = { open: true, at: T - 5_000 };
      s.transcriptTurn = { since: T - 4_000 };
      s.wait = { kind: "permission", tool: "Bash", since: T - 3_000 };
      return s;
    case "login":
      s.login = { pendingUrl: null, current: { url: LOGIN.url, since: T - 6_000 } };
      return s;
    case "ended":
      return createPhaseState("ended", "killed");
  }
  throw new Error(`no fixture ${name}`);
}
const FIXTURES = ["starting", "idle", "busy/hook", "busy/transcript", "dialog", "needs_input", "login", "ended"] as const;

const OBS: Record<string, Observation> = {
  "pane(generating)": { type: "pane", at: T, read: GENERATING },
  "pane(idle box)": { type: "pane", at: T, read: IDLE_BOX },
  "pane(ambiguous)": { type: "pane", at: T, read: AMBIGUOUS },
  "pane(dialog)": { type: "pane", at: T, read: FRAME({ dialog: PICKER }) },
  "pane(dialog auto)": { type: "pane", at: T, read: FRAME({ dialog: CONFIRM }) },
  "pane(login)": { type: "pane", at: T, read: FRAME({ login: LOGIN }) },
  hooks_live: { type: "hooks_live", at: T },
  "hook_prompt(lease)": { type: "hook_prompt", at: T, leaseMs: 170_000 },
  "hook_prompt(no lease)": { type: "hook_prompt", at: T, leaseMs: 0 },
  hook_stop: { type: "hook_stop", at: T },
  "hook_tool_done(main)": { type: "hook_tool_done", at: T, agent: null },
  "hook_tool_done(agent)": { type: "hook_tool_done", at: T, agent: "a1" },
  "hook_permission(main)": { type: "hook_permission", at: T, tool: "Bash", agent: null },
  "hook_permission(agent)": { type: "hook_permission", at: T, tool: "Read", agent: "a1" },
  "hook_notification(permission_prompt)": { type: "hook_notification", at: T, kind: "permission_prompt" },
  "hook_notification(idle_prompt)": { type: "hook_notification", at: T, kind: "idle_prompt" },
  "hook_notification(elicitation)": { type: "hook_notification", at: T, kind: "elicitation_dialog" },
  "hook_notification(auth_success)": { type: "hook_notification", at: T, kind: "auth_success" },
  "hook_session_edge(start)": { type: "hook_session_edge", at: T, edge: "start" },
  "hook_session_edge(end)": { type: "hook_session_edge", at: T, edge: "end" },
  "transcript_turn(open)": { type: "transcript_turn", at: T, open: true },
  "transcript_turn(close)": { type: "transcript_turn", at: T, open: false },
  output: { type: "output", at: T },
  "thinking(on)": { type: "thinking", at: T, on: true },
  "thinking(off)": { type: "thinking", at: T, on: false },
  lease: { type: "lease", at: T, ms: 8_000 },
  escape: { type: "escape", at: T },
  "trust_prompt(keys)": { type: "trust_prompt", at: T, keys: ["Down", "Enter"] },
  "trust_prompt(unpainted)": { type: "trust_prompt", at: T, keys: null },
  activated: { type: "activated", at: T },
  ended: { type: "ended", at: T, reason: "process_exited" },
};

type Kind = Phase["kind"];
const same = (k: Kind): Record<string, Kind> => Object.fromEntries(Object.keys(OBS).map((o) => [o, k]));

const EXPECTED: Record<(typeof FIXTURES)[number], Record<string, Kind>> = {
  starting: {
    ...same("starting"),
    "pane(generating)": "busy",            // hook-less: the pane sets thinking
    "hook_prompt(lease)": "busy", "hook_prompt(no lease)": "busy",
    "hook_permission(main)": "needs_input", "hook_permission(agent)": "needs_input",
    "hook_notification(permission_prompt)": "needs_input", "hook_notification(elicitation)": "needs_input",
    "transcript_turn(open)": "busy",
    "thinking(on)": "busy",
    activated: "idle",
    ended: "ended",
  },
  idle: {
    ...same("idle"),
    "pane(generating)": "busy",
    "hook_prompt(lease)": "busy", "hook_prompt(no lease)": "busy",
    "hook_permission(main)": "needs_input", "hook_permission(agent)": "needs_input",
    "hook_notification(permission_prompt)": "needs_input", "hook_notification(elicitation)": "needs_input",
    "transcript_turn(open)": "busy",
    "thinking(on)": "busy",
    ended: "ended",
  },
  "busy/hook": {
    ...same("busy"),
    hook_stop: "idle",                                 // THE idle edge with hooks live
    "hook_notification(idle_prompt)": "idle",          // 60 s at the prompt: the hook turn closes
    "hook_permission(main)": "needs_input", "hook_permission(agent)": "needs_input",
    "hook_notification(permission_prompt)": "needs_input", "hook_notification(elicitation)": "needs_input",
    ended: "ended",
  },
  "busy/transcript": {
    ...same("busy"),
    "hook_permission(main)": "needs_input", "hook_permission(agent)": "needs_input",
    "hook_notification(permission_prompt)": "needs_input", "hook_notification(elicitation)": "needs_input",
    ended: "ended",
    // hook_stop / idle_prompt change nothing here: without hooks LIVE a
    // hook edge cannot close the transcript's turn (turnClosedByHook).
  },
  dialog: {
    ...same("dialog"),
    "pane(generating)": "busy",            // the dialog is gone from the frame; the pane sets thinking
    "pane(idle box)": "idle", "pane(ambiguous)": "idle",
    "pane(login)": "idle",                 // dialog gone; the login bar waits for its second sighting
    // pane(dialog): the same dialog, still up. pane(dialog auto): a NEW dialog
    // is auto-answered before the banner is touched — the old banner stays
    // until a frame without a dialog clears it.
    ended: "ended",
  },
  needs_input: {
    ...same("needs_input"),
    "hook_prompt(lease)": "busy", "hook_prompt(no lease)": "busy",
    hook_stop: "idle",
    "hook_tool_done(main)": "busy",        // the main agent's tool completed: the wait is answered
    "hook_session_edge(start)": "busy", "hook_session_edge(end)": "busy",
    escape: "busy",                        // Escape dismisses the prompt; the hook turn is still open
    ended: "ended",
    // hook_tool_done(agent): a subagent's tool answers only its own wait.
    // hook_notification(idle_prompt): idleness is not an answer.
  },
  login: {
    ...same("login"),
    "pane(generating)": "busy",
    "pane(idle box)": "idle", "pane(ambiguous)": "idle", "pane(dialog)": "idle", "pane(dialog auto)": "idle",
    ended: "ended",
  },
  ended: same("ended"),
};

describe("phase table", () => {
  test("every observation type and every phase kind is in the table", () => {
    const covered = new Set(Object.values(OBS).map((o) => o.type));
    for (const t of OBSERVATION_TYPES) expect(covered.has(t), `observation ${t} has no table column`).toBe(true);
    const kinds = new Set(FIXTURES.map((f) => phaseOf(fixture(f)).kind));
    for (const k of PHASE_KINDS) expect(kinds.has(k), `phase ${k} has no fixture`).toBe(true);
    for (const f of FIXTURES) for (const o of Object.keys(OBS)) expect(EXPECTED[f][o], `${f} × ${o} undecided`).toBeDefined();
  });
  for (const f of FIXTURES) {
    for (const o of Object.keys(OBS)) {
      test(`${f} × ${o} → ${EXPECTED[f][o]}`, () => {
        const before = fixture(f);
        const frozen = JSON.stringify(before);
        const { state } = stepPhase(before, OBS[o]);
        expect(phaseOf(state).kind).toBe(EXPECTED[f][o]);
        expect(JSON.stringify(before), "the step mutated its input").toBe(frozen);
      });
    }
  }
});

// ── scenarios: the timed rules ───────────────────────────────────────────────

function run(state: PhaseState, obs: Observation[]): { state: PhaseState; effects: Effect[] } {
  const effects: Effect[] = [];
  for (const o of obs) { const r = stepPhase(state, o); state = r.state; effects.push(...r.effects); }
  return { state, effects };
}
const thinks = (effects: Effect[]) => effects.filter((e): e is Extract<Effect, { type: "set_thinking" }> => e.type === "set_thinking").map((e) => `${e.on}:${e.via}`);
const polls = (from: number, n: number, read: PaneRead, gapMs = 3_000): Observation[] => Array.from({ length: n }, (_, i) => ({ type: "pane", at: from + i * gapMs, read }));

describe("hook-less: the pane is the ground truth, with hysteresis", () => {
  test("SET on one generating read, CLEAR only after two consecutive idle reads (status flapping, 2026-07-04)", () => {
    let r = run(fixture("idle"), polls(T, 1, GENERATING));
    expect(thinks(r.effects)).toEqual(["true:pane"]);
    r = run(r.state, polls(T + 3_000, 1, IDLE_BOX));
    expect(r.state.thinking.on).toBe(true);           // one idle read is a mid-repaint capture
    r = run(r.state, [...polls(T + 6_000, 1, GENERATING), ...polls(T + 9_000, 1, IDLE_BOX)]);
    expect(r.state.thinking.on).toBe(true);           // a generating read resets the count
    r = run(r.state, polls(T + 12_000, HOOKLESS_IDLE_POLLS, IDLE_BOX));
    expect(r.state.thinking.on).toBe(false);
    expect(thinks(r.effects)).toEqual(["false:pane"]);
  });
  test("inside a submit's lease the pane cannot clear thinking; past it, it can", () => {
    let r = run(fixture("idle"), [{ type: "thinking", at: T, on: true }, { type: "lease", at: T, ms: 170_000 }]);
    r = run(r.state, polls(T + 3_000, 10, IDLE_BOX));
    expect(r.state.thinking.on).toBe(true);
    r = run(r.state, polls(T + 170_001, HOOKLESS_IDLE_POLLS, IDLE_BOX));
    expect(r.state.thinking.on).toBe(false);
  });
  test("#636: a /clear earns no lease (leaseMs 0), so it reads idle after the ordinary two polls", () => {
    let r = run(fixture("idle"), [{ type: "thinking", at: T, on: true }, { type: "lease", at: T, ms: 0 }]);
    r = run(r.state, polls(T + 3_000, HOOKLESS_IDLE_POLLS, IDLE_BOX));
    expect(r.state.thinking.on).toBe(false);
  });
});

describe("hooks live: the pane never sets, and clears only as a tie-breaker", () => {
  const live = (): PhaseState => run(fixture("idle"), [{ type: "hooks_live", at: T - 60_000 }]).state;
  test("#479: a generating frame never sets thinking", () => {
    const r = run(live(), polls(T, 5, GENERATING));
    expect(r.state.thinking.on).toBe(false);
    expect(thinks(r.effects)).toEqual([]);
  });
  test("six consecutive idle-box reads past the lease clear thinking, with the tie-breaker log; a generating read in between resets the count", () => {
    let r = run(live(), [{ type: "hook_prompt", at: T, leaseMs: 0 }]);
    expect(thinks(r.effects)).toEqual(["true:hook"]);
    r = run(r.state, polls(T + 3_000, HOOK_TIEBREAK_IDLE_POLLS - 1, IDLE_BOX));
    expect(r.state.thinking.on).toBe(true);
    r = run(r.state, [...polls(T + 30_000, 1, GENERATING), ...polls(T + 33_000, HOOK_TIEBREAK_IDLE_POLLS - 1, IDLE_BOX)]);
    expect(r.state.thinking.on).toBe(true);
    r = run(r.state, polls(T + 60_000, HOOK_TIEBREAK_IDLE_POLLS, IDLE_BOX));
    expect(r.state.thinking.on).toBe(false);
    expect(r.state.thinking.clearedByTieBreaker).toBe(true);
    expect(thinks(r.effects)).toEqual(["false:tiebreaker"]);
    expect(r.effects.some((e) => e.type === "log" && /tie-breaker/.test(e.line))).toBe(true);
  });
  test("fny 4477e540: ambiguous frames and a box holding typed-ahead text count for nothing either way", () => {
    let r = run(live(), [{ type: "hook_prompt", at: T, leaseMs: 0 }]);
    r = run(r.state, [...polls(T + 3_000, 20, AMBIGUOUS), ...polls(T + 63_000, 20, TYPED_AHEAD)]);
    expect(r.state.thinking.on).toBe(true);
    expect(r.state.thinking.idlePolls).toBe(0);
  });
  test("the lease holds the tie-breaker off; six idle reads inside it change nothing, six past it clear", () => {
    let r = run(live(), [{ type: "hook_prompt", at: T, leaseMs: 170_000 }]);
    r = run(r.state, polls(T + 3_000, HOOK_TIEBREAK_IDLE_POLLS, IDLE_BOX));
    expect(r.state.thinking.on).toBe(true);
    r = run(r.state, polls(T + 170_001, HOOK_TIEBREAK_IDLE_POLLS, IDLE_BOX));
    expect(r.state.thinking.on).toBe(false);
  });
  test("#647: once the turn has produced output the lease no longer guards it — six idle reads clear inside the lease", () => {
    let r = run(live(), [{ type: "hook_prompt", at: T, leaseMs: 170_000 }, { type: "transcript_turn", at: T + 100, open: true }, { type: "output", at: T + 200 }]);
    r = run(r.state, polls(T + 3_000, HOOK_TIEBREAK_IDLE_POLLS, IDLE_BOX));
    expect(r.state.thinking.on).toBe(false);
  });
  test("output landing inside the open turn after a tie-breaker clear re-asserts thinking; after a Stop it does not", () => {
    let r = run(live(), [{ type: "hook_prompt", at: T, leaseMs: 0 }, { type: "transcript_turn", at: T + 100, open: true }]);
    r = run(r.state, polls(T + 3_000, HOOK_TIEBREAK_IDLE_POLLS, IDLE_BOX));
    expect(r.state.thinking.on).toBe(false);
    r = run(r.state, [{ type: "output", at: T + 30_000 }]);
    expect(r.state.thinking.on).toBe(true);
    expect(thinks(r.effects)).toEqual(["true:output"]);
    r = run(r.state, [{ type: "hook_stop", at: T + 31_000 }, { type: "output", at: T + 32_000 }]);
    expect(r.state.thinking.on).toBe(false);
  });
  test("PostToolUse is a refresh: it re-asserts thinking only inside an open transcript turn; a subagent's tool answers only its own wait", () => {
    let r = run(live(), [{ type: "hook_tool_done", at: T, agent: null }]);
    expect(r.state.thinking.on).toBe(false);
    r = run(r.state, [{ type: "transcript_turn", at: T + 1, open: true }, { type: "hook_tool_done", at: T + 2, agent: null }]);
    expect(r.state.thinking.on).toBe(true);
    r = run(r.state, [{ type: "hook_permission", at: T + 3, tool: "Bash", agent: null }, { type: "hook_tool_done", at: T + 4, agent: "sub" }]);
    expect(r.state.wait?.kind).toBe("permission");
    r = run(r.state, [{ type: "hook_permission", at: T + 5, tool: "Read", agent: "sub" }]);
    expect(r.state.wait?.tool).toBe("Bash"); // the main wait keeps its tool; the subagent's tool is not the main agent's
  });
});

describe("dialogs", () => {
  const withDialog = (d: PaneRead["dialog"]) => FRAME({ dialog: d });
  test("/effort wedge: a dialog on screen voids the lease and clears thinking at once", () => {
    let r = run(fixture("idle"), [{ type: "hook_prompt", at: T, leaseMs: 170_000 }]);
    r = run(r.state, [{ type: "pane", at: T + 3_000, read: withDialog(PICKER) }]);
    expect(r.state.thinking.on).toBe(false);
    expect(r.state.thinking.leaseUntil).toBe(0);
    expect(thinks(r.effects)).toEqual(["false:dialog"]);
  });
  test("the banner needs two sightings; dispatch confirmation runs on the first (verify round 3)", () => {
    let r = run(fixture("idle"), [{ type: "pane", at: T, read: withDialog(PICKER) }]);
    expect(r.state.dialog.current).toBeNull();
    expect(r.effects.map((e) => e.type)).toEqual(["confirm_dispatch_on_dialog"]);
    expect((r.effects[0] as { at: number }).at).toBe(T);
    r = run(r.state, [{ type: "pane", at: T + 3_000, read: withDialog(PICKER) }]);
    expect(r.state.dialog.current).toMatchObject({ title: "Select model", since: T });
    expect(r.effects.map((e) => e.type)).toEqual(["confirm_dispatch_on_dialog", "publish_dialog"]);
  });
  test("auto-answer (Switch model? / Change effort level?) fires once per sighting; a dialog still painted next poll publishes as before", () => {
    let r = run(fixture("idle"), [{ type: "pane", at: T, read: withDialog(CONFIRM) }]);
    expect(r.effects.map((e) => e.type)).toEqual(["confirm_dispatch_on_dialog", "auto_answer"]);
    r = run(r.state, [{ type: "pane", at: T + 3_000, read: withDialog(CONFIRM) }]);
    expect(r.effects.map((e) => e.type)).toEqual(["confirm_dispatch_on_dialog"]); // no second keystroke
    r = run(r.state, [{ type: "pane", at: T + 6_000, read: withDialog(CONFIRM) }]);
    expect(r.effects.map((e) => e.type)).toEqual(["confirm_dispatch_on_dialog", "publish_dialog"]);
    // Gone and back: a new sighting, answered again.
    r = run(r.state, [{ type: "pane", at: T + 9_000, read: IDLE_BOX }, { type: "pane", at: T + 12_000, read: withDialog(CONFIRM) }]);
    expect(r.effects.filter((e) => e.type === "auto_answer").length).toBe(1);
  });
  test("finding 6: the clear is asserted on EVERY dialog-less poll, and a resolved dialog kicks the drain once", () => {
    let r = run(fixture("dialog"), polls(T, 3, IDLE_BOX));
    expect(r.effects.filter((e) => e.type === "publish_dialog" && e.dialog === null).length).toBe(3);
    expect(r.effects.filter((e) => e.type === "drain").length).toBe(1);
  });
  test("ended clears the banner and publishes the clear; later frames are ignored", () => {
    let r = run(fixture("dialog"), [{ type: "ended", at: T, reason: "killed" }]);
    expect(r.state.dialog.current).toBeNull();
    expect(r.effects).toEqual([{ type: "publish_dialog", dialog: null }]);
    r = run(r.state, [{ type: "pane", at: T + 3_000, read: GENERATING }, { type: "hook_prompt", at: T + 4_000, leaseMs: 0 }]);
    expect(r.effects).toEqual([]);
    expect(phaseOf(r.state)).toEqual({ kind: "ended", reason: "killed" });
    // …but the teardown's own thinking clear and turn close still apply.
    r = run(r.state, [{ type: "thinking", at: T + 5_000, on: false }, { type: "transcript_turn", at: T + 5_000, open: false }]);
    expect(r.state.thinking.on).toBe(false);
    expect(r.state.transcriptTurn).toBeNull();
  });
});

describe("hook-reported waits", () => {
  const live = (): PhaseState => run(fixture("idle"), [{ type: "hooks_live", at: T - 60_000 }]).state;
  test("a permission wait goes stale only after the dialog has been continuously ABSENT for the window — a sighting in between restarts the clock", () => {
    let r = run(live(), [{ type: "hook_permission", at: T, tool: "Bash", agent: null }]);
    r = run(r.state, polls(T + 3_000, 3, IDLE_BOX));                       // absent 6 s
    r = run(r.state, [{ type: "pane", at: T + 12_000, read: FRAME({ dialog: PICKER }) }]); // back on screen
    r = run(r.state, polls(T + 15_000, 3, IDLE_BOX));                      // absent 6 s again
    expect(r.state.wait?.kind).toBe("permission");                         // 18 s old, but never absent > 10 s
    r = run(r.state, polls(T + 24_000, 2, IDLE_BOX));                      // absent 12 s > HOOK_NEEDS_INPUT_STALE_MS
    expect(HOOK_NEEDS_INPUT_STALE_MS).toBe(10_000);
    expect(r.state.wait).toBeNull();
  });
  test("one permission push per episode, whichever hook opened it", () => {
    let r = run(live(), [{ type: "hook_permission", at: T, tool: "Bash", agent: null }, { type: "hook_notification", at: T + 1, kind: "permission_prompt" }, { type: "hook_notification", at: T + 2, kind: "permission_prompt" }]);
    expect(r.effects.filter((e) => e.type === "notify_permission").length).toBe(1);
    r = run(r.state, [{ type: "hook_stop", at: T + 3 }, { type: "hook_notification", at: T + 4, kind: "permission_prompt" }]);
    expect(r.effects.filter((e) => e.type === "notify_permission").length).toBe(1); // a new episode
  });
  test("an idle_prompt is idleness, not a question: thinking off, hook turn closed, the wait untouched", () => {
    const r = run(fixture("needs_input"), [{ type: "hook_notification", at: T, kind: "idle_prompt" }]);
    expect(r.state.hookTurn).toEqual({ open: false, at: T });
    expect(r.state.wait?.kind).toBe("permission");
  });
});

describe("turn edges", () => {
  test("with hooks live a Stop after the transcript turn opened closes it; the transcript's later terminal is then a duplicate", () => {
    let r = run(fixture("idle"), [{ type: "hooks_live", at: T - 60_000 }, { type: "hook_prompt", at: T, leaseMs: 0 }, { type: "transcript_turn", at: T + 100, open: true }]);
    expect(turnRunning(r.state)).toBe(true);
    expect(hookSaysIdle(r.state)).toBe(false);
    expect(transcriptOwnsTerminal(r.state, T + 200, T - 1_000)).toBe(true);   // entry postdates the hook turn's opening
    expect(transcriptOwnsTerminal(r.state, T - 1, T - 1_000)).toBe(false);    // an entry from before it describes an older turn
    r = run(r.state, [{ type: "hook_stop", at: T + 500 }]);
    expect(turnClosedByHook(r.state)).toBe(true);
    expect(turnRunning(r.state)).toBe(false);
    expect(hookSaysIdle(r.state)).toBe(true);
    expect(transcriptOwnsTerminal(r.state, T + 600, T - 1_000)).toBe(false);
  });
  test("without hooks the transcript owns every terminal inside the tail window", () => {
    const s = fixture("busy/transcript");
    expect(transcriptOwnsTerminal(s, T, T - 1_000)).toBe(true);
    expect(transcriptOwnsTerminal(s, T - 120_000, T)).toBe(false);
  });
  test("the phase names its busy source: the hook turn outranks the transcript's, which outranks a dispatch, which outranks the flag", () => {
    expect(phaseOf(fixture("busy/hook"))).toEqual({ kind: "busy", source: "hook_turn" });
    expect(phaseOf(fixture("busy/transcript"))).toEqual({ kind: "busy", source: "transcript_turn" });
    expect(phaseOf(fixture("idle"), { dispatching: true })).toEqual({ kind: "busy", source: "dispatch" });
    expect(phaseOf(run(fixture("idle"), [{ type: "thinking", at: T, on: true }]).state)).toEqual({ kind: "busy", source: "thinking" });
  });
});

describe("login and trust", () => {
  test("the login bar is debounced on first sight, cleared the poll the form is gone, and an error change on the same URL publishes at once", () => {
    let r = run(fixture("idle"), [{ type: "pane", at: T, read: FRAME({ login: LOGIN }) }]);
    expect(r.state.login.current).toBeNull();
    r = run(r.state, [{ type: "pane", at: T + 3_000, read: FRAME({ login: LOGIN }) }]);
    expect(r.state.login.current).toMatchObject({ url: LOGIN.url, since: T + 3_000 });
    r = run(r.state, [{ type: "pane", at: T + 6_000, read: FRAME({ login: { ...LOGIN, error: "bad code" } }) }]);
    expect(r.effects.filter((e) => e.type === "publish_login")).toEqual([{ type: "publish_login", login: { url: LOGIN.url, since: T + 3_000, error: "bad code" } }]);
    r = run(r.state, [{ type: "pane", at: T + 9_000, read: IDLE_BOX }]);
    expect(r.effects).toEqual([{ type: "publish_login", login: null }, { type: "publish_dialog", dialog: null }]);
  });
  test("the trust prompt is answered once, only when its menu has painted", () => {
    let r = run(fixture("starting"), [{ type: "trust_prompt", at: T, keys: null }]);
    expect(r.effects).toEqual([]);
    r = run(r.state, [{ type: "trust_prompt", at: T + 700, keys: ["Down", "Enter"] }, { type: "trust_prompt", at: T + 1_400, keys: ["Down", "Enter"] }]);
    expect(r.effects).toEqual([{ type: "answer_trust", keys: ["Down", "Enter"] }]);
  });
});
