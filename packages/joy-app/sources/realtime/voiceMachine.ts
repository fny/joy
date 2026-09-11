/**
 * The voice orchestrator's state, as one machine. Pure, import-free.
 *
 * The comment at the top of RealtimeSession.ts has always named these states
 * — DISARMED, ARMED and hung up, CONNECTING, LIVE, ERROR — but the code kept
 * them as ten module-level variables (a session pointer, a connecting flag,
 * a connectedAt, an intentional-stop flag reset in four places, two timers,
 * a reconnect counter…) plus the store's status. Here the state is one value
 * and every rule is a case:
 *
 *  · a connect attempt is a GENERATION: the async sequence that runs it
 *    (mic permission, token, SDK connect) checks after every await that its
 *    generation is still the one the machine is in, and a hang-up or an end
 *    retires it by leaving the state (#244);
 *  · "intentional stop" is not a flag but a fact of the state: an SDK
 *    disconnect that arrives while hung up or disarmed is what we asked for,
 *    and reconnects nothing;
 *  · a drop reconnects with backoff min(800·2^n, 8000) ms, MAX_RECONNECT_ATTEMPTS
 *    times, then parks in `error`;
 *  · `error` is armed but parked (#20): a tap or a session event retries,
 *    ambient sound does not — the detector never listens in error;
 *  · a call refused right after it came up (isRejectedAfterConnect) parks in
 *    error with the reason, instead of being retried four times (#339's
 *    sibling) or read as the agent hanging up (#343);
 *  · the agent ending a real call: standby stays armed and hung up (#343),
 *    classic is over;
 *  · idle hang-up is standby's only: classic stays live until ended;
 *  · a denied microphone disarms (#25); a failed sound-wake connect leaves
 *    the machine in error, not armed-with-no-listener (#337);
 *  · a failed or abandoned connect retires the context ledger (#340).
 *
 * The machine decides; the orchestrator performs the effects (the SDK, the
 * sound detector, the timers, the store) and feeds the outcomes back.
 */
import type { VoiceMode, VoiceStatus } from './voiceRules';

export const MAX_RECONNECT_ATTEMPTS = 4;
export function reconnectDelayMs(attempt: number): number {
    return Math.min(800 * 2 ** attempt, 8000);
}

export type VoiceState =
    | { kind: 'disarmed' }
    /** Armed, no line. Whether the sound detector listens is `listenEffect`'s answer. */
    | { kind: 'hung_up'; sessionId: string }
    /** A connect sequence is running under `gen`. `attempt` counts the
     *  reconnects behind it (0 = a fresh start); `overrides` = the connect
     *  sent prompt/first-message overrides (standby), named in a refusal. */
    | { kind: 'connecting'; sessionId: string; gen: number; attempt: number; silent: boolean; overrides: boolean }
    | { kind: 'live'; sessionId: string; gen: number; connectedAt: number; overrides: boolean }
    /** A drop: waiting out the backoff before reconnect `attempt`. */
    | { kind: 'reconnect_wait'; sessionId: string; gen: number; attempt: number; retryAt: number }
    /** Armed but parked: a tap or an event retries, nothing else does. */
    | { kind: 'error'; sessionId: string };

export type ConnectCause = 'tap' | 'event' | 'sound' | 'reconnect';

export type VoiceEvent =
    | { type: 'connect_requested'; sessionId: string; cause: ConnectCause; silent: boolean }
    | { type: 'connect_ok'; gen: number }
    | { type: 'connect_failed'; gen: number; reason: string }
    | { type: 'connect_denied'; gen: number }
    | { type: 'connect_cancelled'; gen: number }
    /** Close the line, stay armed (a tap on the live strip, the idle timer). */
    | { type: 'hang_up' }
    /** Voice off: disconnect, disarm, forget. */
    | { type: 'disarm' }
    /** The SDK reported a disconnect nobody asked for. `refused`: the call
     *  died before a word (isRejectedAfterConnect). */
    | { type: 'dropped'; refused: boolean; reason: string | null }
    /** The agent ended the call itself (end_call). */
    | { type: 'agent_ended'; refused: boolean }
    | { type: 'reconnect_due'; gen: number }
    /** The idle timer fired; `busy` = someone is speaking or a prompt is queued. */
    | { type: 'idle_timeout'; busy: boolean }
    | { type: 'activity' }
    | { type: 'app_background' }
    | { type: 'app_foreground' }
    | { type: 'tick' };

/** Settings and surroundings the decisions depend on, read at each step. */
export type VoiceEnv = {
    mode: VoiceMode;
    wakeOnSound: boolean;
    wakeOnEvents: boolean;
    appActive: boolean;
    idleTimeoutMs: number;
    now: number;
};

export type VoiceEffect =
    | { type: 'connect'; gen: number; sessionId: string; silent: boolean; soundWake: boolean; reconnect: boolean }
    | { type: 'end_session' }
    | { type: 'listen' }
    | { type: 'stop_listening' }
    | { type: 'arm_idle_timer'; ms: number }
    | { type: 'clear_idle_timer' }
    | { type: 'schedule_reconnect'; gen: number; delayMs: number }
    | { type: 'clear_reconnect_timer' }
    | { type: 'status'; status: VoiceStatus }
    | { type: 'armed'; sessionId: string | null }
    /** The line is gone (or never came): retire the context ledger (#340). */
    | { type: 'disconnected_hooks' }
    /** Forget the armed session: transcript, queued prompts, focus pointers. */
    | { type: 'disarm' }
    | { type: 'park_refused'; reason: string | null; overrides: boolean }
    | { type: 'alert_failed'; reason: string }
    | { type: 'log'; line: string };

export interface VoiceStep { state: VoiceState; effects: VoiceEffect[] }

export const DISARMED: VoiceState = { kind: 'disarmed' };

export function statusOf(s: VoiceState): VoiceStatus {
    switch (s.kind) {
        case 'disarmed': return 'disconnected';
        case 'hung_up': return 'disconnected';
        case 'connecting': return 'connecting';
        case 'reconnect_wait': return 'connecting';
        case 'live': return 'connected';
        case 'error': return 'error';
    }
    return unreachable(s);
}

export function armedSessionOf(s: VoiceState): string | null {
    return s.kind === 'disarmed' ? null : s.sessionId;
}

/** Is `gen` the attempt the machine is in (connecting) or came from (live)? */
export function isCurrentGen(s: VoiceState, gen: number): boolean {
    return (s.kind === 'connecting' || s.kind === 'live') && s.gen === gen;
}

/** Whether the local sound detector should run: armed, hung up, standby,
 *  the setting on, and the app up front (voiceRules.canListenWhileIdle). */
export function shouldListen(s: VoiceState, env: VoiceEnv): boolean {
    return s.kind === 'hung_up' && env.mode === 'standby' && env.wakeOnSound && env.appActive;
}

const listenEffect = (s: VoiceState, env: VoiceEnv): VoiceEffect[] => (shouldListen(s, env) ? [{ type: 'listen' }] : []);
const idleTimer = (env: VoiceEnv): VoiceEffect[] => (env.mode === 'standby' && env.idleTimeoutMs > 0 ? [{ type: 'arm_idle_timer', ms: env.idleTimeoutMs }] : []);

let genCounter = 0;
/** Generations only ever grow, across every session of the process. */
function mint(): number { return ++genCounter; }

function connect(sessionId: string, attempt: number, cause: ConnectCause, silent: boolean, env: VoiceEnv, extra: VoiceEffect[] = []): VoiceStep {
    const gen = mint();
    return {
        state: { kind: 'connecting', sessionId, gen, attempt, silent, overrides: env.mode === 'standby' },
        effects: [
            ...extra,
            { type: 'armed', sessionId },
            { type: 'stop_listening' },
            { type: 'connect', gen, sessionId, silent, soundWake: cause === 'sound', reconnect: cause === 'reconnect' },
            { type: 'status', status: 'connecting' },
        ],
    };
}

function hungUp(sessionId: string, env: VoiceEnv, extra: VoiceEffect[] = []): VoiceStep {
    const state: VoiceState = { kind: 'hung_up', sessionId };
    return { state, effects: [...extra, { type: 'clear_idle_timer' }, { type: 'clear_reconnect_timer' }, { type: 'end_session' }, { type: 'disconnected_hooks' }, { type: 'status', status: 'disconnected' }, ...listenEffect(state, env)] };
}

function disarmed(extra: VoiceEffect[] = []): VoiceStep {
    return { state: DISARMED, effects: [...extra, { type: 'armed', sessionId: null }, { type: 'clear_idle_timer' }, { type: 'clear_reconnect_timer' }, { type: 'end_session' }, { type: 'stop_listening' }, { type: 'disconnected_hooks' }, { type: 'disarm' }, { type: 'status', status: 'disconnected' }] };
}

function parked(sessionId: string, extra: VoiceEffect[] = []): VoiceStep {
    return { state: { kind: 'error', sessionId }, effects: [...extra, { type: 'clear_idle_timer' }, { type: 'clear_reconnect_timer' }, { type: 'status', status: 'error' }] };
}

/** After a drop or a failed reconnect: the next attempt, or the budget's end. */
function afterDrop(sessionId: string, attempt: number, env: VoiceEnv, extra: VoiceEffect[]): VoiceStep {
    if (attempt >= MAX_RECONNECT_ATTEMPTS) {
        return parked(sessionId, [...extra, { type: 'log', line: 'reconnect budget exhausted — staying armed; a tap or a session event retries' }]);
    }
    const gen = mint();
    const delayMs = reconnectDelayMs(attempt);
    return {
        state: { kind: 'reconnect_wait', sessionId, gen, attempt, retryAt: env.now + delayMs },
        effects: [...extra, { type: 'log', line: `reconnect ${attempt + 1}/${MAX_RECONNECT_ATTEMPTS} in ${delayMs}ms` }, { type: 'clear_reconnect_timer' }, { type: 'schedule_reconnect', gen, delayMs }, { type: 'status', status: 'connecting' }],
    };
}

const same = (state: VoiceState, effects: VoiceEffect[] = []): VoiceStep => ({ state, effects });

export function nextVoice(s: VoiceState, ev: VoiceEvent, env: VoiceEnv): VoiceStep {
    // Answers that do not depend on the state.
    if (ev.type === 'disarm') return s.kind === 'disarmed' ? same(s, [{ type: 'end_session' }, { type: 'stop_listening' }, { type: 'disconnected_hooks' }, { type: 'disarm' }]) : disarmed();
    if (ev.type === 'hang_up') return s.kind === 'disarmed' ? same(s, [{ type: 'clear_idle_timer' }, { type: 'clear_reconnect_timer' }, { type: 'end_session' }, { type: 'disconnected_hooks' }]) : hungUp(s.sessionId, env);

    switch (s.kind) {
        case 'disarmed':
            switch (ev.type) {
                case 'connect_requested': return ev.cause === 'reconnect' ? same(s) : connect(ev.sessionId, 0, ev.cause, ev.silent, env);
                case 'connect_ok': return same(s);
                case 'connect_failed': return same(s);
                case 'connect_denied': return same(s);
                case 'connect_cancelled': return same(s, [{ type: 'disconnected_hooks' }]);
                case 'dropped': return same(s, [{ type: 'disconnected_hooks' }]);
                case 'agent_ended': return same(s, [{ type: 'disconnected_hooks' }]);
                case 'reconnect_due': return same(s);
                case 'idle_timeout': return same(s);
                case 'activity': return same(s);
                case 'app_background': return same(s, [{ type: 'stop_listening' }]);
                case 'app_foreground': return same(s);
                case 'tick': return same(s);
            }
            return unreachable(ev);
        case 'hung_up':
            switch (ev.type) {
                case 'connect_requested':
                    if (ev.cause === 'reconnect') return same(s);
                    if (ev.cause === 'event' && (env.mode === 'classic' || !env.wakeOnEvents)) return same(s);
                    if (ev.cause === 'sound' && !shouldListen(s, env)) return same(s);
                    return connect(ev.sessionId, 0, ev.cause, ev.silent, env);
                case 'connect_ok': return same(s);
                case 'connect_failed': return same(s);
                case 'connect_denied': return same(s);
                // An attempt we abandoned (a hang-up while it was pending) reported back.
                case 'connect_cancelled': return same(s, [{ type: 'disconnected_hooks' }, ...listenEffect(s, env)]);
                // What we asked for: no reconnect.
                case 'dropped': return same(s, [{ type: 'disconnected_hooks' }]);
                case 'agent_ended': return same(s, [{ type: 'disconnected_hooks' }]);
                case 'reconnect_due': return same(s);
                case 'idle_timeout': return same(s);
                case 'activity': return same(s);
                case 'app_background': return same(s, [{ type: 'stop_listening' }]);
                case 'app_foreground': return same(s, listenEffect(s, env));
                case 'tick': return same(s, listenEffect(s, env));
            }
            return unreachable(ev);
        case 'connecting':
            switch (ev.type) {
                case 'connect_requested': return same(s); // already on it
                case 'connect_ok':
                    if (ev.gen !== s.gen) return same(s);
                    return { state: { kind: 'live', sessionId: s.sessionId, gen: s.gen, connectedAt: env.now, overrides: s.overrides }, effects: [{ type: 'clear_reconnect_timer' }, ...idleTimer(env), { type: 'status', status: 'connected' }] };
                case 'connect_failed': {
                    if (ev.gen !== s.gen) return same(s);
                    const retired: VoiceEffect[] = [{ type: 'disconnected_hooks' }];
                    // A fresh start that failed parks, visibly (#20, #337); a
                    // reconnect that failed keeps the backoff going.
                    if (s.attempt === 0) return parked(s.sessionId, [...retired, ...(s.silent ? [] : [{ type: 'alert_failed', reason: ev.reason } as VoiceEffect])]);
                    return afterDrop(s.sessionId, s.attempt, env, retired);
                }
                case 'connect_denied': return ev.gen === s.gen ? disarmed() : same(s);
                case 'connect_cancelled': return same(s); // only a retired generation reports this
                case 'dropped': return same(s, [{ type: 'disconnected_hooks' }]);
                case 'agent_ended': return same(s, [{ type: 'disconnected_hooks' }]);
                case 'reconnect_due': return same(s);
                case 'idle_timeout': return same(s);
                case 'activity': return same(s);
                case 'app_background': return same(s);
                case 'app_foreground': return same(s);
                case 'tick': return same(s);
            }
            return unreachable(ev);
        case 'live':
            switch (ev.type) {
                case 'connect_requested': return same(s);
                case 'connect_ok': return same(s); // the SDK and the sequence both report it
                case 'connect_failed': return same(s);
                case 'connect_denied': return same(s);
                case 'connect_cancelled': return same(s);
                case 'dropped': {
                    const retired: VoiceEffect[] = [{ type: 'clear_idle_timer' }, { type: 'disconnected_hooks' }];
                    if (ev.refused) return parked(s.sessionId, [...retired, { type: 'park_refused', reason: ev.reason, overrides: s.overrides }]);
                    return afterDrop(s.sessionId, 0, env, retired);
                }
                case 'agent_ended': {
                    const retired: VoiceEffect[] = [{ type: 'clear_idle_timer' }, { type: 'disconnected_hooks' }];
                    if (ev.refused) return parked(s.sessionId, [...retired, { type: 'park_refused', reason: null, overrides: s.overrides }]);
                    // The user asked the agent to hang up: standby stands by
                    // (#343); classic has nowhere to stand.
                    if (env.mode === 'classic') return disarmed(retired);
                    const state: VoiceState = { kind: 'hung_up', sessionId: s.sessionId };
                    return { state, effects: [...retired, { type: 'clear_reconnect_timer' }, { type: 'status', status: 'disconnected' }, ...listenEffect(state, env)] };
                }
                case 'reconnect_due': return same(s);
                case 'idle_timeout':
                    if (ev.busy) return same(s, idleTimer(env));
                    return hungUp(s.sessionId, env, [{ type: 'log', line: 'idle — hanging up (still armed)' }]);
                case 'activity': return same(s, idleTimer(env));
                case 'app_background': return same(s); // the mic is ours while live
                case 'app_foreground': return same(s);
                case 'tick': return same(s);
            }
            return unreachable(ev);
        case 'reconnect_wait':
            switch (ev.type) {
                case 'connect_requested':
                    // A tap does not wait for the timer; an event does (the
                    // line is coming back); sound is not listened for.
                    if (ev.cause !== 'tap') return same(s);
                    return connect(ev.sessionId, 0, 'tap', ev.silent, env, [{ type: 'clear_reconnect_timer' }]);
                case 'connect_ok': return same(s);
                case 'connect_failed': return same(s);
                case 'connect_denied': return same(s);
                case 'connect_cancelled': return same(s);
                case 'dropped': return same(s, [{ type: 'disconnected_hooks' }]);
                case 'agent_ended': return same(s, [{ type: 'disconnected_hooks' }]);
                case 'reconnect_due':
                    if (ev.gen !== s.gen) return same(s);
                    return connect(s.sessionId, s.attempt + 1, 'reconnect', true, env);
                case 'idle_timeout': return same(s);
                case 'activity': return same(s);
                case 'app_background': return same(s);
                case 'app_foreground': return same(s);
                case 'tick': return same(s);
            }
            return unreachable(ev);
        case 'error':
            switch (ev.type) {
                // A tap or a session event retries; sound does not (#20).
                case 'connect_requested':
                    if (ev.cause === 'sound' || ev.cause === 'reconnect') return same(s);
                    if (ev.cause === 'event' && (env.mode === 'classic' || !env.wakeOnEvents)) return same(s);
                    return connect(ev.sessionId, 0, ev.cause, ev.silent, env);
                case 'connect_ok': return same(s);
                case 'connect_failed': return same(s);
                case 'connect_denied': return same(s);
                case 'connect_cancelled': return same(s, [{ type: 'disconnected_hooks' }]);
                case 'dropped': return same(s, [{ type: 'disconnected_hooks' }]);
                case 'agent_ended': return same(s, [{ type: 'disconnected_hooks' }]);
                case 'reconnect_due': return same(s);
                case 'idle_timeout': return same(s);
                case 'activity': return same(s);
                case 'app_background': return same(s);
                case 'app_foreground': return same(s);
                case 'tick': return same(s);
            }
            return unreachable(ev);
    }
    return unreachable(s);
}

function unreachable(x: never): never {
    throw new Error(`voice: unhandled ${JSON.stringify(x)}`);
}
