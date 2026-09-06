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
import type { VoiceSession } from './types';
import { Modal } from '@/modal';
import { t } from '@/text';
import { requestMicrophonePermission, showMicrophonePermissionDeniedAlert } from '@/utils/microphonePermissions';
import { storage } from '@/sync/storage';
import { isLatest, nextGen, retire } from '@/utils/latest';
import { buildVoiceFirstMessage, buildVoiceSystemPrompt } from './voiceSystemPrompt';
import { clearVoiceTranscript, getRecentVoiceTranscript, hasVoiceTranscript } from './voiceTranscript';
import { activeVoiceAgent, mintConversationToken } from './elevenLabs';
import { flushPendingPrompts, hasPendingPrompts, voiceHooks } from './hooks/voiceHooks';
import { startSoundWake, stopSoundWake } from './soundWake';
import { canListenWhileIdle } from './voiceRules';
import { AppState } from 'react-native';

let voiceSession: VoiceSession | null = null;
let currentSessionId: string | null = null;
// The session the current (or last) connect's system prompt described. Focus
// can move while a connect is in flight; onConnect compares the two (#338).
let contextSessionId: string | null = null;
let connectedAt: number | null = null;
let connecting = false;

// One generation per startVoice. hangUp/endVoice retire it, and startVoice
// re-checks after every await, so closing the strip while the token or the
// SDK connect is pending really ends the attempt (#244).
const START_KEY = 'voice.start';

// ── Reconnect on unexpected drops ─────────────────────────────────────────
const MAX_RECONNECT_ATTEMPTS = 4;
let reconnectAttempts = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let intentionalStop = false;

// ── Idle hang-up ──────────────────────────────────────────────────────────
let idleTimer: ReturnType<typeof setTimeout> | null = null;

function clearReconnectTimer(): void {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
}
function clearIdleTimer(): void {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
}

function status() { return storage.getState().realtimeStatus; }
export function isVoiceConnected(): boolean { return status() === 'connected'; }
export function isVoiceArmed(): boolean { return storage.getState().voiceArmedSessionId !== null; }
export function getVoiceSession(): VoiceSession | null { return voiceSession; }
export function getCurrentRealtimeSessionId(): string | null { return currentSessionId; }
export function setCurrentRealtimeSessionId(sessionId: string) { currentSessionId = sessionId; }
export function getVoiceConnectedDurationSeconds(): number | undefined {
    return connectedAt === null ? undefined : Math.max(0, Math.round((Date.now() - connectedAt) / 1000));
}

export function registerVoiceSession(session: VoiceSession) {
    voiceSession = session;
}

/** Any sign of life on the line: speech either way, a tool call, a message. */
export function noteVoiceActivity(): void {
    if (!isVoiceConnected()) return;
    armIdleTimer();
}

function armIdleTimer(): void {
    clearIdleTimer();
    const secs = storage.getState().settings.voiceIdleTimeoutSec;
    if (!secs || secs <= 0) return;
    idleTimer = setTimeout(onIdleTimer, secs * 1000);
}

function onIdleTimer(): void {
    idleTimer = null;
    if (!isVoiceConnected()) return;
    const mode = storage.getState().realtimeMode;
    if (mode !== 'idle' || hasPendingPrompts()) { armIdleTimer(); return; }
    console.log('[voice] idle — hanging up (still armed)');
    void hangUp();
}

type ConnectOptions = { silentWake?: boolean; soundWake?: boolean };
type StartOutcome = 'connected' | 'failed' | 'denied' | 'cancelled';

/**
 * Arm voice for `sessionId` and open a conversation. `silentWake` is the
 * event-driven path: no greeting, the queued update is spoken instead.
 * Unattended starts (event or sound wake) fail quietly: an alert for every
 * ambient sound after a broken key was the #20 loop.
 */
export async function startVoice(sessionId: string, opts: ConnectOptions = {}): Promise<boolean> {
    if (connecting || isVoiceConnected()) return true;
    if (!voiceSession) { console.warn('[voice] no SDK session registered'); return false; }
    const silent = opts.silentWake === true || opts.soundWake === true;

    const agent = activeVoiceAgent(storage.getState().settings);
    if (!agent) {
        if (!silent) Modal.alert(t('voice.noAgentTitle'), t('voice.noAgentMessage'));
        return false;
    }

    const wasArmed = isVoiceArmed();
    const isContinuation = wasArmed && hasVoiceTranscript();
    storage.getState().setVoiceArmedSessionId(sessionId);
    currentSessionId = sessionId;
    intentionalStop = false;
    connecting = true;
    const attempt = nextGen(START_KEY);
    const cancelled = () => !isLatest(START_KEY, attempt);
    storage.getState().setRealtimeStatus('connecting');

    // Focus can move while any await below is pending (the permission prompt,
    // the token mint, the SDK connect). Each boundary re-reads it, so the
    // context the agent is briefed with and the session the SDK is told about
    // are the focused session at that moment, not the one captured when the
    // call was made (#338). currentSessionId is what onSessionFocus moves.
    const focused = () => currentSessionId ?? sessionId;
    const buildPrompt = (forSession: string) => {
        const sessionContext = voiceHooks.onVoiceStarted(forSession);
        contextSessionId = forSession;
        return buildVoiceSystemPrompt({
            sessionContext,
            isContinuation,
            voiceTranscript: isContinuation ? getRecentVoiceTranscript() : null,
        });
    };

    let outcome: StartOutcome = 'failed';
    try {
        // The SDK needs the microphone to itself.
        await stopSoundWake();
        if (cancelled()) { outcome = 'cancelled'; return false; }

        const perm = await requestMicrophonePermission();
        if (cancelled()) { outcome = 'cancelled'; return false; }
        if (!perm.granted) {
            outcome = 'denied';
            // Armed without a microphone, every session event and every
            // return to the foreground would prompt for it again (#25).
            disarm();
            if (!silent) showMicrophonePermissionDeniedAlert(perm.canAskAgain);
            return false;
        }

        let systemPrompt = buildPrompt(focused());
        const firstMessage = buildVoiceFirstMessage({ isContinuation, silentWake: opts.silentWake === true, soundWake: opts.soundWake === true });

        let conversationToken: string | undefined;
        if (agent.apiKey) {
            conversationToken = await mintConversationToken(agent.agentId, agent.apiKey);
            if (cancelled()) { outcome = 'cancelled'; return false; }
        }
        // Focus moved while the token was minted: brief the agent about the
        // session that is on screen now, not the one the prompt was built for.
        if (focused() !== contextSessionId) systemPrompt = buildPrompt(focused());
        await voiceSession.startSession({
            sessionId: contextSessionId ?? sessionId,
            systemPrompt,
            firstMessage,
            ...(conversationToken ? { conversationToken } : { agentId: agent.agentId }),
        });
        if (cancelled()) {
            // The strip was closed while the SDK was connecting; a late
            // success must not leave a live microphone behind (#244).
            outcome = 'cancelled';
            try { await voiceSession.endSession(); } catch (e) { console.error('[voice] late end failed:', e); }
            return false;
        }
        // Focus moved during the SDK connect. If the line is already up the
        // agent is told now; otherwise notifyVoiceConnected does it on connect.
        syncContextToFocus();
        outcome = 'connected';
        return true;
    } catch (error) {
        if (cancelled()) { outcome = 'cancelled'; return false; }
        outcome = 'failed';
        console.error('[voice] start failed:', error);
        if (!silent) {
            Modal.alert(t('common.error'), t('voice.startFailed', { reason: error instanceof Error ? error.message : String(error) }));
        }
        return false;
    } finally {
        // Cleared BEFORE any recovery decision. maybeListenWhileIdle used to
        // run inside the catch with this guard still up, so a failed
        // sound-wake connect left voice armed with no listener (#337).
        connecting = false;
        if (outcome === 'failed') {
            // Parked and visible in the strip. canListenWhileIdle does not
            // listen in 'error', so the detector cannot retry-and-fail on
            // every sound; a tap or a session event retries (#20).
            storage.getState().setRealtimeStatus('error');
        } else if (outcome === 'denied') {
            storage.getState().setRealtimeStatus('disconnected');
        } else if (outcome === 'cancelled') {
            // Whoever retired the attempt owns the status; if voice is still
            // armed (a hang-up, not an end) go back to listening.
            maybeListenWhileIdle();
        }
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

/** Forget the armed session: no wakes, no transcript, no queued prompts. */
function disarm(): void {
    storage.getState().setVoiceArmedSessionId(null);
    clearVoiceTranscript();
    voiceHooks.onVoiceStopped();
    currentSessionId = null;
    contextSessionId = null;
}

/** While armed, hung up and in the foreground, listen locally for speech and
 *  reconnect on it. No-op when the setting is off, a connection is up or
 *  being made, or the last start failed (see voiceRules.canListenWhileIdle). */
export function maybeListenWhileIdle(): void {
    const s = storage.getState();
    const ok = canListenWhileIdle({
        armed: s.voiceArmedSessionId !== null,
        wakeOnSound: s.settings.voiceWakeOnSound,
        connecting,
        status: s.realtimeStatus,
        appState: AppState.currentState,
    });
    if (!ok) return;
    void startSoundWake(() => {
        const sid = currentSessionId ?? storage.getState().voiceArmedSessionId;
        if (!sid || isVoiceConnected() || connecting) return;
        console.log('[voice] sound wake');
        void startVoice(sid, { soundWake: true });
    });
}

// Foreground/background: the mic is only ours while the app is up front.
AppState.addEventListener('change', (state) => {
    if (state === 'active') maybeListenWhileIdle();
    else if (!isVoiceConnected()) void stopSoundWake();
});

/** Close the conversation but stay armed: events keep waking it. */
export async function hangUp(): Promise<void> {
    intentionalStop = true;
    retire(START_KEY); // a connect still in flight is abandoned (#244)
    clearReconnectTimer();
    clearIdleTimer();
    reconnectAttempts = 0;
    if (voiceSession) {
        try { await voiceSession.endSession(); } catch (e) { console.error('[voice] hang up failed:', e); }
    }
    connectedAt = null;
    maybeListenWhileIdle();
}

/** Turn voice off: disconnect, disarm, forget the transcript. */
export async function endVoice(): Promise<void> {
    storage.getState().setVoiceArmedSessionId(null);
    await hangUp();
    await stopSoundWake();
    disarm();
}

/** A session event wants the agent to speak. Connects if armed and hung up. */
export function wakeForEvent(sessionId: string): void {
    const s = storage.getState();
    if (s.voiceArmedSessionId === null || !s.settings.voiceWakeOnEvents) return;
    if (connecting || isVoiceConnected() || status() === 'connecting') return;
    console.log('[voice] event wake for', sessionId);
    void startVoice(currentSessionId ?? sessionId, { silentWake: true });
}

/** SDK onConnect. */
export function notifyVoiceConnected(): void {
    reconnectAttempts = 0;
    clearReconnectTimer();
    connectedAt = Date.now();
    armIdleTimer();
    // What changed in the briefed sessions while the line was coming up is
    // delivered before anything else is said about them (#340).
    voiceHooks.onVoiceConnected();
    syncContextToFocus();
    // Anything queued while the line was down is spoken now.
    setTimeout(flushPendingPrompts, 300);
}

/** SDK onDisconnect because the agent itself ended the call — its end_call
 *  tool, on the user's say-so. Stay armed and hung up; reconnecting would
 *  undo the hang-up the user just asked for (#343). */
export function notifyVoiceAgentEnded(): void {
    clearIdleTimer();
    clearReconnectTimer();
    reconnectAttempts = 0;
    connectedAt = null;
    intentionalStop = false;
    maybeListenWhileIdle();
}

/** SDK onDisconnect for a drop the user did not ask for. Reconnects with
 *  backoff while armed; gives up after MAX_RECONNECT_ATTEMPTS. */
export function notifyVoiceUnexpectedDisconnect(): void {
    clearIdleTimer();
    connectedAt = null;
    if (intentionalStop) { intentionalStop = false; return; }
    if (!isVoiceArmed()) return;
    const sessionId = currentSessionId;
    if (!sessionId) return;
    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        console.warn('[voice] reconnect budget exhausted — staying armed; a tap or a session event retries');
        clearReconnectTimer();
        reconnectAttempts = 0;
        storage.getState().setRealtimeStatus('error');
        return;
    }
    const attempt = reconnectAttempts++;
    const delay = Math.min(800 * 2 ** attempt, 8000);
    console.log(`[voice] reconnect ${attempt + 1}/${MAX_RECONNECT_ATTEMPTS} in ${delay}ms`);
    storage.getState().setRealtimeStatus('connecting');
    clearReconnectTimer();
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (intentionalStop || !isVoiceArmed()) return;
        // Resolve the focused session when the attempt RUNS, not when the
        // drop happened: focus moved to another session during the delay
        // must not be undone by reconnecting to the captured one (#338).
        startVoice(currentSessionId ?? sessionId, { silentWake: true })
            .then((ok) => { if (!ok && !intentionalStop) notifyVoiceUnexpectedDisconnect(); })
            .catch(() => { if (!intentionalStop) notifyVoiceUnexpectedDisconnect(); });
    }, delay);
}
