// The OpenCode session's IDENTITY lifecycle, as an explicit machine: how the
// session finds (or makes) the server-side opencode session it will run,
// whether that session's history is backfilled, whether the first prompt
// owes the joy preamble, and whether the card may be auto-titled. It used to
// be six booleans and a nullable on OpencodeSession — `#started`,
// `#continueLast`, `#continuedInto`, `#needsPreamble`, `#titled`,
// `#titleLocked`, `#ocSessionId` — written from the constructor, #start(),
// the driver port, the /title and /joy-prompt handlers and the normalizer's
// title effect, with the rules in the comments beside each.
//
// Same shape as relay/leaseMachine.ts: one total `nextResumeState(state,
// ev)` switch, exhaustively tabled in opencodeResume.test.ts; the wiring in
// opencodeSession.ts applies `to` and performs `effects`.
//
// Origins (decided at construction, from OpencodeInit):
//   resume    an opencode session id is known (recovery / restart): the card
//             already exists and carries its title — never auto-titled; its
//             ledger checkpoints and pending rows are KEPT; the history is
//             backfilled once the server is up.
//   continue  "continue the newest session in this cwd": looked up on the
//             server; found → runs like resume (backfill), but the card is
//             new (auto-titled); not found, or the lookup failed → fresh.
//   fresh     a new opencode session: created on the server; the first
//             prompt carries the joy preamble; the card is auto-titled.
// A non-resume origin means a NEW opencode session under this joy id: the
// delivered-through and projection checkpoints are cleared and every ledger
// row still pending for an earlier one is interrupted (`fresh_session`) —
// nothing queued for it can run here. That is the `interrupt_pending_rows`
// effect, taken at construction.
//
// Titles: the first accepted prompt titles a NEW card once (#titled); a
// /title with text locks the title (a user's word beats the agent's
// <joy-title>), a bare /title unlocks; the lock is persisted on the record.
// Preamble: owed by a fresh session's first prompt only; `/joy-prompt`
// re-delivers the (newer) instructions and clears it.

export type ResumeOrigin = "resume" | "continue" | "fresh";
export type ResumePhase = "unstarted" | "booting" | "binding" | "bound" | "ended";
export const RESUME_PHASES: readonly ResumePhase[] = ["unstarted", "booting", "binding", "bound", "ended"];

export interface ResumeState {
  phase: ResumePhase;
  origin: ResumeOrigin;
  /** The server-side session: the resume id from the start, the found or
   *  created one once bound. */
  ocSessionId: string | null;
  /** The card has a title (an existing card, or the first prompt gave one). */
  titled: boolean;
  /** /title set a title the agent may not overwrite. */
  titleLocked: boolean;
  /** The next prompt carries the joy preamble. */
  preambleOwed: boolean;
  /** The bound session has history to backfill (resume, or continue that found one). */
  backfill: boolean;
}

export type ResumeEvent =
  /** beginWatching(): once. */
  | { type: "begin" }
  /** The server is up and a client is connected. */
  | { type: "server_up" }
  /** The continue lookup answered: the newest session in the cwd, or none
   *  (also: the lookup failed — starting fresh is the fallback either way). */
  | { type: "session_found"; ocSessionId: string }
  | { type: "session_missing" }
  /** The fresh session was created on the server. */
  | { type: "session_created"; ocSessionId: string }
  /** The driver is about to POST a prompt and asks for the preamble. */
  | { type: "prompt_out" }
  /** A prompt was accepted (mirrored): the card may take its title from it. */
  | { type: "prompt_accepted" }
  /** /joy-prompt: the newer instructions go in-band; the first-prompt preamble is moot. */
  | { type: "joy_prompt" }
  /** /title with text (lock) or bare (unlock). */
  | { type: "title_command"; text: string | null }
  /** The agent emitted a <joy-title>. */
  | { type: "agent_title"; value: string }
  | { type: "ended" };
export const RESUME_EVENT_TYPES: ReadonlyArray<ResumeEvent["type"]> = [
  "begin", "server_up", "session_found", "session_missing", "session_created", "prompt_out", "prompt_accepted", "joy_prompt", "title_command", "agent_title", "ended",
];

export type ResumeEffect =
  /** Bind the known resume id (no server call). */
  | { type: "resume"; ocSessionId: string }
  /** GET the session list and pick the newest for the cwd. */
  | { type: "lookup" }
  /** POST a new session. */
  | { type: "create" }
  /** Replay the bound session's history to the relay. */
  | { type: "backfill" }
  /** Prepend the joy preamble to the prompt going out. */
  | { type: "send_preamble" }
  /** Title the card from the accepted prompt. */
  | { type: "auto_title" }
  /** Apply the agent's title to the card. */
  | { type: "apply_title"; value: string }
  /** Set (or clear) the user's title; persist the lock. */
  | { type: "set_title"; value: string | null; locked: boolean };

export interface ResumeTransition { to: ResumeState; effects?: ResumeEffect[] }

/** The state a session is constructed in, and what construction must do:
 *  a non-resume origin clears the checkpoints and interrupts the rows an
 *  earlier opencode session under this id left pending. */
export function initialResumeState(init: { resumeId?: string | null; continueLast?: boolean; titleLocked?: boolean }): { state: ResumeState; interruptPendingRows: boolean } {
  const origin: ResumeOrigin = init.resumeId ? "resume" : init.continueLast ? "continue" : "fresh";
  return {
    state: {
      phase: "unstarted", origin, ocSessionId: init.resumeId ?? null,
      titled: origin === "resume", titleLocked: init.titleLocked === true, preambleOwed: false, backfill: false,
    },
    interruptPendingRows: origin !== "resume",
  };
}

/** The one answer for every (state, event) pair, or null = the event means
 *  nothing in that phase and changes nothing (a second beginWatching, a
 *  server_up after ended, an answer to a lookup that was never asked). */
export function nextResumeState(s: ResumeState, ev: ResumeEvent): ResumeTransition | null {
  if (ev.type === "ended") return s.phase === "ended" ? null : { to: { ...s, phase: "ended" } };
  if (s.phase === "ended") return null;
  // Titles and the preamble are answered the same in every live phase.
  switch (ev.type) {
    case "title_command": {
      const locked = ev.text !== null && ev.text !== "";
      return { to: { ...s, titleLocked: locked }, effects: [{ type: "set_title", value: locked ? ev.text : null, locked }] };
    }
    case "agent_title": return s.titleLocked ? { to: s } : { to: s, effects: [{ type: "apply_title", value: ev.value }] };
    case "joy_prompt": return { to: { ...s, preambleOwed: false } };
    case "prompt_out": return s.preambleOwed ? { to: { ...s, preambleOwed: false }, effects: [{ type: "send_preamble" }] } : { to: s };
    case "prompt_accepted": return s.titled ? { to: s } : { to: { ...s, titled: true }, effects: [{ type: "auto_title" }] };
  }
  switch (s.phase) {
    case "unstarted": switch (ev.type) {
      case "begin": return { to: { ...s, phase: "booting" } };
      default: return null;
    }
    case "booting": switch (ev.type) {
      case "server_up":
        if (s.origin === "resume") return { to: { ...s, phase: "bound", backfill: true }, effects: [{ type: "resume", ocSessionId: s.ocSessionId! }, { type: "backfill" }] };
        if (s.origin === "continue") return { to: { ...s, phase: "binding" }, effects: [{ type: "lookup" }] };
        return { to: { ...s, phase: "binding" }, effects: [{ type: "create" }] };
      default: return null;
    }
    case "binding": switch (ev.type) {
      // Continue found one: the card is new (auto-titled) but the session is
      // not — its history is backfilled, no preamble. Only a lookup that was
      // asked (origin continue) can be answered.
      case "session_found": return s.origin === "continue" ? { to: { ...s, phase: "bound", ocSessionId: ev.ocSessionId, backfill: true }, effects: [{ type: "backfill" }] } : null;
      // Nothing to continue (or the lookup failed): fall back to a fresh session.
      case "session_missing": return s.origin === "continue" ? { to: { ...s, origin: "fresh" }, effects: [{ type: "create" }] } : null;
      // Only a create that was asked (origin fresh) can be answered.
      case "session_created": return s.origin === "fresh" ? { to: { ...s, phase: "bound", ocSessionId: ev.ocSessionId, preambleOwed: true } } : null;
      default: return null;
    }
    case "bound": return null;
  }
  return null;
}
