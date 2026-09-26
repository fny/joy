// Joy owns the conversation lifecycle. The implementation supplies transcription,
// a configured conversational model, and local speech generation.
import { storage } from '@/sync/storage';
import { Modal } from '@/modal';
import { t } from '@/text';
import { showMicrophonePermissionDeniedAlert } from '@/utils/microphonePermissions';
import { LocalVoiceSession, VoicePermissionError } from './LocalVoiceSession';
import { apiEndpoint } from './conversationApi';
import { voiceHooks, flushPendingPrompts, hasPendingPrompts } from './hooks/voiceHooks';
import { buildVoiceSystemPrompt } from './voiceSystemPrompt';
import { clearVoiceTranscript, getRecentVoiceTranscript, hasVoiceTranscript } from './voiceTranscript';
import type { VoiceSession } from './types';

let voiceSession: LocalVoiceSession | null = null;
let currentSessionId: string | null = null;
let generation = 0;
let connecting: Promise<boolean> | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let foreground = true;
let foregroundEpoch = 0;
let deviceTransition: Promise<void> = Promise.resolve();
let resumeOnForeground = false;
let retiring: Promise<void> = Promise.resolve();

export function getCurrentRealtimeSessionId() { return currentSessionId; }
export function setCurrentRealtimeSessionId(id: string) { currentSessionId = id; }
export function getVoiceSession(): VoiceSession | null { return voiceSession; }
export function isVoiceConnected() { return storage.getState().realtimeStatus === 'connected'; }
export function isVoiceArmed() { return storage.getState().voiceArmedSessionId !== null; }
export function voiceMode() { return storage.getState().settings.voiceMode; }

function clearIdle() { if (idleTimer) clearTimeout(idleTimer); idleTimer = null; }
export function noteVoiceActivity() {
    clearIdle();
    const seconds = storage.getState().settings.voiceIdleTimeoutSec;
    if (voiceMode() !== 'standby' || !isVoiceConnected() || !seconds || seconds < 0) return;
    idleTimer = setTimeout(() => {
        if (storage.getState().realtimeMode === 'idle' && !hasPendingPrompts()) void hangUp();
        else noteVoiceActivity();
    }, seconds * 1000);
}

function failed(own: LocalVoiceSession, error: unknown, silent = false) {
    if (voiceSession !== own) return;
    voiceSession = null;
    generation++;
    clearIdle();
    retiring = own.endSession().catch(() => {});
    voiceHooks.onVoiceDisconnected();
    const state = storage.getState();
    state.setRealtimeMode('idle', true);
    state.setRealtimeStatus('error');
    if (!silent) Modal.alert(t('common.error'), t('voice.startFailed', { reason: error instanceof Error ? error.message : String(error) }));
}

export async function startVoice(sessionId: string, options: { silentWake?: boolean } = {}): Promise<boolean> {
    if (!foreground) return false;
    if (connecting) return connecting;
    if (voiceSession) {
        if (currentSessionId !== sessionId) voiceHooks.onSessionFocus(sessionId);
        if (isVoiceConnected()) return true;
        const own = voiceSession;
        try {
            const epoch = foregroundEpoch;
            await deviceTransition;
            if (voiceSession !== own || !foreground || foregroundEpoch !== epoch) return false;
            deviceTransition = own.resume();
            await deviceTransition;
            if (voiceSession !== own || !foreground || foregroundEpoch !== epoch) return false;
            own.sendContextualUpdate(voiceHooks.onVoiceStarted(currentSessionId ?? sessionId));
            storage.getState().setRealtimeStatus('connected');
            storage.getState().setRealtimeMode('idle', true);
            voiceHooks.onVoiceConnected();
            flushPendingPrompts();
            noteVoiceActivity();
            return true;
        } catch (error) { failed(own, error); return false; }
    }
    const settings = storage.getState().settings;
    try {
        if (!settings.voiceApiModel.trim() || !settings.voiceSttModel.trim()) throw new Error('Choose a conversation model and transcription model in Settings → Voice.');
        apiEndpoint(settings.voiceApiBaseUrl, settings.voiceApiStyle === 'openai' ? 'chat/completions' : 'messages');
        apiEndpoint(settings.voiceSttBaseUrl, 'audio/transcriptions');
    } catch (error) {
        Modal.alert(t('common.error'), error instanceof Error ? error.message : String(error));
        return false;
    }
    const gen = ++generation;
    const continuation = hasVoiceTranscript();
    currentSessionId = sessionId;
    const state = storage.getState();
    state.setVoiceArmedSessionId(sessionId);
    state.setRealtimeStatus('connecting');
    const context = voiceHooks.onVoiceStarted(sessionId);
    let own: LocalVoiceSession;
    try { own = new LocalVoiceSession({ apiStyle: settings.voiceApiStyle, baseUrl: settings.voiceApiBaseUrl, model: settings.voiceApiModel, apiKey: settings.voiceApiKey },
        { baseUrl: settings.voiceSttBaseUrl, model: settings.voiceSttModel, apiKey: settings.voiceSttApiKey }, settings.pocketTtsVoice, {
            mode: mode => {
                if (voiceSession !== own) return;
                storage.getState().setRealtimeMode(mode, true);
                noteVoiceActivity();
            },
            idle: () => { if (voiceSession === own && isVoiceConnected()) flushPendingPrompts(); },
            wake: () => {
                if (voiceSession !== own || !foreground) return;
                own.sendContextualUpdate(voiceHooks.onVoiceStarted(currentSessionId ?? sessionId));
                storage.getState().setRealtimeStatus('connected');
                voiceHooks.onVoiceConnected();
                noteVoiceActivity();
            },
            ended: () => { if (voiceSession === own) void endVoice(); },
            failed: error => failed(own, error),
        }, retiring);
    } catch (error) {
        voiceHooks.onVoiceDisconnected();
        state.setRealtimeStatus('error');
        if (!options.silentWake) Modal.alert(t('common.error'), t('voice.startFailed', { reason: error instanceof Error ? error.message : String(error) }));
        return false;
    }
    voiceSession = own;
    // Unlock audio in the tap; the implementation awaits retirement before mic acquisition.
    const start = own.startSession({ sessionId, systemPrompt: buildVoiceSystemPrompt({ sessionContext: context, isContinuation: continuation, voiceTranscript: getRecentVoiceTranscript() }) });
    const task = (async () => {
        try {
            await start;
            if (generation !== gen || voiceSession !== own || !foreground) return false;
            state.setRealtimeStatus('connected');
            voiceHooks.onVoiceConnected();
            if (currentSessionId !== sessionId && currentSessionId) voiceHooks.onFocusChangedWhileConnecting(currentSessionId);
            if (!options.silentWake && !continuation) own.greet('Hi, Joy here.');
            else state.setRealtimeMode('idle', true);
            flushPendingPrompts();
            noteVoiceActivity();
            return true;
        } catch (error) {
            if (voiceSession !== own) return false;
            if (error instanceof VoicePermissionError) {
                await endVoice();
                if (!options.silentWake) showMicrophonePermissionDeniedAlert(error.canAskAgain);
            } else failed(own, error, options.silentWake);
            return false;
        }
    })();
    connecting = task;
    try { return await task; }
    finally { if (connecting === task) connecting = null; }
}

/** Pause speech while preserving context and, when configured, listening. */
export async function hangUp(): Promise<void> {
    clearIdle();
    const own = voiceSession;
    if (!own || !isVoiceConnected()) return;
    const state = storage.getState();
    state.setRealtimeStatus('disconnected');
    state.setRealtimeMode('idle', true);
    voiceHooks.onVoiceDisconnected();
    try { deviceTransition = own.pause(foreground && state.settings.voiceWakeOnSound); await deviceTransition; }
    catch (error) { failed(own, error); }
}

export async function endVoice(): Promise<void> {
    generation++;
    connecting = null;
    clearIdle();
    const own = voiceSession;
    voiceSession = null;
    currentSessionId = null;
    resumeOnForeground = false;
    clearVoiceTranscript();
    voiceHooks.onVoiceStopped();
    const state = storage.getState();
    state.clearRealtimeModeDebounce();
    state.setRealtimeMode('idle', true);
    state.setRealtimeStatus('disconnected');
    state.setVoiceArmedSessionId(null);
    if (own) retiring = own.endSession().catch(() => {});
    await retiring;
}

export function wakeForEvent(sessionId: string) {
    if (!foreground || !isVoiceArmed() || !storage.getState().settings.voiceWakeOnEvents || connecting || isVoiceConnected()) return;
    void startVoice(currentSessionId ?? sessionId, { silentWake: true });
}

export async function setVoiceForeground(active: boolean) {
    const epoch = ++foregroundEpoch;
    foreground = active;
    if (!active) {
        resumeOnForeground = isVoiceConnected() || !!connecting || resumeOnForeground;
        const own = voiceSession;
        clearIdle();
        storage.getState().setRealtimeStatus('disconnected');
        storage.getState().setRealtimeMode('idle', true);
        voiceHooks.onVoiceDisconnected();
        if (connecting) {
            generation++;
            connecting = null;
            voiceSession = null;
            if (own) retiring = own.endSession().catch(() => {});
            deviceTransition = retiring;
        } else if (own) {
            deviceTransition = own.pause(false).catch(error => failed(own, error));
        }
        await deviceTransition;
    } else {
        await deviceTransition;
        if (foregroundEpoch !== epoch || !foreground || !isVoiceArmed()) return;
        const id = currentSessionId ?? storage.getState().voiceArmedSessionId!;
        if (resumeOnForeground) { resumeOnForeground = false; await startVoice(id, { silentWake: true }); }
        else if (voiceSession && storage.getState().settings.voiceWakeOnSound) {
            const own = voiceSession;
            try {
                await own.resume();
                if (foregroundEpoch === epoch && voiceSession === own) await own.pause(true);
            } catch (error) { failed(own, error); }
        }
    }
}
