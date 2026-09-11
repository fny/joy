import { describe, it, expect } from 'vitest';
import {
    DISARMED, MAX_RECONNECT_ATTEMPTS, armedSessionOf, isCurrentGen, nextVoice, reconnectDelayMs, shouldListen, statusOf,
    type VoiceEffect, type VoiceEnv, type VoiceEvent, type VoiceState,
} from './voiceMachine';

const S = 'session-A';
const now = 1_000_000;
const standby: VoiceEnv = { mode: 'standby', wakeOnSound: true, wakeOnEvents: true, appActive: true, idleTimeoutMs: 30_000, now };
const classic: VoiceEnv = { ...standby, mode: 'classic' };

const hungUp: VoiceState = { kind: 'hung_up', sessionId: S };
const connecting = (attempt = 0, silent = false): VoiceState => ({ kind: 'connecting', sessionId: S, gen: 5, attempt, silent, overrides: true });
const live: VoiceState = { kind: 'live', sessionId: S, gen: 5, connectedAt: now - 60_000, overrides: true };
const waiting: VoiceState = { kind: 'reconnect_wait', sessionId: S, gen: 6, attempt: 1, retryAt: now + 1600 };
const error: VoiceState = { kind: 'error', sessionId: S };

const STATES: Array<[string, VoiceState]> = [
    ['disarmed', DISARMED], ['hung_up', hungUp], ['connecting', connecting()], ['connecting(reconnect 2)', connecting(2, true)],
    ['live', live], ['reconnect_wait', waiting], ['error', error],
];
const EVENTS: Array<[string, VoiceEvent]> = [
    ['tap', { type: 'connect_requested', sessionId: S, cause: 'tap', silent: false }],
    ['event', { type: 'connect_requested', sessionId: S, cause: 'event', silent: true }],
    ['sound', { type: 'connect_requested', sessionId: S, cause: 'sound', silent: true }],
    ['connect_ok(own)', { type: 'connect_ok', gen: 5 }],
    ['connect_ok(stale)', { type: 'connect_ok', gen: 4 }],
    ['connect_failed(own)', { type: 'connect_failed', gen: 5, reason: 'no network' }],
    ['connect_failed(stale)', { type: 'connect_failed', gen: 4, reason: 'no network' }],
    ['connect_denied(own)', { type: 'connect_denied', gen: 5 }],
    ['connect_cancelled', { type: 'connect_cancelled', gen: 5 }],
    ['hang_up', { type: 'hang_up' }],
    ['disarm', { type: 'disarm' }],
    ['dropped', { type: 'dropped', refused: false, reason: null }],
    ['dropped(refused)', { type: 'dropped', refused: true, reason: 'Override not allowed' }],
    ['agent_ended', { type: 'agent_ended', refused: false }],
    ['agent_ended(refused)', { type: 'agent_ended', refused: true }],
    ['reconnect_due(own)', { type: 'reconnect_due', gen: 6 }],
    ['reconnect_due(stale)', { type: 'reconnect_due', gen: 3 }],
    ['idle_timeout(quiet)', { type: 'idle_timeout', busy: false }],
    ['idle_timeout(busy)', { type: 'idle_timeout', busy: true }],
    ['activity', { type: 'activity' }],
    ['app_background', { type: 'app_background' }],
    ['app_foreground', { type: 'app_foreground' }],
    ['tick', { type: 'tick' }],
];

/** The state KIND every pair must land in (standby env). Effects are checked
 *  by the rule tests below; the kind is the table's job, and a missing pair
 *  fails. */
function expectedKind(s: VoiceState, ev: VoiceEvent): VoiceState['kind'] {
    if (ev.type === 'disarm') return 'disarmed';
    if (ev.type === 'hang_up') return s.kind === 'disarmed' ? 'disarmed' : 'hung_up';
    switch (s.kind) {
        case 'disarmed':
            return ev.type === 'connect_requested' && ev.cause !== 'reconnect' ? 'connecting' : 'disarmed';
        case 'hung_up':
            return ev.type === 'connect_requested' && ev.cause !== 'reconnect' ? 'connecting' : 'hung_up';
        case 'connecting':
            if (ev.type === 'connect_ok' && ev.gen === s.gen) return 'live';
            if (ev.type === 'connect_failed' && ev.gen === s.gen) {
                if (s.attempt === 0) return 'error';
                return s.attempt >= MAX_RECONNECT_ATTEMPTS ? 'error' : 'reconnect_wait';
            }
            if (ev.type === 'connect_denied' && ev.gen === s.gen) return 'disarmed';
            return 'connecting';
        case 'live':
            if (ev.type === 'dropped') return ev.refused ? 'error' : 'reconnect_wait';
            if (ev.type === 'agent_ended') return ev.refused ? 'error' : 'hung_up';
            if (ev.type === 'idle_timeout' && !ev.busy) return 'hung_up';
            return 'live';
        case 'reconnect_wait':
            if (ev.type === 'connect_requested' && ev.cause === 'tap') return 'connecting';
            if (ev.type === 'reconnect_due' && ev.gen === s.gen) return 'connecting';
            return 'reconnect_wait';
        case 'error':
            return ev.type === 'connect_requested' && (ev.cause === 'tap' || ev.cause === 'event') ? 'connecting' : 'error';
    }
}

describe('voice machine (table: every state × every event, standby)', () => {
    for (const [sn, s] of STATES) for (const [en, ev] of EVENTS) {
        it(`${sn} × ${en}`, () => {
            const { state, effects } = nextVoice(s, ev, standby);
            expect(state.kind).toBe(expectedKind(s, ev));
            // The store's status follows the state whenever the state changed.
            if (state.kind !== s.kind) expect(effects.some((e) => e.type === 'status' && e.status === statusOf(state))).toBe(true);
            // A connecting state always carries a connect effect with its own gen.
            if (state.kind === 'connecting' && s.kind !== 'connecting') {
                const c = effects.find((e): e is Extract<VoiceEffect, { type: 'connect' }> => e.type === 'connect');
                expect(c?.gen).toBe(state.gen);
                expect(c?.sessionId).toBe(S);
            }
        });
    }
});

const has = (effects: VoiceEffect[], type: VoiceEffect['type']) => effects.some((e) => e.type === type);

describe('voice machine (rules)', () => {
    it('a connect attempt is a generation: a hang-up retires it, and its late answers are ignored', () => {
        const start = nextVoice(hungUp, { type: 'connect_requested', sessionId: S, cause: 'tap', silent: false }, standby);
        const gen = (start.state as Extract<VoiceState, { kind: 'connecting' }>).gen;
        expect(isCurrentGen(start.state, gen)).toBe(true);
        const hung = nextVoice(start.state, { type: 'hang_up' }, standby);
        expect(isCurrentGen(hung.state, gen)).toBe(false);
        expect(nextVoice(hung.state, { type: 'connect_ok', gen }, standby).state).toEqual(hung.state);
        expect(nextVoice(hung.state, { type: 'connect_failed', gen, reason: 'late' }, standby).state).toEqual(hung.state);
        // The abandoned attempt reporting back retires the ledger and resumes listening (#244, #337).
        const cancelled = nextVoice(hung.state, { type: 'connect_cancelled', gen }, standby);
        expect(has(cancelled.effects, 'disconnected_hooks')).toBe(true);
        expect(has(cancelled.effects, 'listen')).toBe(true);
    });

    it('a drop reconnects with backoff, four times, then parks in error; an SDK disconnect while hung up reconnects nothing', () => {
        let s: VoiceState = live;
        const delays: number[] = [];
        for (let n = 0; n < MAX_RECONNECT_ATTEMPTS; n++) {
            const dropped = nextVoice(s, n === 0 ? { type: 'dropped', refused: false, reason: null } : { type: 'connect_failed', gen: (s as Extract<VoiceState, { kind: 'connecting' }>).gen, reason: 'x' }, standby);
            expect(dropped.state.kind).toBe('reconnect_wait');
            const sched = dropped.effects.find((e): e is Extract<VoiceEffect, { type: 'schedule_reconnect' }> => e.type === 'schedule_reconnect')!;
            delays.push(sched.delayMs);
            const due = nextVoice(dropped.state, { type: 'reconnect_due', gen: sched.gen }, standby);
            expect(due.state).toMatchObject({ kind: 'connecting', attempt: n + 1, silent: true });
            s = due.state;
        }
        expect(delays).toEqual([800, 1600, 3200, 6400]);
        const spent = nextVoice(s, { type: 'connect_failed', gen: (s as Extract<VoiceState, { kind: 'connecting' }>).gen, reason: 'x' }, standby);
        expect(spent.state.kind).toBe('error');
        expect(has(spent.effects, 'schedule_reconnect')).toBe(false);
        expect(reconnectDelayMs(10)).toBe(8000);
        // Intentional stop is a fact of the state, not a flag.
        const late = nextVoice(hungUp, { type: 'dropped', refused: false, reason: null }, standby);
        expect(late.state).toEqual(hungUp);
        expect(has(late.effects, 'schedule_reconnect')).toBe(false);
        expect(has(late.effects, 'disconnected_hooks')).toBe(true);
    });

    it('a refused call parks with the reason and names the overrides; nothing retries by itself', () => {
        const r = nextVoice(live, { type: 'dropped', refused: true, reason: 'Override for field prompt' }, classic);
        expect(r.state.kind).toBe('error');
        expect(r.effects).toContainEqual({ type: 'park_refused', reason: 'Override for field prompt', overrides: true });
        expect(has(r.effects, 'schedule_reconnect')).toBe(false);
        // Sound does not wake an error (#20); a tap or an event does.
        expect(nextVoice(r.state, { type: 'connect_requested', sessionId: S, cause: 'sound', silent: true }, standby).state).toEqual(r.state);
        expect(nextVoice(r.state, { type: 'connect_requested', sessionId: S, cause: 'event', silent: true }, standby).state.kind).toBe('connecting');
        expect(shouldListen(r.state, standby)).toBe(false);
    });

    it('the agent ending a real call: standby stands by and listens, classic is over (#343)', () => {
        const sb = nextVoice(live, { type: 'agent_ended', refused: false }, standby);
        expect(sb.state).toEqual(hungUp);
        expect(has(sb.effects, 'listen')).toBe(true);
        expect(has(sb.effects, 'disarm')).toBe(false);
        const cl = nextVoice(live, { type: 'agent_ended', refused: false }, classic);
        expect(cl.state).toEqual(DISARMED);
        expect(has(cl.effects, 'disarm')).toBe(true);
        expect(cl.effects).toContainEqual({ type: 'armed', sessionId: null });
    });

    it('idle hang-up is standby\'s: the timer is armed on connect and on activity, re-armed while busy, and classic never arms it', () => {
        const up = nextVoice(connecting(), { type: 'connect_ok', gen: 5 }, standby);
        expect(up.effects).toContainEqual({ type: 'arm_idle_timer', ms: 30_000 });
        expect(nextVoice(live, { type: 'activity' }, standby).effects).toContainEqual({ type: 'arm_idle_timer', ms: 30_000 });
        expect(nextVoice(live, { type: 'idle_timeout', busy: true }, standby).effects).toContainEqual({ type: 'arm_idle_timer', ms: 30_000 });
        const quiet = nextVoice(live, { type: 'idle_timeout', busy: false }, standby);
        expect(quiet.state).toEqual(hungUp);
        expect(has(quiet.effects, 'end_session')).toBe(true);
        expect(has(nextVoice(connecting(), { type: 'connect_ok', gen: 5 }, classic).effects, 'arm_idle_timer')).toBe(false);
        expect(has(nextVoice(live, { type: 'activity' }, { ...standby, idleTimeoutMs: 0 }).effects, 'arm_idle_timer')).toBe(false);
    });

    it('a denied microphone disarms (#25); a failed fresh start parks and alerts unless silent; a failed sound-wake start parks too (#337)', () => {
        const denied = nextVoice(connecting(), { type: 'connect_denied', gen: 5 }, standby);
        expect(denied.state).toEqual(DISARMED);
        expect(denied.effects).toContainEqual({ type: 'armed', sessionId: null });
        const loud = nextVoice(connecting(0, false), { type: 'connect_failed', gen: 5, reason: 'boom' }, standby);
        expect(loud.state.kind).toBe('error');
        expect(loud.effects).toContainEqual({ type: 'alert_failed', reason: 'boom' });
        expect(has(loud.effects, 'disconnected_hooks')).toBe(true);
        const quiet = nextVoice(connecting(0, true), { type: 'connect_failed', gen: 5, reason: 'boom' }, standby);
        expect(quiet.state.kind).toBe('error');
        expect(has(quiet.effects, 'alert_failed')).toBe(false);
        expect(shouldListen(quiet.state, standby)).toBe(false);
    });

    it('listening: only armed, hung up, standby, setting on, app active — and foreground re-evaluates it', () => {
        expect(shouldListen(hungUp, standby)).toBe(true);
        expect(shouldListen(hungUp, classic)).toBe(false);
        expect(shouldListen(hungUp, { ...standby, wakeOnSound: false })).toBe(false);
        expect(shouldListen(hungUp, { ...standby, appActive: false })).toBe(false);
        expect(has(nextVoice(hungUp, { type: 'app_foreground' }, standby).effects, 'listen')).toBe(true);
        expect(has(nextVoice(hungUp, { type: 'app_background' }, standby).effects, 'stop_listening')).toBe(true);
        expect(has(nextVoice(live, { type: 'app_background' }, standby).effects, 'stop_listening')).toBe(false); // the mic is ours while live
        // Session events do not wake classic, nor standby with the setting off.
        expect(nextVoice(hungUp, { type: 'connect_requested', sessionId: S, cause: 'event', silent: true }, classic).state).toEqual(hungUp);
        expect(nextVoice(hungUp, { type: 'connect_requested', sessionId: S, cause: 'event', silent: true }, { ...standby, wakeOnEvents: false }).state).toEqual(hungUp);
    });

    it('a tap during the reconnect wait connects now and cancels the timer; an event waits for it', () => {
        const tap = nextVoice(waiting, { type: 'connect_requested', sessionId: S, cause: 'tap', silent: false }, standby);
        expect(tap.state).toMatchObject({ kind: 'connecting', attempt: 0 });
        expect(has(tap.effects, 'clear_reconnect_timer')).toBe(true);
        expect(nextVoice(waiting, { type: 'connect_requested', sessionId: S, cause: 'event', silent: true }, standby).state).toEqual(waiting);
        expect(nextVoice(waiting, { type: 'reconnect_due', gen: 3 }, standby).state).toEqual(waiting); // a stale timer
    });

    it('projections', () => {
        expect(statusOf(DISARMED)).toBe('disconnected');
        expect(statusOf(hungUp)).toBe('disconnected');
        expect(statusOf(connecting())).toBe('connecting');
        expect(statusOf(waiting)).toBe('connecting');
        expect(statusOf(live)).toBe('connected');
        expect(statusOf(error)).toBe('error');
        expect(armedSessionOf(DISARMED)).toBeNull();
        expect(armedSessionOf(live)).toBe(S);
    });
});
