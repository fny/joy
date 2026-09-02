import React, { useEffect, useRef } from 'react';
import { useConversation } from '@elevenlabs/react-native';
import { registerVoiceSession, notifyVoiceConnected, notifyVoiceUnexpectedDisconnect, noteVoiceActivity } from './RealtimeSession';
import { recordVoiceMessage } from './voiceTranscript';
import { storage } from '@/sync/storage';
import { realtimeClientTools } from './realtimeClientTools';
import type { VoiceSession, VoiceSessionConfig } from './types';

// Static reference to the conversation hook instance
let conversationInstance: ReturnType<typeof useConversation> | null = null;

// VAD state for user speech detection
const VAD_THRESHOLD = 0.5;
const VAD_SILENCE_MS = 300;
let vadSilenceTimer: ReturnType<typeof setTimeout> | null = null;
let agentIsSpeaking = false;
// Tracks whether this session ever connected — read in onDisconnect instead of
// the store status, because onError flips the status to 'disconnected' first.
let sessionWasLive = false;

class RealtimeVoiceSessionImpl implements VoiceSession {
    async startSession(config: VoiceSessionConfig): Promise<string | null> {
        if (!conversationInstance) throw new Error('voice SDK not mounted');
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
            return conversationInstance.getId?.() ?? null;
        } catch (error) {
            storage.getState().setRealtimeStatus('error');
            throw error;
        }
    }

    async endSession(): Promise<void> {
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
            sessionWasLive = true;
            storage.getState().setRealtimeStatus('connected');
            storage.getState().setRealtimeMode('idle');
            notifyVoiceConnected();
        },
        onDisconnect: () => {
            storage.getState().setRealtimeStatus('disconnected');
            storage.getState().setRealtimeMode('idle', true);
            storage.getState().clearRealtimeModeDebounce();
            const wasLive = sessionWasLive;
            sessionWasLive = false;
            if (wasLive) {
                // LiveKit's Room can't be reused after disconnect: remount the
                // provider for a clean SDK instance, then let the orchestrator
                // decide whether to reconnect.
                storage.getState().incrementVoiceSessionGeneration();
                notifyVoiceUnexpectedDisconnect();
            }
        },
        onMessage: (data) => {
            recordVoiceMessage(data);
            noteVoiceActivity();
        },
        onError: (error) => {
            console.warn('[voice] SDK error:', error);
            storage.getState().setRealtimeStatus('disconnected');
            storage.getState().setRealtimeMode('idle', true);
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

    return null;
};
