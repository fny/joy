import { getCurrentRealtimeSessionId, getVoiceSession, isVoiceConnected, setCurrentRealtimeSessionId, wakeForEvent } from '../RealtimeSession';
import {
    formatNewMessages,
    formatPermissionRequest,
    formatQuestion,
    formatReadyEvent,
    formatSessionFocus,
    formatSessionFull,
    parseJoyOptions,
    cleanAgentText,
} from './contextFormatters';
import { storage } from '@/sync/storage';
import type { Message } from '@/sync/typesMessage';
import type { Session } from '@/sync/storageTypes';
import { VOICE_CONFIG } from '../voiceConfig';
import { PendingPromptQueue, shouldQueuePrompt } from '../pendingPrompts';

/**
 * Feeds the voice agent from app state. Two channels:
 * - sendContext(): silent background injection, immediate, dropped when the
 *   line is down (the next connect re-injects the session anyway).
 * - sendPrompt(): makes the agent speak. Queued while anyone is talking and
 *   while the line is down; a queued prompt is what WAKES an armed voice.
 *   Retention rules live in pendingPrompts.ts.
 */

// Sessions whose full context the CURRENT connection has received.
let shownSessions = new Set<string>();
const pending = new PendingPromptQueue();
const seenRequests = new Set<string>();
const seenQuestions = new Set<string>();
let unsubscribeMode: (() => void) | null = null;
let lastRealtimeMode: string | null = null;

function log(...args: unknown[]) {
    if (VOICE_CONFIG.ENABLE_DEBUG_LOGGING) console.log('[voice]', ...args);
}

function ensureModeSubscription() {
    if (unsubscribeMode) return;
    lastRealtimeMode = storage.getState().realtimeMode;
    unsubscribeMode = storage.subscribe((state) => {
        const mode = state.realtimeMode;
        if (mode !== lastRealtimeMode) {
            lastRealtimeMode = mode;
            if (mode === 'idle') flushPendingPrompts();
        }
    });
}

/** False only when the request is known and no longer pending. A session
 *  whose messages are not loaded cannot be judged, so its prompt is kept. */
function isRequestPending(sessionId: string, requestId: string): boolean {
    const map = storage.getState().sessionMessages[sessionId]?.messagesMap;
    if (!map) return true;
    for (const m of Object.values(map)) {
        if (m.kind === 'tool-call' && m.tool.permission?.id === requestId) {
            return m.tool.permission.status === 'pending';
        }
    }
    return true;
}

/** Anything left to say? Stale or already-answered entries must not hold
 *  the line open past the idle timeout (#22, #341). */
export function hasPendingPrompts(): boolean {
    pending.prune(Date.now(), isRequestPending);
    return pending.size > 0;
}

export function flushPendingPrompts(): void {
    if (pending.size === 0) return;
    const voice = getVoiceSession();
    if (!voice || !isVoiceConnected()) return; // keep them for the next connect
    if (storage.getState().realtimeMode !== 'idle') return;
    pending.prune(Date.now(), isRequestPending);
    if (pending.size === 0) return;
    // A prompt queued while the line was down says "the previous messages
    // are its summary" about a session this connection may never have been
    // shown — only the focused session goes into the system prompt (#340).
    for (const sid of pending.sessionIds()) injectSessionContext(sid);
    const batched = pending.drain().join('\n\n');
    log('prompt (flush):', batched);
    voice.sendTextMessage(batched);
}

function sendContext(update: string | null | undefined) {
    if (!update) return;
    const voice = getVoiceSession();
    if (!voice || !isVoiceConnected()) return;
    log('context:', update);
    voice.sendContextualUpdate(update);
}

function sendPrompt(sessionId: string, update: string | null | undefined, requestId?: string) {
    if (!update) return;
    const s = storage.getState();
    if (!shouldQueuePrompt({ status: s.realtimeStatus, wakeOnEvents: s.settings.voiceWakeOnEvents })) {
        // Hung up with event wake off: nothing would drain the queue until
        // the user taps, hours later, and hears a batch of stale news (#22).
        log('prompt dropped (hung up, event wake off):', update);
        return;
    }
    pending.push({ text: update, sessionId, requestId });
    if (!isVoiceConnected()) {
        // Armed but hung up: this is the wake signal.
        wakeForEvent(sessionId);
        return;
    }
    flushPendingPrompts();
}

/** A session's full context, or null when the session is unknown. */
function sessionContextFor(sessionId: string): string | null {
    const session = storage.getState().sessions[sessionId];
    if (!session) return null;
    const messages = storage.getState().sessionMessages[sessionId]?.messages ?? [];
    return formatSessionFull(session, messages);
}

/**
 * Inject a session's context over a LIVE line, once per connection. It is
 * marked shown only when actually sent: marking it while the line was down
 * (and the update silently dropped) meant the session was never injected
 * after the reconnect either (#340).
 */
function injectSessionContext(sessionId: string): void {
    if (shownSessions.has(sessionId)) return;
    if (!getVoiceSession() || !isVoiceConnected()) return;
    const ctx = sessionContextFor(sessionId);
    if (!ctx) return;
    shownSessions.add(sessionId);
    sendContext(ctx);
}

function announceFocus(sessionId: string): void {
    if (!isVoiceConnected()) return;
    injectSessionContext(sessionId);
    sendContext(formatSessionFocus(sessionId, sessionOf(sessionId)));
}

function formatSessionDirectory(): string {
    const active = storage.getState().getActiveSessions();
    if (active.length === 0) return 'No active sessions.';
    const lines = active.map(s => {
        const title = s.metadata?.summary?.text ?? s.metadata?.path ?? 'untitled';
        return `- ${s.id}: "${title}"${s.thinking ? ' (working)' : ''}`;
    });
    return 'Active sessions:\n' + lines.join('\n');
}

function sessionOf(sessionId: string): Session | undefined {
    return storage.getState().sessions[sessionId];
}

export const voiceHooks = {
    /** The user opened / switched to a session. */
    onSessionFocus(sessionId: string) {
        if (getCurrentRealtimeSessionId() === sessionId) return;
        setCurrentRealtimeSessionId(sessionId);
        announceFocus(sessionId);
    },

    /** Focus moved while a connect was in flight: the system prompt named
     *  the old session, so the agent is told about the new one now (#338). */
    onFocusChangedWhileConnecting(sessionId: string) {
        announceFocus(sessionId);
    },

    /** A tool-call approval is being held. */
    onPermissionRequested(sessionId: string, requestId: string, toolName: string, toolArgs: unknown) {
        injectSessionContext(sessionId);
        sendPrompt(sessionId, formatPermissionRequest(sessionId, requestId, toolName, toolArgs, sessionOf(sessionId)), requestId);
    },

    /** New or changed messages landed in the store. Detects held approvals
     *  and <joy-options> questions on the way through. */
    onMessages(sessionId: string, messages: Message[]) {
        const session = sessionOf(sessionId);
        for (const m of messages) {
            if (m.kind === 'tool-call' && m.tool.permission) {
                const permission = m.tool.permission;
                if (permission.status === 'pending') {
                    if (!seenRequests.has(permission.id)) {
                        seenRequests.add(permission.id);
                        voiceHooks.onPermissionRequested(sessionId, permission.id, m.tool.name, m.tool.input);
                    }
                } else {
                    // Answered in the app before voice got to it: do not ask
                    // the user about an already-completed operation (#341).
                    pending.removeRequest(permission.id);
                }
            }
            if (m.kind === 'agent-text' && !m.isThinking && !seenQuestions.has(m.id)) {
                const options = parseJoyOptions(m.text);
                if (options) {
                    seenQuestions.add(m.id);
                    const question = cleanAgentText(m.text.replace(/<joy-options>[\s\S]*?<\/joy-options>/, ''));
                    injectSessionContext(sessionId);
                    sendPrompt(sessionId, formatQuestion(sessionId, question, options, session));
                }
            }
        }
        if (!isVoiceConnected()) return;
        injectSessionContext(sessionId);
        sendContext(formatNewMessages(sessionId, messages, session));
    },

    /** The session's turn ended (thinking → idle). */
    onReady(sessionId: string) {
        injectSessionContext(sessionId);
        sendPrompt(sessionId, formatReadyEvent(sessionId, sessionOf(sessionId)));
    },

    /** Builds the prompt context for a (re)connect. */
    onVoiceStarted(sessionId: string): string {
        log('voice started for', sessionId);
        shownSessions.clear();
        ensureModeSubscription();
        let prompt = formatSessionDirectory() + '\n\n';
        const ctx = sessionContextFor(sessionId);
        if (ctx) {
            shownSessions.add(sessionId);
            prompt += 'FOCUSED SESSION:\n\n' + ctx;
        }
        return prompt;
    },

    /** Voice fully ended (disarmed). Hang-ups keep the queue. */
    onVoiceStopped() {
        log('voice stopped');
        shownSessions.clear();
        pending.clear();
        seenRequests.clear();
        seenQuestions.clear();
    },
};
