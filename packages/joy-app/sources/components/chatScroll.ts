/**
 * Who may move the chat viewport, and when. Pure and import-free; ChatList
 * reduces every event through it SYNCHRONOUSLY (a ref, not React state, so
 * a frame already scheduled reads the current permission) and carries out
 * the effects it returns, re-checking them at execution time.
 *
 * The rule that replaces fifty scroll fixes: following the newest message is
 * a decision the READER makes, never one inferred from geometry. The old
 * follow latch (chatFollow.updateFollowScroll) re-armed itself from any
 * scroll report at the bottom, whatever caused it: content shrinking under
 * a reader and clamping them to the new end, a FlashList anchor correction
 * landing inside the 48px band, a late scrollToEnd from its deferred
 * wrapper. The next streamed batch then pulled the reader down and kept
 * them there: "when I scroll up it jumps to the bottom". Each earlier fix
 * closed one way into that latch; this machine has no latch to reach.
 * (Joint Claude + gpt-6-astra diagnosis, 2026-09-27; reproduced in
 * dev/chat-scroll-lab: wheel up 400px, the reply below shrinks, the stream
 * resumes, the list follows it.)
 *
 * So:
 *  - Leaving `following` takes the reader moving toward older content (or,
 *    on native, starting a drag at all — see below).
 *  - Returning takes an interaction whose ONLY movement was toward newer
 *    content, that ended inside the live band, with no shrink of the scroll
 *    range during it (geometry must not do the returning); or the down
 *    button; or sending a prompt.
 *  - Scroll reports outside an interaction are facts about the viewport
 *    (the buttons read them); they never change the mode.
 *  - Every programmatic operation carries a generation; user input bumps it,
 *    so a restore or jump that is still settling stops.
 *
 * Intent comes from sources FlashList cannot swallow: it drops the list's
 * onScroll for 100ms after each data-length correction, so the scroll
 * stream alone is not a complete account of what the user did. Web reads
 * its own wheel/key/pointer listeners; native reads drag and momentum
 * callbacks, which bypass that filter. Native begin/end offsets still mix
 * the reader's movement with anchor corrections, so a native drag revokes
 * following when it STARTS, and reattaches only when the reader reached the
 * true end of the list (an anchor correction does not land there by
 * accident the way it lands inside a 48px band) with no movement toward
 * older anywhere in the gesture, the final report included (gpt-6-astra,
 * rounds 2 and 3).
 */

/** A reader within this many px of the end counts as at the bottom — only
 *  when THEY brought the viewport there. */
export const LIVE_BAND = 48;
/** Native drags must reach the end itself (see the header). */
export const NATIVE_END_BAND = 1;
/** Wheel and key input have no end event; a quiet gap ends them. */
export const WHEEL_IDLE_MS = 150;
export const KEY_IDLE_MS = 300;
/** Between a native drag's release and its momentum starting, nothing may
 *  move the list; a release with no momentum ends after this. */
export const RELEASE_GRACE_MS = 150;

export type Mode = 'following' | 'reading';
type Phase = 'wheel' | 'key' | 'drag' | 'release' | 'momentum' | 'pointer';
type Dir = 'older' | 'newer';

export interface Metrics {
    /** contentOffset.y, unclamped: iOS overscroll past the end is movement
     *  toward newer content. */
    offset: number;
    /** contentSize - viewport, floored at 0. */
    maxOffset: number;
}

export interface Interaction {
    phase: Phase;
    /** Movement toward older content was seen (it can never resume following). */
    sawOlder: boolean;
    sawNewer: boolean;
    /** The scroll range shrank while the reader's hands were on the list
     *  (measured observation to observation, so growth first cannot hide
     *  it): reaching the band may be geometry's doing, not theirs. */
    shrank: boolean;
    /** A native drag/momentum: reattach only at the true end. */
    native: boolean;
    /** Timed phases (wheel, key, release) end when `now` passes this. */
    until: number | null;
    startOffset: number | null;
}

export interface ScrollState {
    mode: Mode;
    /** Bumps on user input and on every new programmatic operation; a step
     *  that captured an older value must stop. */
    gen: number;
    /** The programmatic operation in flight (restore, prompt/search jump). */
    op: { kind: 'restore' | 'navigate'; gen: number } | null;
    interaction: Interaction | null;
    /** Two independent facts: a route hidden under another screen, and the
     *  app in the background. Either stops every command. */
    hidden: boolean;
    background: boolean;
    metrics: Metrics | null;
    /** When a native drag's release last ended: a momentum start shortly
     *  after is that fling's (delivered late). Any other momentum start is
     *  an Android programmatic animation, which is not the reader. */
    releaseEndedAt: number | null;
    /** A suspension cut a restore short: the saved snapshot is still the
     *  truth, and must not be overwritten by the half-restored viewport. */
    restoreInterrupted: boolean;
}

export type ScrollEvent =
    /** Web wheel on the list's own scroller; `dy` < 0 is toward older. */
    | { type: 'wheel'; dy: number; now: number }
    /** Web keyboard scrolling of the list (PageUp, Home, arrows, space...). */
    | { type: 'key'; dir: Dir; now: number }
    /** Native drag start/end, native momentum start/end, web pointer
     *  (scrollbar, touch) down/up. An end only closes the matching phase:
     *  iOS also reports momentum end for programmatic animations. */
    | { type: 'dragStart'; metrics: Metrics | null; now: number }
    | { type: 'dragEnd'; metrics: Metrics | null; now: number }
    | { type: 'momentumStart'; metrics: Metrics | null; now: number }
    | { type: 'momentumEnd'; metrics: Metrics | null; now: number }
    | { type: 'pointerDown'; metrics: Metrics | null; now: number }
    | { type: 'pointerUp'; metrics: Metrics | null; now: number }
    /** Any observed scroll position, whatever moved it. */
    | { type: 'scroll'; metrics: Metrics; now: number }
    /** Data, content size or viewport size changed; `metrics` when the
     *  caller can read them synchronously (web). */
    | { type: 'geometry'; metrics?: Metrics; now: number }
    /** Time passed with no event (ends wheel/key/release phases). */
    | { type: 'tick'; metrics?: Metrics; now: number }
    | { type: 'bottomPressed'; now: number }
    /** This client sent a prompt: the reader wants the reply. */
    | { type: 'sent'; now: number }
    | { type: 'navigate'; now: number }
    | { type: 'restore'; live: boolean; now: number }
    | { type: 'opDone'; gen: number; now: number }
    | { type: 'routeHidden'; now: number }
    | { type: 'routeShown'; now: number }
    | { type: 'appBackground'; now: number }
    | { type: 'appActive'; now: number };

export type ScrollEffect =
    /** Pin the newest content: one immediate, non-animated native command. */
    | { type: 'followBottom' }
    /** An explicit trip to the end (down button, send). */
    | { type: 'scrollToBottom'; animated: boolean }
    /** Carry out the operation just started under `gen`. */
    | { type: 'startOp'; kind: 'restore' | 'navigate'; gen: number };

export const initialScrollState = (): ScrollState => ({
    mode: 'following', gen: 0, op: null, interaction: null, hidden: false, background: false, metrics: null,
    releaseEndedAt: null, restoreInterrupted: false,
});

/** How long after a release a late momentum start still belongs to it. */
export const LATE_MOMENTUM_MS = 400;

export const isSuspended = (s: ScrollState): boolean => s.hidden || s.background;

/** Whether the reader's hands are on the list at `now`. */
export function isInteracting(s: ScrollState, now: number): boolean {
    const i = s.interaction;
    return i !== null && (i.until === null || now < i.until);
}

/** May an automatic follow command run now? Checked when the effect is
 *  produced AND again when ChatList executes it. */
export function mayFollow(s: ScrollState, now: number): boolean {
    return s.mode === 'following' && !isSuspended(s) && s.op === null && !isInteracting(s, now);
}

export function distanceFromBottom(m: Metrics): number {
    return Math.max(0, m.maxOffset - m.offset);
}

function begin(s: ScrollState, phase: Phase, metrics: Metrics | null, until: number | null): ScrollState {
    const m = metrics ?? s.metrics;
    const native = phase === 'drag' || phase === 'release' || phase === 'momentum';
    return {
        ...s, metrics: m,
        interaction: { phase, sawOlder: false, sawNewer: false, shrank: false, native, until, startOffset: m?.offset ?? null },
    };
}

/** Record the reader moving. Toward older leaves following at once, so no
 *  geometry callback mid-gesture can follow. */
function saw(s: ScrollState, dir: Dir): ScrollState {
    if (!s.interaction) return s;
    const interaction = { ...s.interaction, sawOlder: s.interaction.sawOlder || dir === 'older', sawNewer: s.interaction.sawNewer || dir === 'newer' };
    return { ...s, interaction, mode: dir === 'older' ? 'reading' : s.mode };
}

/** New metrics while an interaction is open: note shrink, and (for phases
 *  with no input deltas of their own) the offset's direction. */
function observe(s: ScrollState, m: Metrics, directional: boolean): ScrollState {
    const i = s.interaction;
    if (!i) return { ...s, metrics: m };
    let next: ScrollState = s;
    if (s.metrics && m.maxOffset < s.metrics.maxOffset - 1) next = { ...next, interaction: { ...next.interaction!, shrank: true } };
    if (directional && s.metrics) {
        const dir = directionOf(s.metrics, m);
        if (dir) next = saw(next, dir);
    }
    return { ...next, metrics: m };
}

/** The reader's direction between two reports, or null when the movement
 *  is iOS's elastic spring-back: pulling past an end is intent (past the
 *  bottom = toward newer), the bounce back into range is not. */
export function directionOf(prev: Metrics, m: Metrics): Dir | null {
    const d = m.offset - prev.offset;
    if (d === 0) return null;
    // Past the bottom and moving back toward it, or past the top and moving
    // back down toward 0: the spring, not the reader.
    if (prev.offset > prev.maxOffset && d < 0) return null;
    if (prev.offset < 0 && d > 0) return null;
    return d < 0 ? 'older' : 'newer';
}

/** Close the interaction: the evidence it gathered decides the mode. */
function end(s: ScrollState, metrics: Metrics | null): ScrollState {
    const i = s.interaction;
    if (!i) return s;
    // The final report counts as movement for phases without input deltas:
    // a reversal in the last stretch (its onScroll swallowed) is still one.
    const directional = i.phase === 'drag' || i.phase === 'release' || i.phase === 'momentum' || i.phase === 'pointer';
    let next = metrics ? observe(s, metrics, directional) : s;
    const ii = next.interaction!;
    const m = next.metrics;
    let { sawOlder, sawNewer } = ii;
    // No deltas seen at all (a native drag whose onScroll FlashList
    // swallowed): the net offset is the only evidence left.
    if (!sawOlder && !sawNewer && m && ii.startOffset !== null && m.offset !== ii.startOffset) {
        if (m.offset < ii.startOffset) sawOlder = true; else sawNewer = true;
    }
    let mode = next.mode;
    if (sawOlder) mode = 'reading';
    else if (sawNewer && !ii.shrank && m && distanceFromBottom(m) <= (ii.native ? NATIVE_END_BAND : LIVE_BAND)) mode = 'following';
    const releaseEndedAt = i.phase === 'release' ? i.until : next.releaseEndedAt;
    next = { ...next, mode, interaction: null, releaseEndedAt };
    return next;
}

/** User input cancels any programmatic operation in flight. */
function takeOver(s: ScrollState): ScrollState {
    return { ...s, gen: s.gen + 1, op: null, restoreInterrupted: false };
}

export function nextScrollState(state: ScrollState, event: ScrollEvent): { state: ScrollState; effects: ScrollEffect[] } {
    let s = state;
    // A timed phase ends by going quiet; settle it before this event — except
    // a momentum start, which continues its drag's release however late the
    // callback arrives.
    const rescue = event.type === 'momentumStart' && s.interaction?.phase === 'release';
    if (!rescue && s.interaction?.until != null && event.now >= s.interaction.until) {
        s = end(s, event.type === 'tick' || event.type === 'geometry' ? event.metrics ?? null : null);
    }
    const effects: ScrollEffect[] = [];
    const phase = s.interaction?.phase;

    switch (event.type) {
        case 'wheel':
        case 'key': {
            if (event.type === 'wheel' && event.dy === 0) break;
            const dir: Dir = event.type === 'wheel' ? (event.dy < 0 ? 'older' : 'newer') : event.dir;
            const until = event.now + (event.type === 'wheel' ? WHEEL_IDLE_MS : KEY_IDLE_MS);
            s = takeOver(s);
            if (phase === event.type) s = { ...s, interaction: { ...s.interaction!, until } };
            else s = begin(s, event.type, null, until);
            s = saw(s, dir);
            break;
        }
        case 'dragStart':
            // Native offsets mix the reader's movement with anchor
            // corrections: a drag revokes following outright.
            s = { ...begin(takeOver(s), 'drag', event.metrics, null), mode: 'reading' };
            break;
        case 'dragEnd':
            if (phase !== 'drag') break;
            // Hold the list still until momentum starts or the grace ends.
            s = { ...s, interaction: { ...s.interaction!, phase: 'release', until: event.now + RELEASE_GRACE_MS } };
            if (event.metrics) s = observe(s, event.metrics, true);
            break;
        case 'momentumStart':
            // Only a reader's fling decelerates (programmatic animations report
            // an END, never a start), so this is always their gesture.
            if (phase === 'release') s = { ...s, interaction: { ...s.interaction!, phase: 'momentum', until: null } };
            else if (!s.interaction && s.releaseEndedAt !== null && event.now - s.releaseEndedAt <= LATE_MOMENTUM_MS) {
                s = { ...begin(takeOver(s), 'momentum', event.metrics, null), mode: 'reading', releaseEndedAt: null };
            }
            // Otherwise an Android programmatic animation (animated scrollTo
            // runs as a fling there): not the reader, and it must not cancel
            // the operation that started it.
            break;
        case 'momentumEnd':
            if (phase === 'momentum') s = end(s, event.metrics);
            else if (event.metrics && !s.interaction) s = { ...s, metrics: event.metrics };
            break;
        case 'pointerDown':
            s = begin(takeOver(s), 'pointer', event.metrics, null);
            break;
        case 'pointerUp':
            if (phase === 'pointer') s = end(s, event.metrics);
            break;
        case 'scroll':
            // Drag/momentum/pointer carry no deltas of their own: the offset's
            // movement is the evidence (conservative — see `end`). Wheel and
            // key already carry theirs.
            s = observe(s, event.metrics, phase === 'drag' || phase === 'momentum' || phase === 'pointer');
            break;
        case 'geometry':
        case 'tick':
            if (event.metrics) s = observe(s, event.metrics, false);
            break;
        case 'bottomPressed':
        case 'sent':
            s = { ...takeOver(s), mode: 'following', interaction: null };
            if (!isSuspended(s)) effects.push({ type: 'scrollToBottom', animated: event.type === 'bottomPressed' });
            return { state: s, effects };
        case 'navigate': {
            const gen = s.gen + 1;
            // A new owner: an older gesture's release no longer vouches for a
            // momentum start (it is this jump's animation), and the jump, not
            // an interrupted restore, is now where the reader is.
            s = { ...s, gen, op: { kind: 'navigate', gen }, mode: 'reading', interaction: null, releaseEndedAt: null, restoreInterrupted: false };
            effects.push({ type: 'startOp', kind: 'navigate', gen });
            return { state: s, effects };
        }
        case 'restore': {
            // Never over a reader's hands, never while hidden.
            if (isSuspended(s) || isInteracting(s, event.now)) return { state: s, effects };
            const gen = s.gen + 1;
            s = { ...s, restoreInterrupted: false };
            if (event.live) {
                s = { ...s, gen, op: null, mode: 'following' };
                effects.push({ type: 'followBottom' });
                return { state: s, effects };
            }
            s = { ...s, gen, op: { kind: 'restore', gen }, mode: 'reading' };
            effects.push({ type: 'startOp', kind: 'restore', gen });
            return { state: s, effects };
        }
        case 'opDone':
            if (s.op && s.op.gen === event.gen) s = { ...s, op: null };
            break;
        case 'routeHidden':
        case 'appBackground':
            s = {
                ...s, gen: s.gen + 1, op: null, interaction: null,
                restoreInterrupted: s.restoreInterrupted || s.op?.kind === 'restore',
                [event.type === 'routeHidden' ? 'hidden' : 'background']: true,
            };
            return { state: s, effects };
        case 'routeShown':
            s = { ...s, hidden: false };
            break;
        case 'appActive':
            s = { ...s, background: false };
            break;
    }

    // The one automatic move: a following reader, hands off, nothing else
    // positioning, sees the newest content after anything changed.
    if (mayFollow(s, event.now) && (event.type === 'geometry' || event.type === 'tick'
        || event.type === 'momentumEnd' || event.type === 'pointerUp' || event.type === 'wheel' || event.type === 'key')) {
        effects.push({ type: 'followBottom' });
    }
    return { state: s, effects };
}

/**
 * Which turn's agent work stays unfolded. While the agent works, its tool
 * calls show as rows; folding them into one "agent work" group the instant
 * the turn ends removed the rows a reader was looking at and, with them, the
 * anchor the list held the viewport on — "it jumps when a new message comes
 * in". So the latest turn is held open from the moment it starts thinking
 * until the NEXT prompt arrives; the fold then lands in the same commit as
 * the new row, where the follow is already moving the viewport. A session
 * opened at rest (nothing thinking) folds its last turn as before.
 */
export function heldOpenTurn(held: string | null, thinking: boolean, latestPromptId: string | null): string | null {
    if (thinking) return latestPromptId;
    return held === latestPromptId ? held : null;
}
