// The OpenCode resume machine, exhaustively: every (phase, origin, event)
// triple has exactly one answer here. A triple missing from EXPECTED fails
// the test, so a new event, phase or origin cannot be added without deciding
// it for every row. Then the rules that live across events: the preamble is
// owed once, the auto-title fires once and never for a resumed card, a
// /title lock beats the agent, a continue that finds nothing runs fresh.
import { test, expect } from "vitest";
import {
  nextResumeState, initialResumeState, RESUME_PHASES, RESUME_EVENT_TYPES,
  type ResumeEvent, type ResumeOrigin, type ResumePhase, type ResumeState, type ResumeEffect,
} from "./opencodeResume";

const EVENTS: Record<string, ResumeEvent> = {
  begin: { type: "begin" },
  server_up: { type: "server_up" },
  session_found: { type: "session_found", ocSessionId: "oc-found" },
  session_missing: { type: "session_missing" },
  session_created: { type: "session_created", ocSessionId: "oc-new" },
  prompt_out: { type: "prompt_out" },
  prompt_accepted: { type: "prompt_accepted" },
  joy_prompt: { type: "joy_prompt" },
  "title_command(text)": { type: "title_command", text: "Fix the build" },
  "title_command(bare)": { type: "title_command", text: null },
  agent_title: { type: "agent_title", value: "From the agent" },
  ended: { type: "ended" },
};
const ORIGINS: readonly ResumeOrigin[] = ["resume", "continue", "fresh"];

type Answer = null | { phase: ResumePhase; origin?: ResumeOrigin; oc?: string | null; effects?: ResumeEffect["type"][]; titled?: boolean; locked?: boolean; preamble?: boolean; backfill?: boolean };
const NEVER: Record<string, Answer> = Object.fromEntries(Object.keys(EVENTS).map((k) => [k, null]));

/** The rows every live phase answers the same way (titles, preamble, end),
 *  from a state that is untitled, unlocked and owes no preamble. */
const LIVE = (phase: ResumePhase, origin: ResumeOrigin): Record<string, Answer> => ({
  ended: { phase: "ended" },
  "title_command(text)": { phase, effects: ["set_title"], locked: true },
  "title_command(bare)": { phase, effects: ["set_title"], locked: false },
  agent_title: { phase, effects: ["apply_title"] },
  joy_prompt: { phase },
  prompt_out: { phase },
  prompt_accepted: origin === "resume" ? { phase, titled: true } : { phase, effects: ["auto_title"], titled: true },
});

const EXPECTED: Record<ResumePhase, (origin: ResumeOrigin) => Record<string, Answer>> = {
  unstarted: (o) => ({ ...NEVER, ...LIVE("unstarted", o), begin: { phase: "booting" } }),
  booting: (o) => ({
    ...NEVER, ...LIVE("booting", o),
    server_up: o === "resume" ? { phase: "bound", oc: "oc-resume", effects: ["resume", "backfill"], backfill: true }
      : o === "continue" ? { phase: "binding", effects: ["lookup"] }
        : { phase: "binding", effects: ["create"] },
  }),
  binding: (o) => ({
    ...NEVER, ...LIVE("binding", o),
    session_found: o === "continue" ? { phase: "bound", oc: "oc-found", effects: ["backfill"], backfill: true } : null,
    session_missing: o === "continue" ? { phase: "binding", origin: "fresh", effects: ["create"] } : null,
    session_created: o === "fresh" ? { phase: "bound", oc: "oc-new", preamble: true } : null,
  }),
  bound: (o) => ({ ...NEVER, ...LIVE("bound", o) }),
  ended: () => ({ ...NEVER }),
};

const stateFor = (phase: ResumePhase, origin: ResumeOrigin): ResumeState => ({
  phase, origin,
  ocSessionId: origin === "resume" ? "oc-resume" : phase === "bound" ? "oc-x" : null,
  titled: origin === "resume", titleLocked: false, preambleOwed: false, backfill: false,
});

test("every (phase, origin, event) triple is decided, and decided as the table says", () => {
  expect(new Set(Object.values(EVENTS).map((e) => e.type))).toEqual(new Set(RESUME_EVENT_TYPES));
  for (const phase of RESUME_PHASES) {
    for (const origin of ORIGINS) {
      if (phase === "binding" && origin === "resume") continue; // resume never looks anything up
      const table = EXPECTED[phase](origin);
      for (const [name, ev] of Object.entries(EVENTS)) {
        expect(name in table, `${phase}/${origin} × ${name} is not decided`).toBe(true);
        const want = table[name];
        const got = nextResumeState(stateFor(phase, origin), ev);
        const label = `${phase}/${origin} × ${name}`;
        if (want === null) { expect(got, label).toBeNull(); continue; }
        expect(got, label).not.toBeNull();
        expect(got!.to.phase, label).toBe(want.phase);
        expect((got!.effects ?? []).map((e) => e.type), label).toEqual(want.effects ?? []);
        if (want.origin !== undefined) expect(got!.to.origin, label).toBe(want.origin);
        if (want.oc !== undefined) expect(got!.to.ocSessionId, label).toBe(want.oc);
        if (want.titled !== undefined) expect(got!.to.titled, label).toBe(want.titled);
        if (want.locked !== undefined) expect(got!.to.titleLocked, label).toBe(want.locked);
        if (want.preamble !== undefined) expect(got!.to.preambleOwed, label).toBe(want.preamble);
        if (want.backfill !== undefined) expect(got!.to.backfill, label).toBe(want.backfill);
      }
    }
  }
});

test("construction: a resume keeps its rows and its title; anything else interrupts what an earlier session left pending", () => {
  expect(initialResumeState({ resumeId: "oc-1" })).toEqual({ state: { phase: "unstarted", origin: "resume", ocSessionId: "oc-1", titled: true, titleLocked: false, preambleOwed: false, backfill: false }, interruptPendingRows: false });
  expect(initialResumeState({ continueLast: true }).state.origin).toBe("continue");
  expect(initialResumeState({ continueLast: true }).interruptPendingRows).toBe(true);
  expect(initialResumeState({}).state).toMatchObject({ origin: "fresh", titled: false });
  expect(initialResumeState({ titleLocked: true }).state.titleLocked).toBe(true);
  // A resume id wins over continue.
  expect(initialResumeState({ resumeId: "oc-1", continueLast: true }).state.origin).toBe("resume");
});

const walk = (s: ResumeState, evs: ResumeEvent[]): { state: ResumeState; effects: ResumeEffect[] } => {
  const effects: ResumeEffect[] = [];
  for (const ev of evs) { const t = nextResumeState(s, ev); expect(t, ev.type).not.toBeNull(); s = t!.to; effects.push(...(t!.effects ?? [])); }
  return { state: s, effects };
};

test("a fresh session: created on the server, the first prompt carries the preamble once, the first accepted prompt titles the card once", () => {
  const { state } = initialResumeState({});
  const r = walk(state, [EVENTS.begin, EVENTS.server_up, EVENTS.session_created, EVENTS.prompt_out, EVENTS.prompt_accepted, EVENTS.prompt_out, EVENTS.prompt_accepted]);
  expect(r.effects.map((e) => e.type)).toEqual(["create", "send_preamble", "auto_title"]);
  expect(r.state).toMatchObject({ phase: "bound", ocSessionId: "oc-new", preambleOwed: false, titled: true, backfill: false });
});

test("a continue that finds a session backfills and owes no preamble; the new card is still auto-titled", () => {
  const { state } = initialResumeState({ continueLast: true });
  const r = walk(state, [EVENTS.begin, EVENTS.server_up, EVENTS.session_found, EVENTS.prompt_out, EVENTS.prompt_accepted]);
  expect(r.effects.map((e) => e.type)).toEqual(["lookup", "backfill", "auto_title"]);
  expect(r.state).toMatchObject({ phase: "bound", origin: "continue", ocSessionId: "oc-found", backfill: true });
});

test("a continue that finds nothing runs fresh: created, preamble owed", () => {
  const { state } = initialResumeState({ continueLast: true });
  const r = walk(state, [EVENTS.begin, EVENTS.server_up, EVENTS.session_missing, EVENTS.session_created, EVENTS.prompt_out]);
  expect(r.effects.map((e) => e.type)).toEqual(["lookup", "create", "send_preamble"]);
  expect(r.state).toMatchObject({ phase: "bound", origin: "fresh", ocSessionId: "oc-new" });
});

test("a resume binds the known id and backfills; its card is never auto-titled", () => {
  const { state } = initialResumeState({ resumeId: "oc-1" });
  const r = walk(state, [EVENTS.begin, EVENTS.server_up, EVENTS.prompt_out, EVENTS.prompt_accepted]);
  expect(r.effects.map((e) => e.type)).toEqual(["resume", "backfill"]);
  expect(r.state).toMatchObject({ phase: "bound", ocSessionId: "oc-1", titled: true });
});

test("/joy-prompt is the newer preamble: the first-prompt one is cleared", () => {
  const { state } = initialResumeState({});
  const r = walk(state, [EVENTS.begin, EVENTS.server_up, EVENTS.session_created, EVENTS.joy_prompt, EVENTS.prompt_out]);
  expect(r.effects.map((e) => e.type)).toEqual(["create"]);
});

test("a /title with text locks the card against the agent; a bare /title unlocks it", () => {
  const { state } = initialResumeState({});
  let r = walk(state, [EVENTS["title_command(text)"], EVENTS.agent_title]);
  expect(r.effects).toEqual([{ type: "set_title", value: "Fix the build", locked: true }]);
  r = walk(r.state, [EVENTS["title_command(bare)"], EVENTS.agent_title]);
  expect(r.effects).toEqual([{ type: "set_title", value: null, locked: false }, { type: "apply_title", value: "From the agent" }]);
});

test("a second beginWatching, and anything after ended, changes nothing", () => {
  const { state } = initialResumeState({});
  const booted = nextResumeState(state, EVENTS.begin)!.to;
  expect(nextResumeState(booted, EVENTS.begin)).toBeNull();
  const ended = nextResumeState(booted, EVENTS.ended)!.to;
  for (const ev of Object.values(EVENTS)) expect(nextResumeState(ended, ev), ev.type).toBeNull();
});
