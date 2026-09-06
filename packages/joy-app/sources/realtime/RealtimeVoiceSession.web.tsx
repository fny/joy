import React, { useEffect, useRef } from 'react';
import { useConversation } from '@elevenlabs/react';
import { registerVoiceSession, notifyVoiceConnected, notifyVoiceUnexpectedDisconnect, notifyVoiceAgentEnded, noteVoiceActivity } from './RealtimeSession';
import { recordVoiceMessage } from './voiceTranscript';
import { storage } from '@/sync/storage';
import { realtimeClientTools } from './realtimeClientTools';
import { classifyDisconnect } from './voiceRules';
import type { VoiceSession, VoiceSessionConfig } from './types';

let conversationInstance: ReturnType<typeof useConversation> | null = null;

const VAD_THRESHOLD = 0.5;
const VAD_SILENCE_MS = 300;
let vadSilenceTimer: ReturnType<typeof setTimeout> | null = null;
let agentIsSpeaking = false;
let sessionWasLive = false;

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
        try {
            storage.getState().setRealtimeStatus('connecting');
            // No getUserMedia probe here: startVoice already awaited
            // requestMicrophonePermission (which stops its probe tracks), and
            // an unstopped probe kept the tab's "microphone in use" indicator
            // lit after every hang-up, one more track per reconnect (#101).
            if (!config.conversationToken && !config.agentId) throw new Error('no agent');
            const sessionConfig: any = {
                dynamicVariables: { sessionId: config.sessionId },
                overrides: {
                    agent: {
                        ...(config.systemPrompt ? { prompt: { prompt: config.systemPrompt } } : {}),
                        ...(config.firstMessage !== undefined ? { firstMessage: config.firstMessage } : {}),
                    },
                },
                // A minted token is a WebRTC credential; the bare agent id
                // goes over the default websocket transport.
                ...(config.conversationToken
                    ? { conversationToken: config.conversationToken, connectionType: 'webrtc' }
                    : { agentId: config.agentId, connectionType: 'websocket' }),
            };
            const conversationId = await conversationInstance.startSession(sessionConfig);
            return conversationId ?? conversationInstance.getId?.() ?? null;
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
        conversationInstance?.sendUserMessage(message);
    }

    sendContextualUpdate(update: string): void {
        conversationInstance?.sendContextualUpdate(update);
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
            notifyVoiceConnected();
        },
        onDisconnect: (details) => {
            resetSpeechState();
            storage.getState().setRealtimeStatus('disconnected');
            storage.getState().setRealtimeMode('idle', true);
            storage.getState().clearRealtimeModeDebounce();
            const wasLive = sessionWasLive;
            sessionWasLive = false;
            if (!wasLive) return;
            storage.getState().incrementVoiceSessionGeneration();
            // The end_call tool ends the session with reason 'agent' and an
            // 'end_call' CloseEvent; a WebRTC room drop also says 'agent' but
            // with a plain 'close' event and must keep reconnecting (#343).
            if (classifyDisconnect(details) === 'agent-ended') notifyVoiceAgentEnded();
            else notifyVoiceUnexpectedDisconnect();
        },
        onMessage: (data) => {
            recordVoiceMessage(data);
            noteVoiceActivity();
        },
        onError: (message, context) => {
            // Message-level: a client tool we do not define, a server
            // error_event. The socket is still open; the client reports a
            // terminal failure through onDisconnect with reason 'error'.
            // Marking the call disconnected here froze context delivery and
            // the idle hang-up on a live call (#342).
            console.warn('[voice] SDK error:', message, context);
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

    // Unmount only: speech state must not leak into the next generation (#344).
    useEffect(() => () => { resetSpeechState(); }, []);

    return null;
};
