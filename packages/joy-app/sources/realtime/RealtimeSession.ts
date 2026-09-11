// Voice orchestrator. Voice has two layers:
//
//   ARMED   — the user turned voice on for a session. No connection, nothing
//             billed. Session events (turn ended, approval held, question
//             asked) wake it; so does a tap.
//   LIVE    — an ElevenLabs conversation is open (billed per minute). After
//             `voiceIdleTimeoutSec` of nobody talking and nothing pending it
//             hangs up back to ARMED. The spoken transcript survives the
//             hang-up and is replayed on the next connect, so the agent keeps
//             the thread.
//
//   IDLE listening — while ARMED and in the foreground, a local sound
//             detector (soundWake.ts) reopens the conversation when it hears
//             speech-like sound, so no tap is needed.
//
//   ERROR   — a connect failed. Still ARMED, but parked: no sound listening
//             until a tap or a session event retries (#20).
//
// Ending voice from the status bar disarms: clears the transcript, no wakes.
//
// That is `voiceMode: 'standby'`. The default, 'classic', is the original
// behaviour: the tap opens one conversation and it stays LIVE until the user
// ends it — no idle hang-up, no sound or event wake, nothing sent that the
// agent must allow (see voiceRules.VoiceMode). A drop still reconnects.
//
// The states above are voiceMachine.ts's; this file feeds it events and
// performs its effects — the SDK, the sound detector, the timers, the store
// — and runs the one async thing the machine only names: the connect
// sequence (microphone, token, briefing, SDK connect), fenced by the
// generation the machine minted for it.
import type { VoiceSession } from './types';
import { Modal } from '@/modal';
import { t } from '@/text';
import { requestMicrophonePermission, showMicrophonePermissionDeniedAlert } from '@/utils/microphonePermissions';
import { storage } from '@/sync/storage';
import { buildVoiceBriefing, buildVoiceFirstMessage, buildVoiceSystemPrompt } from './voiceSystemPrompt';
import { clearVoiceTranscript, getRecentVoiceTranscript, hasVoiceTranscript, lastVoiceTurnAt } from './voiceTranscript';
import { activeVoiceAgent, mintConversationToken } from './elevenLabs';
import { flushPendingPrompts, hasPendingPrompts, voiceHooks } from './hooks/voiceHooks';
import { startSoundWake, stopSoundWake } from './soundWake';
import { isRejectedAfterConnect, type VoiceMode } from './voiceRules';
import type { VoiceSessionConfig } from './types';
import { AppState } from 'react-native';
import { DISARMED, isCurrentGen, nextVoice, type ConnectCause, type VoiceEffect, type VoiceEnv, type VoiceEvent, type VoiceState } from './voiceMachine';

let voiceSession: VoiceSession | null = null;
// The FOCUSED session — what onSessionFocus moves. The armed session is the
// machine's; the two meet in the connect sequence, which briefs the agent
// about the focused session at every boundary (#338).
let currentSessionId: string | null = null;
// The session the current (or last) connect's system prompt described.
let contextSessionId: string | null = null;
// Classic mode: the briefing the connect could not put in a prompt override,
// sent as a contextual update the moment the line is up.
let pendingBriefing: string | null = null;

let machine: VoiceState = DISARMED;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;

function env(): VoiceEnv {
    const s = storage.getState();
    const secs = s.settings.voiceIdleTimeoutSec;
    return {
        mode: voiceMode(),
        wakeOnSound: s.settings.voiceWakeOnSound,
        wakeOnEvents: s.settings.voiceWakeOnEvents,
        appActive: AppState.currentState === 'active',
        idleTimeoutMs: secs && secs > 0 ? secs * 1000 : 0,
        now: Date.now(),
    };
}

/** One step: the machine decides, this performs. Returns the new state. */
function dispatch(ev: VoiceEvent): VoiceState {
    const { state, effects } = nextVoice(machine, ev, env());
    machine = state;
    for (const e of effects) perform(e);
    return state;
}

function perform(e: VoiceEffect): void {
    switch (e.type) {
        case 'connect':
            void runConnect(e);
            return;
        case 'end_session':
            if (voiceSession) void voiceSession.endSession().catch((err) => console.error('[voice] end failed:', err));
            return;
        case 'listen':
            void startSoundWake(() => {
                const sid = currentSessionId ?? storage.getState().voiceArmedSessionId;
                if (!sid) return;
                console.log('[voice] sound wake');
                void startVoice(sid, { soundWake: true });
            });
            return;
        case 'stop_listening':
            void stopSoundWake();
            return;
        case 'arm_idle_timer':
            if (idleTimer) clearTimeout(idleTimer);
            idleTimer = setTimeout(() => {
                idleTimer = null;
                const mode = storage.getState().realtimeMode;
                dispatch({ type: 'idle_timeout', busy: mode !== 'idle' || hasPendingPrompts() });
            }, e.ms);
            return;
        case 'clear_idle_timer':
            if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
            return;
        case 'schedule_reconnect':
            if (reconnectTimer) clearTimeout(reconnectTimer);
            reconnectTimer = setTimeout(() => { reconnectTimer = null; dispatch({ type: 'reconnect_due', gen: e.gen }); }, e.delayMs);
            return;
        case 'clear_reconnect_timer':
            if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
            return;
        case 'status':
            storage.getState().setRealtimeStatus(e.status);
            return;
        case 'armed':
            storage.getState().setVoiceArmedSessionId(e.sessionId);
            return;
        case 'disconnected_hooks':
            // A reconnect briefs the agent afresh; until then nothing is deferred (#340).
            voiceHooks.onVoiceDisconnected();
            pendingBriefing = null;
            return;
        case 'disarm':
            clearVoiceTranscript();
            voiceHooks.onVoiceStopped();
            currentSessionId = null;
            contextSessionId = null;
            return;
        case 'park_refused': {
            console.warn('[voice] call refused right after connect:', e.reason ?? '(no reason reported)');
            const detail = e.reason?.trim() || t(e.overrides ? 'voice.refusedOverrides' : 'voice.refusedNoReason');
            Modal.alert(t('voice.refusedTitle'), t('voice.refusedMessage', { reason: detail }));
            return;
        }
        case 'alert_failed':
            Modal.alert(t('common.error'), t('voice.startFailed', { reason: e.reason }));
            return;
        case 'log':
            console.log(`[voice] ${e.line}`);
            return;
    }
}

export function voiceMode(): VoiceMode { return storage.getState().settings.voiceMode === 'standby' ? 'standby' : 'classic'; }
export function isVoiceConnected(): boolean { return storage.getState().realtimeStatus === 'connected'; }
export function isVoiceArmed(): boolean { return storage.getState().voiceArmedSessionId !== null; }
export function getVoiceSession(): VoiceSession | null { return voiceSession; }
export function getCurrentRealtimeSessionId(): string | null { return currentSessionId; }
export function setCurrentRealtimeSessionId(sessionId: string) { currentSessionId = sessionId; }
/** The machine's state — for tests and the status bar. */
export function voiceState(): VoiceState { return machine; }
export function getVoiceConnectedDurationSeconds(): number | undefined {
    return machine.kind === 'live' ? Math.max(0, Math.round((Date.now() - machine.connectedAt) / 1000)) : undefined;
}

export function registerVoiceSession(session: VoiceSession) {
    voiceSession = session;
}

/** Any sign of life on the line: speech either way, a tool call, a message. */
export function noteVoiceActivity(): void {
    if (!isVoiceConnected()) return;
    dispatch({ type: 'activity' });
}

type ConnectOptions = { silentWake?: boolean; soundWake?: boolean };

/** The connect sequences in flight, by generation, so startVoice can await
 *  the one its request started (and a wake can await its own). */
const inFlight = new Map<number, Promise<boolean>>();

/**
 * Arm voice for `sessionId` and open a conversation. `silentWake` is the
 * event-driven path: no greeting, the queued update is spoken instead.
 * Unattended starts (event or sound wake) fail quietly: an alert for every
 * ambient sound after a broken key was the #20 loop.
 */
export async function startVoice(sessionId: string, opts: ConnectOptions = {}): Promise<boolean> {
    if (machine.kind === 'connecting') return inFlight.get(machine.gen) ?? true;
    if (machine.kind === 'live') return true;
    if (!voiceSession) { console.warn('[voice] no SDK session registered'); return false; }
    const silent = opts.silentWake === true || opts.soundWake === true;

    const agent = activeVoiceAgent(storage.getState().settings);
    if (!agent) {
        if (!silent) Modal.alert(t('voice.noAgentTitle'), t('voice.noAgentMessage'));
        return false;
    }
    const cause: ConnectCause = opts.soundWake ? 'sound' : opts.silentWake ? 'event' : 'tap';
    const next = dispatch({ type: 'connect_requested', sessionId, cause, silent });
    if (next.kind !== 'connecting') return false;
    return inFlight.get(next.gen) ?? false;
}

/** The connect sequence for one generation. Every await re-checks that the
 *  machine is still in this attempt: a hang-up or an end retires it (#244). */
function runConnect(e: Extract<VoiceEffect, { type: 'connect' }>): Promise<boolean> {
    const p = connectSequence(e).finally(() => { inFlight.delete(e.gen); });
    inFlight.set(e.gen, p);
    return p;
}

async function connectSequence(e: Extract<VoiceEffect, { type: 'connect' }>): Promise<boolean> {
    const { gen, sessionId, silent } = e;
    const session = voiceSession;
    if (!session) { dispatch({ type: 'connect_failed', gen, reason: 'no SDK session registered' }); return false; }
    const agent = activeVoiceAgent(storage.getState().settings);
    if (!agent) { dispatch({ type: 'connect_failed', gen, reason: t('voice.noAgentMessage') }); return false; }

    const isContinuation = hasVoiceTranscript();
    currentSessionId = sessionId;
    const cancelled = () => !isCurrentGen(machine, gen);

    // Focus can move while any await below is pending (the permission prompt,
    // the token mint, the SDK connect). Each boundary re-reads it, so the
    // context the agent is briefed with and the session the SDK is told about
    // are the focused session at that moment, not the one captured when the
    // call was made (#338). currentSessionId is what onSessionFocus moves.
    const focused = () => currentSessionId ?? sessionId;
    const brief = (forSession: string) => {
        const sessionContext = voiceHooks.onVoiceStarted(forSession);
        contextSessionId = forSession;
        return sessionContext;
    };
    const classic = voiceMode() === 'classic';

    try {
        // The SDK needs the microphone to itself.
        await stopSoundWake();
        if (cancelled()) { dispatch({ type: 'connect_cancelled', gen }); return false; }

        const perm = await requestMicrophonePermission();
        if (cancelled()) { dispatch({ type: 'connect_cancelled', gen }); return false; }
        if (!perm.granted) {
            // Armed without a microphone, every session event and every
            // return to the foreground would prompt for it again (#25).
            dispatch({ type: 'connect_denied', gen });
            if (!silent) showMicrophonePermissionDeniedAlert(perm.canAskAgain);
            return false;
        }

        let sessionContext = brief(focused());

        let conversationToken: string | undefined;
        if (agent.apiKey) {
            conversationToken = await mintConversationToken(agent.agentId, agent.apiKey);
            if (cancelled()) { dispatch({ type: 'connect_cancelled', gen }); return false; }
        }
        // Focus moved while the token was minted: brief the agent about the
        // session that is on screen now, not the one the prompt was built for.
        if (focused() !== contextSessionId) sessionContext = brief(focused());
        const voiceTranscript = isContinuation ? getRecentVoiceTranscript() : null;
        // Classic sends no overrides at all — an agent that does not allow
        // one closes the call as soon as it arrives — and hands the briefing
        // over as a contextual update once connected (and as the dynamic
        // variable the original joy dashboard prompt referenced). Standby
        // needs the overrides: its silent wakes are an empty first message.
        const briefing: Partial<VoiceSessionConfig> = classic
            ? { initialContext: sessionContext }
            : {
                systemPrompt: buildVoiceSystemPrompt({ sessionContext, isContinuation, voiceTranscript }),
                firstMessage: buildVoiceFirstMessage({ isContinuation, silentWake: e.reconnect || (silent && !e.soundWake), soundWake: e.soundWake }),
            };
        pendingBriefing = classic ? buildVoiceBriefing({ sessionContext, isContinuation, voiceTranscript }) : null;
        await session.startSession({
            sessionId: contextSessionId ?? sessionId,
            ...briefing,
            ...(conversationToken ? { conversationToken } : { agentId: agent.agentId }),
        });
        if (cancelled()) {
            // The strip was closed while the SDK was connecting; a late
            // success must not leave a live microphone behind (#244).
            try { await session.endSession(); } catch (err) { console.error('[voice] late end failed:', err); }
            dispatch({ type: 'connect_cancelled', gen });
            return false;
        }
        dispatch({ type: 'connect_ok', gen });
        // Focus moved during the SDK connect. If the line is already up the
        // agent is told now; otherwise notifyVoiceConnected does it on connect.
        syncContextToFocus();
        return true;
    } catch (error) {
        if (cancelled()) { dispatch({ type: 'connect_cancelled', gen }); return false; }
        console.error('[voice] start failed:', error);
        dispatch({ type: 'connect_failed', gen, reason: error instanceof Error ? error.message : String(error) });
        return false;
    }
}

/** Focus moved while the connect was in flight: the system prompt named the
 *  old session as focused, so tell the agent about the new one (#338). Only
 *  while connected — announcing to a line that is not up yet would be lost,
 *  and the connect callback runs this again. */
function syncContextToFocus(): void {
    if (!isVoiceConnected()) return;
    const focused = currentSessionId;
    if (focused && contextSessionId && focused !== contextSessionId) {
        contextSessionId = focused;
        voiceHooks.onFocusChangedWhileConnecting(focused);
    }
}

/** While armed, hung up and in the foreground, listen locally for speech and
 *  reconnect on it. No-op when the setting is off, a connection is up or
 *  being made, or the last start failed (see voiceMachine.shouldListen). */
export function maybeListenWhileIdle(): void {
    dispatch({ type: 'tick' });
}

// Foreground/background: the mic is only ours while the app is up front.
AppState.addEventListener('change', (state) => {
    dispatch({ type: state === 'active' ? 'app_foreground' : 'app_background' });
});

/** Close the conversation but stay armed: events keep waking it. */
export async function hangUp(): Promise<void> {
    dispatch({ type: 'hang_up' });
    // Callers await the line being closed.
    if (voiceSession) { try { await voiceSession.endSession(); } catch { /* reported by the effect */ } }
}

/** Turn voice off: disconnect, disarm, forget the transcript. */
export async function endVoice(): Promise<void> {
    dispatch({ type: 'disarm' });
    if (voiceSession) { try { await voiceSession.endSession(); } catch { /* reported by the effect */ } }
    await stopSoundWake();
}

/** A session event wants the agent to speak. Connects if armed and hung up. */
export function wakeForEvent(sessionId: string): void {
    const s = storage.getState();
    if (voiceMode() === 'classic') return; // nothing to wake: classic is live or ended
    if (s.voiceArmedSessionId === null || !s.settings.voiceWakeOnEvents) return;
    if (machine.kind === 'connecting' || machine.kind === 'live' || machine.kind === 'reconnect_wait') return;
    console.log('[voice] event wake for', sessionId);
    void startVoice(currentSessionId ?? sessionId, { silentWake: true });
}

/** SDK onConnect. */
export function notifyVoiceConnected(): void {
    if (machine.kind === 'connecting') dispatch({ type: 'connect_ok', gen: machine.gen });
    // Classic: the briefing goes first, before deferred updates and prompts
    // that assume the agent already knows the sessions.
    if (pendingBriefing !== null && voiceSession) {
        try { voiceSession.sendContextualUpdate(pendingBriefing); } catch (e) { console.error('[voice] briefing failed:', e); }
    }
    pendingBriefing = null;
    // What changed in the briefed sessions while the line was coming up is
    // delivered before anything else is said about them (#340).
    voiceHooks.onVoiceConnected();
    syncContextToFocus();
    // Anything queued while the line was down is spoken now.
    setTimeout(flushPendingPrompts, 300);
}

/** Was the call that just ended refused by the agent's configuration? Read
 *  while the machine still knows when the line came up. */
function endedBeforeAWord(): boolean {
    const connectedAt = machine.kind === 'live' ? machine.connectedAt : null;
    return isRejectedAfterConnect({ connectedAt, lastTurnAt: lastVoiceTurnAt(), now: Date.now() });
}

/** SDK onDisconnect because the agent itself ended the call — its end_call
 *  tool, on the user's say-so. Standby stays armed and hung up; reconnecting
 *  would undo the hang-up the user just asked for (#343). Classic has no
 *  hung-up state to go to, so voice is over.
 *
 *  Native reports an agent that was never allowed to start the same way —
 *  the agent participant left — so a call that ends before a word is said
 *  is told apart first. */
export function notifyVoiceAgentEnded(): void {
    dispatch({ type: 'agent_ended', refused: endedBeforeAWord() });
}

/** SDK onDisconnect for a drop the user did not ask for. Reconnects with
 *  backoff while armed; gives up after MAX_RECONNECT_ATTEMPTS. `reason` is
 *  the server's close reason when the SDK passes one (web). A drop while
 *  hung up or disarmed is the one we asked for, and reconnects nothing. */
export function notifyVoiceUnexpectedDisconnect(reason?: string): void {
    dispatch({ type: 'dropped', refused: endedBeforeAWord(), reason: reason ?? null });
}
