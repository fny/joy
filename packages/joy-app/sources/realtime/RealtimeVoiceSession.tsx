import React, { useEffect, useRef } from 'react';
import { useConversation } from '@elevenlabs/react-native';
import { registerVoiceSession, notifyVoiceConnected, notifyVoiceUnexpectedDisconnect, notifyVoiceAgentEnded, noteVoiceActivity } from './RealtimeSession';
import { recordVoiceMessage } from './voiceTranscript';
import { storage } from '@/sync/storage';
import { realtimeClientTools } from './realtimeClientTools';
import { ConnectAttempt } from './connectAttempt';
import { classifyDisconnect } from './voiceRules';
import type { VoiceSession, VoiceSessionConfig } from './types';

// Static reference to the conversation hook instance
let conversationInstance: ReturnType<typeof useConversation> | null = null;

// VAD state for user speech detection
const VAD_THRESHOLD = 0.5;
const VAD_SILENCE_MS = 300;
let vadSilenceTimer: ReturnType<typeof setTimeout> | null = null;
let agentIsSpeaking = false;
// Tracks whether this session ever connected — read in onDisconnect instead of
// the store status, which other callbacks may have moved already.
let sessionWasLive = false;

// The connect in flight, if any. The native SDK's startSession resolves once
// it has a token and has asked LiveKit to connect — before the room is up —
// so the attempt stays pending here until onConnect or a terminal signal
// (#339). See connectAttempt.ts.
let pendingAttempt: ConnectAttempt | null = null;
const CONNECT_TIMEOUT_MS = 20_000;

/** Speech state is per conversation: a call that ended while the agent was
 *  talking must not leave the next one believing it still is, or every VAD
 *  score is ignored and the idle hang-up can fire mid-sentence (#344). */
function resetSpeechState(): void {
    agentIsSpeaking = false;
    if (vadSilenceTimer) { clearTimeout(vadSilenceTimer); vadSilenceTimer = null; }
}

class RealtimeVoiceSessionImpl implements VoiceSession {
    async startSession(config: VoiceSessionConfig): Promise<string | null> {
        if (!conversationInstance) throw new Error('voice SDK not mounted');
        pendingAttempt?.cancel();
        const attempt = new ConnectAttempt(CONNECT_TIMEOUT_MS);
        pendingAttempt = attempt;
        try {
            storage.getState().setRealtimeStatus('connecting');
            if (!config.conversationToken && !config.agentId) throw new Error('no agent');
            const sessionConfig: any = {
                ...(config.conversationToken
                    ? { conversationToken: config.conversationToken }
                    : { agentId: config.agentId }),
                dynamicVariables: { sessionId: config.sessionId },
                overrides: {
                    agent: {
                        ...(config.systemPrompt ? { prompt: { prompt: config.systemPrompt } } : {}),
                        ...(config.firstMessage !== undefined ? { firstMessage: config.firstMessage } : {}),
                    },
                },
            };
            await conversationInstance.startSession(sessionConfig);
            // Settles on onConnect, a pre-connect onError/onDisconnect, an
            // endSession while pending (#244) or the timeout.
            await attempt.promise;
            return conversationInstance?.getId?.() ?? null;
        } catch (error) {
            // Terminal for this attempt: leave nothing half-connected. The
            // LiveKit Room is single-use, so the provider is re-keyed for the
            // next attempt like after any disconnect.
            const wasCancelled = attempt.outcome === 'cancelled';
            attempt.cancel(); // no-op once settled; stops the timer if the SDK threw before the gate
            try { await conversationInstance?.endSession(); } catch { /* never opened */ }
            storage.getState().incrementVoiceSessionGeneration();
            storage.getState().setRealtimeStatus(wasCancelled ? 'disconnected' : 'error');
            throw error;
        } finally {
            if (pendingAttempt === attempt) pendingAttempt = null;
        }
    }

    async endSession(): Promise<void> {
        // Ending while the connect is still pending abandons the attempt (#244).
        pendingAttempt?.cancel();
        if (!conversationInstance) { storage.getState().setRealtimeStatus('disconnected'); return; }
        try { await conversationInstance.endSession(); } catch (error) { console.error('[voice] end failed:', error); }
        finally { storage.getState().setRealtimeStatus('disconnected'); }
    }

    sendTextMessage(message: string): void {
        try { conversationInstance?.sendUserMessage(message); } catch (error) { console.error('[voice] sendUserMessage failed:', error); }
    }

    sendContextualUpdate(update: string): void {
        try { conversationInstance?.sendContextualUpdate(update); } catch (error) { console.error('[voice] sendContextualUpdate failed:', error); }
    }
}

export const RealtimeVoiceSession: React.FC = () => {
    const conversation = useConversation({
        clientTools: realtimeClientTools,
        onConnect: () => {
            resetSpeechState();
            sessionWasLive = true;
            storage.getState().setRealtimeStatus('connected');
            storage.getState().setRealtimeMode('idle');
            pendingAttempt?.connected();
            notifyVoiceConnected();
        },
        onDisconnect: (details) => {
            resetSpeechState();
            storage.getState().setRealtimeStatus('disconnected');
            storage.getState().setRealtimeMode('idle', true);
            storage.getState().clearRealtimeModeDebounce();
            const wasLive = sessionWasLive;
            sessionWasLive = false;
            if (pendingAttempt?.pending) {
                // The room never came up: settle the attempt so its owner
                // can retry — this used to be swallowed as "not live" (#339).
                const message = details?.reason === 'error' ? details.message : 'disconnected before connect';
                pendingAttempt.fail(new Error(message));
                return;
            }
            if (!wasLive) return;
            // LiveKit's Room can't be reused after disconnect: remount the
            // provider for a clean SDK instance, then let the orchestrator
            // decide whether to reconnect.
            storage.getState().incrementVoiceSessionGeneration();
            // The SDK reports reason 'agent' only when the agent participant
            // left — its end_call tool, on the user's request (#343).
            if (classifyDisconnect(details) === 'agent-ended') notifyVoiceAgentEnded();
            else notifyVoiceUnexpectedDisconnect();
        },
        onMessage: (data) => {
            recordVoiceMessage(data);
            noteVoiceActivity();
        },
        onError: (message, context) => {
            console.warn('[voice] SDK error:', message, context);
            if (pendingAttempt?.pending) {
                // Before onConnect a LiveKit error is the connect failing.
                pendingAttempt.fail(new Error(String(message)));
                return;
            }
            // On a live call this is a recoverable operation error — a failed
            // data-channel publish, a client tool the agent named that we do
            // not define — and the room stays open. Marking the call
            // disconnected here froze context delivery and the idle hang-up
            // while the microphone stayed live (#342). A real drop arrives
            // through onDisconnect.
        },
        onModeChange: (data) => {
            const mode = data.mode as string;
            agentIsSpeaking = mode === 'speaking';
            if (agentIsSpeaking) {
                storage.getState().setRealtimeMode('agent-speaking');
                noteVoiceActivity();
            } else {
                storage.getState().setRealtimeMode('idle');
            }
        },
        onVadScore: (data) => {
            const { vadScore } = data;
            if (agentIsSpeaking) return;
            if (vadScore > VAD_THRESHOLD) {
                if (vadSilenceTimer) { clearTimeout(vadSilenceTimer); vadSilenceTimer = null; }
                storage.getState().setRealtimeMode('user-speaking', true);
                noteVoiceActivity();
            } else if (!vadSilenceTimer) {
                vadSilenceTimer = setTimeout(() => {
                    vadSilenceTimer = null;
                    if (!agentIsSpeaking) storage.getState().setRealtimeMode('idle');
                }, VAD_SILENCE_MS);
            }
        },
    });

    const hasRegistered = useRef(false);
    useEffect(() => {
        conversationInstance = conversation;
        if (!hasRegistered.current) {
            registerVoiceSession(new RealtimeVoiceSessionImpl());
            hasRegistered.current = true;
        }
        return () => { conversationInstance = null; };
    }, [conversation]);

    // Unmount only (the effect above re-runs whenever the hook returns a new
    // object): a remount mid-connect orphans the attempt, and speech state
    // must not leak into the next generation's conversation (#344).
    useEffect(() => () => {
        pendingAttempt?.cancel();
        resetSpeechState();
    }, []);

    return null;
};
