import React, { useEffect, useRef } from 'react';
import { useConversation } from '@elevenlabs/react-native';
import type { Conversation } from '@elevenlabs/react-native';
import { registerVoiceSession, notifyVoiceConnected, notifyVoiceUnexpectedDisconnect, notifyVoiceAgentEnded, noteVoiceActivity } from './RealtimeSession';
import { recordVoiceMessage } from './voiceTranscript';
import { storage } from '@/sync/storage';
import { realtimeClientTools } from './realtimeClientTools';
import { CallController, raceStart, type SdkId } from './callController';
import { classifyDisconnect } from './voiceRules';
import type { VoiceSession, VoiceSessionConfig } from './types';

// Every mount of the component is one SDK instance (one useConversation, one
// LiveKit Room — single-use, so the provider is re-keyed after each call).
// The instances alive right now, by id; `current` is the newest mount, the
// one a fresh attempt starts on.
let nextSdkId: SdkId = 1;
const instances = new Map<SdkId, Conversation>();
let current: { id: SdkId; sdk: Conversation } | null = null;

// Who owns the pending attempt and the live call; every SDK callback is
// judged against it (#244, #339). Pure, see callController.ts.
const controller = new CallController();
const CONNECT_TIMEOUT_MS = 20_000;

// VAD state for user speech detection
const VAD_THRESHOLD = 0.5;
const VAD_SILENCE_MS = 300;
let vadSilenceTimer: ReturnType<typeof setTimeout> | null = null;
let agentIsSpeaking = false;

/** Speech state is per conversation: a call that ended while the agent was
 *  talking must not leave the next one believing it still is, or every VAD
 *  score is ignored and the idle hang-up can fire mid-sentence (#344). */
function resetSpeechState(): void {
    agentIsSpeaking = false;
    if (vadSilenceTimer) { clearTimeout(vadSilenceTimer); vadSilenceTimer = null; }
}

/** Close one instance; tolerant of "never opened" and "already closed". */
async function closeQuietly(sdk: Conversation | undefined): Promise<void> {
    if (!sdk) return;
    try { await sdk.endSession(); } catch { /* never opened, or already closed */ }
}

/** The instance a send should go to: the live call's, else the newest. */
function liveSdk(): Conversation | null {
    const live = controller.live;
    return (live !== null ? instances.get(live) : undefined) ?? current?.sdk ?? null;
}

class RealtimeVoiceSessionImpl implements VoiceSession {
    async startSession(config: VoiceSessionConfig): Promise<string | null> {
        const owner = current;
        if (!owner) throw new Error('voice SDK not mounted');
        const attempt = controller.begin(owner.id, CONNECT_TIMEOUT_MS);
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
            // Both stages — the SDK call and the wait for the room — settle
            // on onConnect, a pre-connect onError/onDisconnect, an endSession
            // while pending (#244) or the deadline (#339).
            await raceStart(attempt, () => owner.sdk.startSession(sessionConfig), () => closeQuietly(owner.sdk));
            return owner.sdk.getId?.() ?? null;
        } catch (error) {
            // Terminal for this attempt: leave nothing half-connected on the
            // instance IT started on — never on the mount that may have
            // replaced it since. The Room is single-use, so the provider is
            // re-keyed for the next attempt like after any disconnect.
            const wasCancelled = attempt.outcome === 'cancelled';
            attempt.cancel(); // no-op once settled; stops the timer if we threw before the gate
            await closeQuietly(owner.sdk);
            storage.getState().incrementVoiceSessionGeneration();
            storage.getState().setRealtimeStatus(wasCancelled ? 'disconnected' : 'error');
            throw error;
        }
    }

    async endSession(): Promise<void> {
        // Ending while the connect is still pending abandons the attempt
        // (#244); the instances it and the live call ran on are closed.
        const wasLive = controller.live !== null;
        const owned = controller.end().map(id => instances.get(id));
        const targets = owned.length > 0 ? owned : [current?.sdk];
        try {
            for (const sdk of targets) await closeQuietly(sdk);
        } finally {
            // The Room a live call ran on is spent: re-key the provider (the
            // cancelled-attempt path does the same in its catch).
            if (wasLive) storage.getState().incrementVoiceSessionGeneration();
            storage.getState().setRealtimeStatus('disconnected');
        }
    }

    sendTextMessage(message: string): void {
        try { liveSdk()?.sendUserMessage(message); } catch (error) { console.error('[voice] sendUserMessage failed:', error); }
    }

    sendContextualUpdate(update: string): void {
        try { liveSdk()?.sendContextualUpdate(update); } catch (error) { console.error('[voice] sendContextualUpdate failed:', error); }
    }
}

export const RealtimeVoiceSession: React.FC = () => {
    // This mount's identity: every callback below names it, so a late
    // callback from an instance that owns nothing cannot publish state.
    const idRef = useRef<SdkId | null>(null);
    if (idRef.current === null) idRef.current = nextSdkId++;
    const id = idRef.current;
    const selfRef = useRef<Conversation | null>(null);

    const conversation = useConversation({
        clientTools: realtimeClientTools,
        onConnect: () => {
            const verdict = controller.onConnect(id);
            if (verdict === 'orphan') {
                // Nobody is waiting for this room — the attempt was cancelled
                // or timed out while the SDK was still connecting (#244).
                console.warn('[voice] closing a connect nobody owns');
                void closeQuietly(selfRef.current ?? undefined);
                return;
            }
            if (verdict === 'duplicate') return;
            resetSpeechState();
            storage.getState().setRealtimeStatus('connected');
            storage.getState().setRealtimeMode('idle');
            notifyVoiceConnected();
        },
        onDisconnect: (details) => {
            const message = details?.reason === 'error' ? details.message : 'disconnected before connect';
            const verdict = controller.onDisconnect(id, new Error(message));
            if (verdict === 'stale') return;
            resetSpeechState();
            storage.getState().setRealtimeMode('idle', true);
            storage.getState().clearRealtimeModeDebounce();
            // The room never came up: the attempt is failed and its owner's
            // catch path publishes the outcome — this used to be swallowed as
            // "not live" (#339).
            if (verdict === 'attempt-failed') return;
            storage.getState().setRealtimeStatus('disconnected');
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
            if (!controller.owns(id)) return;
            recordVoiceMessage(data);
            noteVoiceActivity();
        },
        onError: (message, context) => {
            console.warn('[voice] SDK error:', message, context);
            // Before onConnect a LiveKit error is the connect failing; on a
            // live call it is a recoverable operation error — a failed
            // data-channel publish, a client tool the agent named that we do
            // not define — and the room stays open. Marking the call
            // disconnected here froze context delivery and the idle hang-up
            // while the microphone stayed live (#342). A real drop arrives
            // through onDisconnect.
            controller.onError(id, new Error(String(message)));
        },
        onModeChange: (data) => {
            if (!controller.owns(id)) return;
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
            if (!controller.owns(id)) return;
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
    selfRef.current = conversation;

    const hasRegistered = useRef(false);
    useEffect(() => {
        instances.set(id, conversation);
        current = { id, sdk: conversation };
        if (!hasRegistered.current) {
            registerVoiceSession(new RealtimeVoiceSessionImpl());
            hasRegistered.current = true;
        }
    }, [id, conversation]);

    // Unmount only (the effect above re-runs whenever the hook returns a new
    // object). A remount mid-connect orphans THIS instance's attempt and no
    // other's, and speech state must not leak into the next generation's
    // conversation (#344).
    useEffect(() => () => {
        if (controller.release(id)) resetSpeechState();
        instances.delete(id);
        if (current?.id === id) current = null;
    }, [id]);

    return null;
};
