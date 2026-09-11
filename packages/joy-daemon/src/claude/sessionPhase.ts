// The Claude session's PHASE, as one explicit machine (the pattern of
// domain/coordinator.ts: a pure step over a discriminated union, a total
// answer for every (state, observation) pair, an exhaustive table test).
//
// What it replaces: the state that decided "is this session busy / waiting /
// in a dialog / signing in" used to live in a score of private fields on the
// Session class — the thinking flag and its lease, the idle-poll counters,
// the hook turn edge, the hook-reported wait and its staleness clock, the
// five dialog fields, the login debounce — each written from several
// handlers with the rules in the comments beside them. Here every rule is a
// case, every input is an OBSERVATION stamped with the time it was made, and
// nothing reads the clock: `at` is the only time there is, so a manual clock
// tests every timed rule (the 170 s thinking lease, the six-poll tie-breaker,
// the ten-second stale wait) without waiting for it.
//
// The Session feeds observations and performs the EFFECTS the step hands
// back (a relay push, an auto-answer keystroke, a queue drain). It never
// decides; it observes and acts. The pane parsers stay in session.ts and are
// pure already; `readPane` there turns a frame into a PaneRead for this file.
//
// Two kinds of thinking change: one the Session makes itself (a trusted edge
// from the transcript or a dispatch — the `thinking` observation, which the
// caller pushes to the relay) and one this machine makes (a pane read, a
// hook, a dialog — handed back as a `set_thinking` effect). Every effect is
// emitted exactly where the old code called #setThinking, so the relay sees
// the same sequence of pushes it always did.
import type { JoyDialogInfo, JoyLoginInfo } from "../relay/relay";

/** With hooks live the pane may CLEAR thinking only after this many
 *  consecutive not-generating reads (3s apart) past the lease — a tie-breaker
 *  for the one edge hooks do not report (Stop does not fire on a terminal
 *  Esc; the transcript's interrupt marker normally closes that). Never SETS. */
export const HOOK_TIEBREAK_IDLE_POLLS = 6;
/** Hook-less: clear only after this many consecutive idle reads. A single
 *  stale/mid-repaint capture at a turn boundary used to flip thinking off
 *  and back on — the app status flapping between the busy state and
 *  "online" (2026-07-04). */
export const HOOKLESS_IDLE_POLLS = 2;
/** A hook-reported permission wait the pane has shown no dialog for, this
 *  long, is stale (the human answered in the terminal and no later hook
 *  cleared it). Measured as continuous ABSENCE, never as the wait's age. */
export const HOOK_NEEDS_INPUT_STALE_MS = 10_000;

// ── observations ─────────────────────────────────────────────────────────────

/** One pane frame, already parsed (session.ts readPane). */
export interface PaneRead {
  /** The "esc to interrupt" line / spinner: Claude is generating. */
  generating: boolean;
  /** An input box is painted. */
  readyPrompt: boolean;
  /** …and it holds no typed-ahead text. */
  inputEmpty: boolean;
  /** An interactive CLI dialog, with the keys that answer it by themselves
   *  (dialogAutoAnswerKeys) when it is one joy answers. */
  dialog: { title: string | null; options: string[]; autoAnswer: string[] | null } | null;
  /** The CLI's login box (loginFromPane). */
  login: { url: string; error?: string } | null;
}

export type Observation =
  | { type: "pane"; at: number; read: PaneRead }
  /** The first hook event from this process: hook authority on. */
  | { type: "hooks_live"; at: number }
  /** UserPromptSubmit — a prompt really went in; `leaseMs` is the thinking
   *  lease the prompt earns (thinkingLeaseMs: 0 for a non-generating slash). */
  | { type: "hook_prompt"; at: number; leaseMs: number }
  /** Stop / StopFailure — the turn is over. */
  | { type: "hook_stop"; at: number }
  /** PostToolUse — a tool completed; `agent` names a subagent's. */
  | { type: "hook_tool_done"; at: number; agent: string | null }
  /** PermissionRequest — a tool wants the human. */
  | { type: "hook_permission"; at: number; tool?: string; agent: string | null }
  /** Notification(notification_type). */
  | { type: "hook_notification"; at: number; kind: string }
  /** SessionStart / SessionEnd — a conversation edge: any wait is over. */
  | { type: "hook_session_edge"; at: number; edge: "start" | "end" }
  /** The transcript's turn opened (`at` = when the daemon read it) or closed. */
  | { type: "transcript_turn"; at: number; open: boolean }
  /** Assistant output landed for the open turn. */
  | { type: "output"; at: number }
  /** A trusted thinking edge the Session set itself (and pushes itself). */
  | { type: "thinking"; at: number; on: boolean }
  /** A submit earned a thinking lease of `ms`. */
  | { type: "lease"; at: number; ms: number }
  /** Escape was sent: a permission prompt is dismissed with it. */
  | { type: "escape"; at: number }
  /** The first-launch trust prompt, with the keys that answer it (or null
   *  while its menu has not painted). */
  | { type: "trust_prompt"; at: number; keys: string[] | null }
  /** The first transcript entry: the session is active. */
  | { type: "activated"; at: number }
  /** The session ended. Absorbing for everything but `thinking` and
   *  `transcript_turn`, which the teardown itself still reports. */
  | { type: "ended"; at: number; reason: string };

export const OBSERVATION_TYPES: ReadonlyArray<Observation["type"]> = [
  "pane", "hooks_live", "hook_prompt", "hook_stop", "hook_tool_done", "hook_permission", "hook_notification",
  "hook_session_edge", "transcript_turn", "output", "thinking", "lease", "escape", "trust_prompt", "activated", "ended",
];

// ── effects ──────────────────────────────────────────────────────────────────

export type Effect =
  | { type: "set_thinking"; on: boolean; via: "pane" | "tiebreaker" | "dialog" | "hook" | "output" }
  | { type: "publish_dialog"; dialog: JoyDialogInfo | null }
  | { type: "publish_login"; login: JoyLoginInfo | null }
  | { type: "auto_answer"; keys: string[]; title: string }
  | { type: "answer_trust"; keys: string[] }
  | { type: "confirm_dispatch_on_dialog"; at: number }
  /** A dialog resolved: kick the drain so anything queued behind it goes out. */
  | { type: "drain" }
  | { type: "notify_permission" }
  | { type: "log"; line: string };

// ── state ────────────────────────────────────────────────────────────────────

export type Lifecycle = { kind: "starting" } | { kind: "active" } | { kind: "ended"; reason: string };

export interface Wait { kind: string; tool?: string; agent?: string; since: number }

export interface PhaseState {
  lifecycle: Lifecycle;
  hooks: { live: boolean; since: number };
  /** The hook-reported TURN edge; null until a hook has said either way. */
  hookTurn: { open: boolean; at: number } | null;
  /** The transcript's open turn (`since` = when the daemon read its opening). */
  transcriptTurn: { since: number } | null;
  thinking: {
    on: boolean;
    /** Trusted-positive lease: the pane may not clear thinking before it. */
    leaseUntil: number;
    /** Consecutive not-generating poll reads while thinking. */
    idlePolls: number;
    /** The last clear came from the pane tie-breaker; output undoes it. */
    clearedByTieBreaker: boolean;
    /** This turn has produced assistant output (#647). */
    turnProducedOutput: boolean;
  };
  /** Hook-reported waiting-for-input (permission / elicitation / agent). */
  wait: Wait | null;
  /** `since` of the wait a "permission" push already went out for. */
  waitPushedFor: number;
  /** First poll at which a permission wait was NOT on the pane (0 = seen). */
  waitAbsentSince: number;
  dialog: {
    /** Undebounced: the dialog on the pane and when it was FIRST sighted. */
    observedKey: string | null;
    firstSeenAt: number;
    /** The current sighting has had its auto-answer keys sent. */
    answered: boolean;
    /** Debounce: seen once, published on the next poll if still there. */
    pendingKey: string | null;
    /** The published banner. */
    current: JoyDialogInfo | null;
    currentKey: string | null;
  };
  login: { pendingUrl: string | null; current: JoyLoginInfo | null };
  trustHandled: boolean;
}

export function createPhaseState(status: "starting" | "active" | "ended", endReason?: string): PhaseState {
  return {
    lifecycle: status === "ended" ? { kind: "ended", reason: endReason ?? "unknown" } : { kind: status },
    hooks: { live: false, since: 0 },
    hookTurn: null,
    transcriptTurn: null,
    thinking: { on: false, leaseUntil: 0, idlePolls: 0, clearedByTieBreaker: false, turnProducedOutput: false },
    wait: null,
    waitPushedFor: 0,
    waitAbsentSince: 0,
    dialog: { observedKey: null, firstSeenAt: 0, answered: false, pendingKey: null, current: null, currentKey: null },
    login: { pendingUrl: null, current: null },
    trustHandled: false,
  };
}

// ── derived truths (what the old private methods answered) ───────────────────

/** With hooks live: has a hook closed the turn AFTER the transcript's open
 *  turn began? Then the transcript turn is bookkeeping for output still
 *  being tailed, not a running turn. */
export function turnClosedByHook(s: PhaseState): boolean {
  const h = s.hookTurn;
  return s.hooks.live && h !== null && !h.open && (s.transcriptTurn === null || h.at >= s.transcriptTurn.since);
}
/** The runtime turn as the authority sees it. */
export function turnRunning(s: PhaseState): boolean {
  return s.transcriptTurn !== null && !turnClosedByHook(s);
}
/** Hooks are live and the last hook edge says IDLE. */
export function hookSaysIdle(s: PhaseState): boolean {
  return s.hooks.live && s.hookTurn !== null && !s.hookTurn.open;
}
/** Does the transcript own the turn-TERMINAL edge an entry stamped
 *  `entryTimeMs` reports? Without hooks: yes, within the tail window. With
 *  hooks live only while the hook turn is open AND the entry postdates its
 *  opening (Astra on edd69fd1). */
export function transcriptOwnsTerminal(s: PhaseState, entryTimeMs: number, tailBoundAt: number): boolean {
  if (entryTimeMs < tailBoundAt - 60_000) return false;
  if (!s.hooks.live) return true;
  const h = s.hookTurn;
  if (h === null) return true;
  return h.open && entryTimeMs > h.at;
}

// ── the phase (a projection of the state) ────────────────────────────────────

export type Phase =
  | { kind: "starting" }
  | { kind: "idle" }
  | { kind: "busy"; source: "hook_turn" | "transcript_turn" | "dispatch" | "thinking" }
  | { kind: "dialog"; key: string }
  | { kind: "needs_input"; input: string }
  | { kind: "login" }
  | { kind: "ended"; reason: string };

export const PHASE_KINDS: ReadonlyArray<Phase["kind"]> = ["starting", "idle", "busy", "dialog", "needs_input", "login", "ended"];

/** `dispatching`: the Session's dispatch pipeline holds a typed-but-unconfirmed
 *  message or a pending Enter — state that machine does not model. */
export function phaseOf(s: PhaseState, extras: { dispatching?: boolean } = {}): Phase {
  if (s.lifecycle.kind === "ended") return { kind: "ended", reason: s.lifecycle.reason };
  if (s.dialog.current) return { kind: "dialog", key: s.dialog.currentKey ?? "" };
  if (s.login.current) return { kind: "login" };
  if (s.wait) return { kind: "needs_input", input: s.wait.kind };
  if (s.hooks.live && s.hookTurn?.open) return { kind: "busy", source: "hook_turn" };
  if (turnRunning(s)) return { kind: "busy", source: "transcript_turn" };
  if (extras.dispatching) return { kind: "busy", source: "dispatch" };
  if (s.thinking.on) return { kind: "busy", source: "thinking" };
  if (s.lifecycle.kind === "starting") return { kind: "starting" };
  return { kind: "idle" };
}

// ── the step ─────────────────────────────────────────────────────────────────

export interface StepResult { state: PhaseState; effects: Effect[] }

export const dialogKeyOf = (d: { title: string | null; options: string[] }): string => `${d.title ?? ""} ${d.options.join(" ")}`;

/** The one answer for every (state, observation) pair. Pure: the input state
 *  is never mutated. */
export function stepPhase(state: PhaseState, obs: Observation): StepResult {
  const s: PhaseState = {
    ...state,
    hooks: { ...state.hooks },
    thinking: { ...state.thinking },
    wait: state.wait ? { ...state.wait } : null,
    dialog: { ...state.dialog },
    login: { ...state.login },
  };
  const effects: Effect[] = [];
  const ended = s.lifecycle.kind === "ended";

  // What #setThinking did to the flags around the flag.
  const applyThinking = (on: boolean): void => {
    if (on) s.thinking.clearedByTieBreaker = false;
    if (!on) { s.thinking.turnProducedOutput = false; s.thinking.leaseUntil = 0; } // any accepted clear ends the lease
    s.thinking.on = on;
  };
  const setThinking = (on: boolean, via: Extract<Effect, { type: "set_thinking" }>["via"]): void => {
    applyThinking(on);
    effects.push({ type: "set_thinking", on, via });
  };

  switch (obs.type) {
    case "thinking":
      applyThinking(obs.on);
      return { state: s, effects };
    case "transcript_turn":
      s.transcriptTurn = obs.open ? { since: obs.at } : null;
      return { state: s, effects };
    case "ended":
      if (ended) return { state: s, effects };
      s.lifecycle = { kind: "ended", reason: obs.reason };
      s.wait = null;
      // Clear the dialog banner on every end path while the relay is still
      // attached: the pane poll stops at ended, so a teardown racing the 3s
      // reconcile would otherwise pin ACTION NEEDED on a detached session.
      s.dialog = { observedKey: null, firstSeenAt: 0, answered: false, pendingKey: null, current: null, currentKey: null };
      effects.push({ type: "publish_dialog", dialog: null });
      return { state: s, effects };
  }
  if (ended) return { state: s, effects };

  switch (obs.type) {
    case "pane": {
      stepPaneThinking(s, obs.at, obs.read, setThinking, effects);
      stepPaneLogin(s, obs.at, obs.read, effects);
      stepPaneDialog(s, obs.at, obs.read, setThinking, effects);
      return { state: s, effects };
    }
    case "hooks_live":
      if (!s.hooks.live) s.hooks = { live: true, since: obs.at };
      return { state: s, effects };
    case "hook_prompt":
      // A prompt was REALLY submitted: thinking flips on at the submit
      // instant, the wait (if any) is over, the hook turn is open, and the
      // prompt earns its lease — a trusted edge the pane cannot clear.
      setThinking(true, "hook");
      s.wait = null;
      s.hookTurn = { open: true, at: obs.at };
      s.thinking.leaseUntil = obs.at + obs.leaseMs;
      s.thinking.idlePolls = 0;
      return { state: s, effects };
    case "hook_stop":
      // THE idle edge with hooks live: the transcript's turn may stay open
      // until the tailer reaches turn_duration and the pane may still paint
      // the generating footer — neither holds busy() once this has fired.
      setThinking(false, "hook");
      s.wait = null;
      s.hookTurn = { open: false, at: obs.at };
      s.thinking.idlePolls = 0;
      return { state: s, effects };
    case "hook_tool_done":
      // A SUBAGENT's tool says nothing about the main agent: it only answers
      // a wait of ITS OWN actor. The main agent's tool is a turn in progress:
      // its wait is answered, the idle count void, thinking re-asserted
      // inside a running turn a stale pane read cleared — a REFRESH, never a
      // setter (a background agent's tools cannot make an idle session busy).
      if (obs.agent) {
        if (s.wait?.agent === obs.agent) s.wait = null;
        return { state: s, effects };
      }
      if (!s.wait?.agent) s.wait = null;
      s.thinking.idlePolls = 0;
      s.hookTurn = { open: true, at: obs.at };
      if (s.transcriptTurn && !s.thinking.on) setThinking(true, "hook");
      return { state: s, effects };
    case "hook_permission":
      // Waiting, not generating. A subagent's prompt is a real wait for the
      // human too, tagged with its actor so only that actor's tool completion
      // answers it; it does not touch the main agent's thinking.
      if (!obs.agent) setThinking(false, "hook");
      s.thinking.idlePolls = 0;
      if (s.wait?.kind !== "permission") s.wait = { kind: "permission", tool: obs.tool, since: obs.at, ...(obs.agent ? { agent: obs.agent } : {}) };
      else if (obs.tool && (s.wait.agent ?? null) === obs.agent) s.wait.tool = obs.tool;
      return { state: s, effects };
    case "hook_notification": {
      // Claude is WAITING — not generating. `kind` says on what:
      //   permission_prompt → a permission wait + one push per episode
      //   idle_prompt       → plain idleness (60s at the prompt): thinking
      //                       off, lease void, hook turn closed; NOT a wait
      //   elicitation_* / agent_needs_input → a wait of that kind
      //   auth_success and the rest → thinking off only (the auth episode is
      //                       the Session's)
      setThinking(false, "hook");
      s.thinking.idlePolls = 0;
      if (obs.kind === "idle_prompt") { s.thinking.leaseUntil = 0; s.hookTurn = { open: false, at: obs.at }; }
      if (obs.kind === "permission_prompt") {
        if (s.wait?.kind !== "permission") s.wait = { kind: "permission", since: obs.at };
        if (s.waitPushedFor !== s.wait.since) {
          s.waitPushedFor = s.wait.since;
          effects.push({ type: "notify_permission" });
        }
      } else if (obs.kind === "agent_needs_input" || obs.kind.startsWith("elicitation")) {
        if (s.wait?.kind !== obs.kind) s.wait = { kind: obs.kind, since: obs.at };
      }
      return { state: s, effects };
    }
    case "hook_session_edge":
      s.wait = null;
      return { state: s, effects };
    case "output":
      s.thinking.turnProducedOutput = true;
      // Output landing inside a turn the tie-breaker declared idle proves
      // that read wrong: the pane looked idle to the parser, not to Claude.
      // Only a tie-breaker clear is undone — a Stop-driven clear stands.
      if (s.transcriptTurn && s.hooks.live && !s.thinking.on && s.thinking.clearedByTieBreaker) {
        effects.push({ type: "log", line: "output inside the open turn after a tie-breaker clear — thinking re-asserted" });
        setThinking(true, "output");
      }
      return { state: s, effects };
    case "lease":
      s.thinking.leaseUntil = obs.at + obs.ms;
      return { state: s, effects };
    case "escape":
      s.wait = null; // Escape dismisses a permission prompt too
      return { state: s, effects };
    case "trust_prompt":
      // Fires at most once. Never a hard-coded digit: the option order is
      // not stable across claude versions and a blind "1" answers *no*.
      if (!s.trustHandled && obs.keys) {
        s.trustHandled = true;
        effects.push({ type: "answer_trust", keys: obs.keys });
      }
      return { state: s, effects };
    case "activated":
      if (s.lifecycle.kind === "starting") s.lifecycle = { kind: "active" };
      return { state: s, effects };
  }
  return { state: s, effects };
}

type SetThinking = (on: boolean, via: Extract<Effect, { type: "set_thinking" }>["via"]) => void;

/** Reconcile thinking from the live pane (the 3s poll). GENERATING, not
 *  "working": working also counts a live-footer background shell, so a
 *  session with a persistent dev server read as thinking FOREVER while idle
 *  at the prompt (2026-07-04). */
function stepPaneThinking(s: PhaseState, at: number, read: PaneRead, setThinking: SetThinking, effects: Effect[]): void {
  const t = s.thinking;
  if (s.hooks.live) {
    // HOOK AUTHORITY: the pane never SETS thinking (a quoted hint in a reply
    // can no longer pin a session busy, #479) and CLEARS it only as a
    // tie-breaker: a long run of idle reads past the lease, for the single
    // edge hooks cannot report. An idle read is an EMPTY ready box with
    // nothing generating — a box holding typed-ahead text, a dialog, or a
    // frame the parser cannot place is ambiguous and counts for nothing
    // either way (fny 4477e540, 2026-09-09).
    const idleBox = !read.generating && read.readyPrompt && read.inputEmpty;
    if (read.generating || !t.on) {
      t.idlePolls = 0;
    } else if (idleBox) {
      t.idlePolls += 1;
      if (t.idlePolls >= HOOK_TIEBREAK_IDLE_POLLS) {
        t.idlePolls = 0;
        // Past the lease, OR this turn already produced output — the lease
        // guards the pre-output window and nothing else (#647).
        if (at >= t.leaseUntil || t.turnProducedOutput) {
          effects.push({ type: "log", line: `pane idle for ${HOOK_TIEBREAK_IDLE_POLLS} polls with no Stop — tie-breaker clears thinking` });
          t.clearedByTieBreaker = true;
          setThinking(false, "tiebreaker");
        }
      }
    }
    return;
  }
  // HOOK-LESS (the pane is the ground truth). Hysteresis: SET on one
  // generating read (thinking should appear fast), CLEAR only after two
  // consecutive idle reads — and never inside the lease: the pane's "not
  // generating" read cannot override a trusted submit (a matcher broken by a
  // TUI change looked idle ~6s into a minutes-long pre-output think).
  if (read.generating) {
    t.idlePolls = 0;
    if (!t.on) setThinking(true, "pane");
  } else if (t.on) {
    t.idlePolls += 1;
    if (t.idlePolls >= HOOKLESS_IDLE_POLLS) {
      t.idlePolls = 0;
      if (at >= t.leaseUntil) setThinking(false, "pane");
    }
  } else {
    t.idlePolls = 0;
  }
}

/** The login bar: a URL must be seen on two consecutive polls before it is
 *  published (a transient link in normal output), cleared the poll it is
 *  gone; once showing, an error change on the same URL publishes at once. */
function stepPaneLogin(s: PhaseState, at: number, read: PaneRead, effects: Effect[]): void {
  const l = s.login;
  const login = read.login;
  if (!login) {
    l.pendingUrl = null;
    if (l.current) {
      l.current = null;
      effects.push({ type: "publish_login", login: null });
    }
    return;
  }
  if (!l.current && l.pendingUrl !== login.url) {
    l.pendingUrl = login.url; // first sighting — confirm next poll
    return;
  }
  const sameUrl = l.current?.url === login.url;
  if (sameUrl && (l.current?.error ?? undefined) === login.error) return; // no change
  l.pendingUrl = null;
  l.current = { url: login.url, since: sameUrl ? l.current!.since : at, ...(login.error ? { error: login.error } : {}) };
  effects.push({ type: "publish_login", login: l.current });
}

/** An interactive CLI dialog (model picker / switch confirm / effort slider).
 *  The BANNER is debounced (two sightings), the causal input for dispatch
 *  confirmation is the FIRST sighting (a dialog opened and Esc-closed inside
 *  one poll gap would otherwise escape both the publish and the timeout
 *  backstop, requeuing a consumed command). Auto-answer once per sighting. */
function stepPaneDialog(s: PhaseState, at: number, read: PaneRead, setThinking: SetThinking, effects: Effect[]): void {
  const d = s.dialog;
  const dialog = read.dialog;
  if (dialog) {
    // A dialog on screen is PROOF Claude is waiting for input, not
    // generating — the strongest negative edge the pane can give. Without
    // this the submit's lease kept busy() true for a command that never
    // generates: `/effort high` wedged a session for a full minute, `/model`
    // did the same (2026-09-03).
    s.thinking.leaseUntil = 0;
    if (s.thinking.on) setThinking(false, "dialog");
    s.waitAbsentSince = 0; // the wait is visibly still on
  } else {
    // Tie-breaker for a hook-reported permission wait: the human answered in
    // the terminal and no later hook cleared it. Measured as the time the
    // dialog has been continuously ABSENT — not the wait's age: one
    // contradictory (mid-repaint) capture 12s into a still-visible prompt
    // used to erase the wait for good.
    if (s.wait?.kind === "permission") {
      if (!s.waitAbsentSince) s.waitAbsentSince = at;
      else if (at - s.waitAbsentSince > HOOK_NEEDS_INPUT_STALE_MS) {
        s.wait = null;
        s.waitAbsentSince = 0;
      }
    } else s.waitAbsentSince = 0;
    d.pendingKey = null;
    d.observedKey = null;
    if (d.current) {
      d.current = null;
      d.currentKey = null;
      // Dialog resolved → the ready prompt is (about to be) back: kick the
      // drain so anything queued behind it goes out promptly.
      effects.push({ type: "drain" });
    }
    // Assert the clear EVERY poll, not just on the transition: the relay
    // dedupes against server-ACKED metadata, so a clear whose write failed
    // retries next poll instead of being lost (finding 6 — the old
    // transition-only clear was fire-and-forget).
    effects.push({ type: "publish_dialog", dialog: null });
    return;
  }
  const key = dialogKeyOf(dialog);
  if (d.observedKey !== key) {
    d.observedKey = key;
    d.firstSeenAt = at;
    d.answered = false;
  }
  effects.push({ type: "confirm_dispatch_on_dialog", at: d.firstSeenAt });
  // The keys are fire-and-forget; if the dialog is still painted on the next
  // poll it simply publishes as before, so a lost keystroke degrades to the
  // "answer this in the terminal" banner, never a loop.
  if (!d.answered && dialog.autoAnswer) {
    d.answered = true;
    effects.push({ type: "auto_answer", keys: dialog.autoAnswer, title: dialog.title ?? "" });
    return;
  }
  if (!d.current && d.pendingKey !== key) {
    d.pendingKey = key; // first sighting — publish on next poll
    return;
  }
  d.pendingKey = null;
  if (!d.current || d.currentKey !== key) {
    d.current = { title: dialog.title, options: dialog.options, since: d.firstSeenAt };
    d.currentKey = key;
  }
  // Same convergence contract as the clear: assert every poll, dedupe on ack.
  effects.push({ type: "publish_dialog", dialog: d.current });
}
