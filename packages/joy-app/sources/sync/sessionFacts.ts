/**
 * What is true about a session, right now — the ONE derivation (#652 follow-on).
 *
 * The status was computed twice: `buildSessionRowData` in storage.ts for the
 * sidebar row and `useSessionStatus` in sessionUtils.ts for the session header,
 * as two hand-written copies of the same nine-branch ladder kept in sync by
 * comment ("mirrors useSessionStatus"). They had already drifted — one called
 * the shared `isAgentBusy`, the other still inlined its own formula — and the
 * ladder is only one of several consumers. Message eviction, unread detection,
 * the send gate and the voice context each re-derived "is this working" from
 * the raw fields with a slightly different expression.
 *
 * The deeper problem is that a session's state is not a single value. It is a
 * PRODUCT: a session can be online AND mid-turn AND running three agents AND
 * blocked on a permission, all at once. The ladder is a *presentation* choice —
 * the row has space for one badge, so concurrent facts get ranked and all but
 * the winner discarded (which is why the background counts had to be smuggled
 * back in as a text suffix; see `withBg`).
 *
 * So: derive the facts once, here, and let every consumer project the part it
 * actually needs. The ladder becomes one projection among several rather than
 * the only way to ask a question.
 */

import { isAgentBusy, isFresh } from './sessionLiveness';

/** Process lifecycle, reported by the daemon (`joy__state`). Distinct from the
 *  transport question of whether we can currently hear from it: 'detached'
 *  means Claude died while the daemon is still online and serving the window. */
export type Lifecycle = 'running' | 'detached' | 'archived';

/**
 * Phases of one turn — genuinely exclusive, because compaction and a retry
 * backoff ARE the turn at that moment rather than something running beside it.
 */
export type TurnPhase = 'idle' | 'thinking' | 'compacting' | 'retrying';

/**
 * Something interactive is holding the agent's PANE, waiting on a human. Three
 * separate metadata keys today, each with its own pinned bar and none of them
 * known to the status ladder — so the header could report "clauding…" while a
 * model picker held the pane and nothing was going to move.
 *
 * Modelled as a SUM, not three independent flags: the pane shows one thing at a
 * time, so "a dialog and a login at once" is unrepresentable rather than merely
 * unlikely. A tool PERMISSION request is deliberately NOT in here — it arrives
 * on a different channel (`agentState.requests`) and can genuinely coexist with
 * any of these, so it stays its own field.
 */
export type BlockedKind = 'login' | 'dialog' | 'approval';

export interface Blocked {
    kind: BlockedKind;
    /** Human-facing detail the bar already renders; carried so a projection can label the state. */
    title?: string;
}

export interface Counter { done: number; total: number }

export interface QueueFacts {
    depth: number;
    /** A message typed into the pane but not yet confirmed — neither queued nor sent. */
    inFlight: boolean;
    /** Auto-drain halted; nothing further will dispatch without intervention. */
    paused: boolean;
    pauseReason?: 'input_dirty' | 'dispatch_timeout' | 'dispatch_mismatch' | 'dispatch_failed';
}

export interface SessionFacts {
    /** Can we hear from it? Supplied by the caller — see `sessionFacts`. */
    online: boolean;
    /** Finished work this device has not looked at yet. A per-device fact
     *  (which sessions you have opened), so the caller supplies it — the list
     *  does, the session screen never does (you are looking at it). */
    unread: boolean;
    lifecycle: Lifecycle;
    turn: TurnPhase;
    /** Attempt counts, present exactly when `turn === 'retrying'`. */
    retry: { attempt: number; total: number } | null;
    /** The open turn has produced no output for a long time. A qualifier on
     *  `turn`, not a phase of it: the turn is still open (so this still counts
     *  as busy everywhere), the daemon just cannot vouch for it. */
    stalled: { since: number } | null;
    blocked: Blocked | null;
    /** A tool permission request is outstanding. Orthogonal to `blocked`: it
     *  arrives on its own channel and can be up at the same time as a dialog. */
    permission: boolean;
    /** Background work that OUTLIVES the turn — null when none is running. */
    agents: Counter | null;
    tasks: Counter | null;
    /** Servers/daemons that never complete, so deliberately not part of the N/M. */
    longRunning: number;
    /** Terminal: the relay refused this session's output for good. Only a new session recovers. */
    budgetExhausted: boolean;
    /** Notifications for this session are silenced on every device. A fact
     *  about the session, not a state: it is orthogonal to everything in the
     *  ladder and never becomes the badge — a muted session still shows
     *  whatever it is doing. */
    muted: boolean;
    /** Created with `joy new --headless`: nobody is watching it. */
    headless: boolean;
    /** This session IS an automation run. Present while it runs, and kept
     *  after a failure so the failure stays until dismissed. */
    automation: { runId: string; failed?: boolean | null; errorCode?: string | null; errorMessage?: string | null } | null;
    queue: QueueFacts | null;
}

/** The shape `sessionFacts` reads. Structural on purpose, so this module needs
 *  neither the store nor react-native and can be tested directly. */
export interface SessionFactsInput {
    thinking?: boolean;
    /** When this client derived `thinking` — how long it outranks a daemon
     *  card carrying no mirror (see isAgentBusy). */
    thinkingAt?: number;
    presence?: 'online' | number;
    activeAt: number;
    agentState?: { requests?: Record<string, unknown> | null } | null;
    metadata?: {
        joy__state?: string;
        joy__retry?: { attempt: number; total: number } | null;
        joy__compacting?: { trigger: string; since: number } | null;
        joy__stalled?: { since: number; silentForMs: number } | null;
        joy__thinking?: { since: number } | null;
        joy__agents?: { done: number; total: number } | null;
        joy__tasks?: { done: number; total: number } | null;
        joy__longRunning?: number | null;
        joy__muted?: boolean | null;
        joy__headless?: boolean | null;
        joy__automation?: { runId: string; failed?: boolean | null; errorCode?: string | null; errorMessage?: string | null } | null;
        joy__eventBudget?: { since: number; dropped: number } | null;
        joy__login?: { url?: string; code?: string; error?: string } | null;
        joy__dialog?: { title?: string | null; options: string[] } | null;
        joy__codexApproval?: { title: string; kind: string } | null;
        joy__queue?: {
            queue: Array<{ id: string }>;
            inFlight: string | null;
            paused: boolean;
            pauseReason?: QueueFacts['pauseReason'];
        } | null;
    } | null;
}

function counter(c: { done: number; total: number } | null | undefined): Counter | null {
    // total === 0 is "nothing running", not "a counter reading zero" — the
    // ladder has always treated it that way and the bars never render it.
    return c && c.total > 0 ? { done: c.done, total: c.total } : null;
}

function lifecycleOf(joyState: string | undefined): Lifecycle {
    return joyState === 'detached' || joyState === 'archived' ? joyState : 'running';
}

/**
 * Which pane-owning prompt is up, if any. Ranked most-blocking first: a login
 * prompt gates the whole harness, a dialog gates the current turn, an approval
 * gates one tool call.
 */
function blockedOf(session: SessionFactsInput): Blocked | null {
    const m = session.metadata;
    if (m?.joy__login) return { kind: 'login' };
    if (m?.joy__dialog) return { kind: 'dialog', title: m.joy__dialog.title ?? undefined };
    if (m?.joy__codexApproval) return { kind: 'approval', title: m.joy__codexApproval.title };
    return null;
}

function hasPermissionRequest(session: SessionFactsInput): boolean {
    const requests = session.agentState?.requests;
    return !!requests && Object.keys(requests).length > 0;
}

/**
 * Turn phase. Retry outranks compaction outranks a live turn, matching the
 * order the ladder has always used: each is a more specific description of the
 * same open turn, so the most specific one wins.
 */
function turnOf(session: SessionFactsInput): TurnPhase {
    const m = session.metadata;
    if (m?.joy__retry) return 'retrying';
    if (m?.joy__compacting) return 'compacting';
    if (isAgentBusy(session)) return 'thinking';
    return 'idle';
}

/**
 * Derive every fact once.
 *
 * `online` is INJECTED rather than computed here, and deliberately so: the
 * header debounces it through `useStableOnline` (the 8s offline grace from
 * #649) while the sidebar reads it raw. That difference is real — one is a
 * hook with a clock, the other a pure builder — so it stays the caller's
 * decision, and everything downstream of it is shared.
 */
export function sessionFacts(session: SessionFactsInput, online: boolean, opts: { unread?: boolean } = {}): SessionFacts {
    const m = session.metadata;
    const retry = m?.joy__retry ?? null;
    const q = m?.joy__queue ?? null;
    return {
        online,
        unread: opts.unread === true,
        lifecycle: lifecycleOf(m?.joy__state),
        turn: turnOf(session),
        retry: retry ? { attempt: retry.attempt, total: retry.total } : null,
        // Only meaningful over a turn we can see is open; a stale flag on an
        // idle or unreachable session is not a stall.
        stalled: m?.joy__stalled && online && turnOf(session) !== 'idle' ? { since: m.joy__stalled.since } : null,
        blocked: blockedOf(session),
        permission: hasPermissionRequest(session),
        agents: counter(m?.joy__agents),
        tasks: counter(m?.joy__tasks),
        longRunning: m?.joy__longRunning ?? 0,
        budgetExhausted: (m?.joy__eventBudget?.dropped ?? 0) > 0,
        muted: m?.joy__muted === true,
        headless: m?.joy__headless === true,
        automation: m?.joy__automation ?? null,
        queue: q
            ? { depth: q.queue.length, inFlight: q.inFlight != null, paused: q.paused, pauseReason: q.pauseReason }
            : null,
    };
}

/**
 * Facts for a consumer that is not a rendered status line.
 *
 * The two ladders inject `online` because they differ deliberately: the header
 * debounces the reading, the sidebar does not. Everything else — eviction,
 * unread, the repair loop, the voice hooks — wants the plain reading, and
 * getting it here means none of them re-derives presence and freshness by hand.
 */
export function liveFacts(session: SessionFactsInput): SessionFacts {
    return sessionFacts(session, session.presence === 'online' && isFresh(session));
}

// ─────────────────────────────────────────────────────────────────────────────
// Projections. Each consumer takes the part of the product it needs; only the
// status badge does the lossy collapse, and it does it in exactly one place.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The single badge a row or header can show. This is a PRESENTATION collapse of
 * the facts above, not the state itself — `agents` here means "idle, with agents
 * running", because a live turn outranks the counts and pushes them into the
 * `withBg` suffix.
 */
export type SessionState =
    | 'disconnected' | 'detached' | 'blocked' | 'retrying' | 'compacting'
    | 'stalled' | 'thinking' | 'tasks' | 'agents' | 'waiting' | 'permission_required' | 'unread';

/**
 * The ladder — ONE implementation, where there were two.
 *
 * Order is load-bearing and unchanged from the copies it replaces:
 *
 *   detached      Claude died; honoured only while the session's own presence is
 *                 live, since joy-tmux keeps heartbeating a detached session and
 *                 a dead daemon should read as plain offline instead.
 *   disconnected  we cannot hear from it at all.
 *   blocked       a prompt owns the pane. Ranked this high because it is the only
 *                 state that will NOT clear on its own — and because it usually
 *                 explains the ones below it, a turn that looks stuck or a retry
 *                 that keeps failing being downstream of the prompt nobody saw.
 *   retrying      the daemon is re-sending a failed turn on a backoff.
 *   compacting    the turn is effectively paused while Claude summarises.
 *   permission    a human answer is needed before anything continues.
 *   stalled       the turn is open but has been silent for a long time: shown
 *                 instead of "thinking" because a vibing message over a hung
 *                 turn is the lie; ranked below the blocking states because
 *                 those are the thing to act on.
 *   thinking      a reply is streaming — the strongest "you can converse" signal.
 *   agents/tasks  idle, but background work is still in flight.
 *   waiting       ready.
 */
export function statusState(facts: SessionFacts): SessionState {
    if (facts.online && facts.lifecycle === 'detached') return 'detached';
    if (!facts.online) return 'disconnected';
    // Amber first — it is stopped until you do something. Then unread: work
    // finished that you have not seen outranks whatever the session is doing
    // now (Faraz, 2026-09-10: "amber at top, then unread, then active, then
    // read, then error, then offline"). Before this, unread was painted over
    // the state by three components each in their own way, and `waiting` and
    // unread shared one green, so a read idle session looked unread.
    if (facts.blocked) return 'blocked';
    if (facts.permission) return 'permission_required';
    if (facts.unread) return 'unread';
    if (facts.turn === 'retrying') return 'retrying';
    if (facts.turn === 'compacting') return 'compacting';
    if (facts.stalled) return 'stalled';
    if (facts.turn === 'thinking') return 'thinking';
    if (facts.agents) return 'agents';
    if (facts.tasks) return 'tasks';
    return 'waiting';
}

/**
 * Is a turn open in any phase?
 *
 * The question message eviction, the send gate and unread detection all meant to
 * ask, and each asked slightly differently — `thinking === true` in one place,
 * the thinking-or-mirror pair in another. A compacting or retrying session is
 * mid-turn too, which the narrowest of those spellings missed entirely.
 */
export function isTurnActive(facts: SessionFacts): boolean {
    return facts.turn !== 'idle';
}

/**
 * Did the session just finish everything it was doing?
 *
 * The falling edge behind the unread marker. "Doing something" is deliberately
 * wider than a live turn: an outstanding permission request or a pane-owning
 * prompt is work the session is still in the middle of, so stopping at one is
 * not finishing — you have not been handed a result, you have been asked a
 * question, and the status says so already.
 */
export function finishedWork(before: SessionFacts, after: SessionFacts): boolean {
    const wasBusy = isTurnActive(before) || before.permission || before.blocked !== null;
    const nowIdle = !isTurnActive(after) && after.online && !after.permission && after.blocked === null;
    return wasBusy && nowIdle;
}

/** Is anything at all running behind this session, foreground or background? */
export function hasWorkInFlight(facts: SessionFacts): boolean {
    return isTurnActive(facts) || facts.agents !== null || facts.tasks !== null;
}


/**
 * Should this session be kept out of the list?
 *
 * Headless means "nobody is watching", not "never show me this". A headless
 * session that is blocked on an approval or a sign-in is exactly the case
 * where hiding it costs you the day, so it comes back the moment it needs a
 * human — the same rule a collapsed group follows: compress, never conceal.
 */
export function hiddenFromList(facts: SessionFacts): boolean {
    if (!facts.headless) return false;
    // An automation run is headless — nobody is watching it — but while it is
    // RUNNING it has a home: the automation that produced it, and its own
    // section in the list. The marker is a visibility override that lasts
    // exactly as long as the run, which is why a finished run leaves the list
    // on its own and there is no retention rule anywhere. A FAILED run keeps
    // the marker until it is dismissed.
    if (facts.automation) return false;
    return !facts.blocked && !facts.permission;
}

/** Where an automation run belongs in the list: its own section while it
 *  works, and above everything when it has failed. Null for anything that is
 *  not a run. */
export function automationPlacement(facts: SessionFacts): 'failed' | 'running' | null {
    if (!facts.automation) return null;
    return facts.automation.failed ? 'failed' : 'running';
}
