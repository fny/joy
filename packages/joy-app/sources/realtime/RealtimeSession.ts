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
// Ending voice from the status bar disarms: clears the transcript, no wakes.
import type { VoiceSession } from './types';
import { Modal } from '@/modal';
import { t } from '@/text';
import { requestMicrophonePermission, showMicrophonePermissionDeniedAlert } from '@/utils/microphonePermissions';
import { storage } from '@/sync/storage';
import { buildVoiceFirstMessage, buildVoiceSystemPrompt } from './voiceSystemPrompt';
import { clearVoiceTranscript, getRecentVoiceTranscript, hasVoiceTranscript } from './voiceTranscript';
import { activeVoiceAgent, mintConversationToken } from './elevenLabs';
import { flushPendingPrompts, hasPendingPrompts, voiceHooks } from './hooks/voiceHooks';
import { startSoundWake, stopSoundWake } from './soundWake';
import { AppState } from 'react-native';

let voiceSession: VoiceSession | null = null;
let currentSessionId: string | null = null;
let connectedAt: number | null = null;
let connecting = false;

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

/**
 * Arm voice for `sessionId` and open a conversation. `silentWake` is the
 * event-driven path: no greeting, the queued update is spoken instead, and
 * failures are quiet.
 */
export async function startVoice(sessionId: string, opts: ConnectOptions = {}): Promise<boolean> {
    if (connecting || isVoiceConnected()) return true;
    if (!voiceSession) { console.warn('[voice] no SDK session registered'); return false; }
    const silent = opts.silentWake === true;

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
    storage.getState().setRealtimeStatus('connecting');
    // The SDK needs the microphone to itself.
    await stopSoundWake();

    try {
        const perm = await requestMicrophonePermission();
        if (!perm.granted) {
            storage.getState().setRealtimeStatus('disconnected');
            if (!silent) showMicrophonePermissionDeniedAlert(perm.canAskAgain);
            return false;
        }

        const sessionContext = voiceHooks.onVoiceStarted(sessionId);
        const systemPrompt = buildVoiceSystemPrompt({
            sessionContext,
            isContinuation,
            voiceTranscript: isContinuation ? getRecentVoiceTranscript() : null,
        });
        const firstMessage = buildVoiceFirstMessage({ isContinuation, silentWake: silent, soundWake: opts.soundWake === true });

        let conversationToken: string | undefined;
        if (agent.apiKey) {
            conversationToken = await mintConversationToken(agent.agentId, agent.apiKey);
        }
        await voiceSession.startSession({
            sessionId,
            systemPrompt,
            firstMessage,
            ...(conversationToken ? { conversationToken } : { agentId: agent.agentId }),
        });
        return true;
    } catch (error) {
        console.error('[voice] start failed:', error);
        storage.getState().setRealtimeStatus('disconnected');
        if (!silent) {
            Modal.alert(t('common.error'), t('voice.startFailed', { reason: error instanceof Error ? error.message : String(error) }));
        }
        maybeListenWhileIdle();
        return false;
    } finally {
        connecting = false;
    }
}

/** While armed, hung up and in the foreground, listen locally for speech and
 *  reconnect on it. No-op when the setting is off or a connection is up. */
export function maybeListenWhileIdle(): void {
    const s = storage.getState();
    if (s.voiceArmedSessionId === null || !s.settings.voiceWakeOnSound) return;
    if (connecting || status() !== 'disconnected') return;
    if (AppState.currentState !== 'active') return;
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
    clearVoiceTranscript();
    voiceHooks.onVoiceStopped();
    currentSessionId = null;
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
    // Anything queued while the line was down is spoken now.
    setTimeout(flushPendingPrompts, 300);
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
        console.warn('[voice] reconnect budget exhausted — staying armed, waiting for sound, an event or a tap');
        clearReconnectTimer();
        reconnectAttempts = 0;
        maybeListenWhileIdle();
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
        startVoice(sessionId, { silentWake: true })
            .then((ok) => { if (!ok && !intentionalStop) notifyVoiceUnexpectedDisconnect(); })
            .catch(() => { if (!intentionalStop) notifyVoiceUnexpectedDisconnect(); });
    }, delay);
}
