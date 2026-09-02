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

/**
 * Feeds the voice agent from app state. Two channels:
 * - sendContext(): silent background injection, immediate, dropped when the
 *   line is down (the next connect re-injects the session anyway).
 * - sendPrompt(): makes the agent speak. Queued while anyone is talking and
 *   while the line is down; a queued prompt is what WAKES an armed voice.
 */

let shownSessions = new Set<string>();
let pendingPrompts: string[] = [];
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

export function hasPendingPrompts(): boolean {
    return pendingPrompts.length > 0;
}

export function flushPendingPrompts(): void {
    if (pendingPrompts.length === 0) return;
    const voice = getVoiceSession();
    if (!voice || !isVoiceConnected()) return; // keep them for the next connect
    if (storage.getState().realtimeMode !== 'idle') return;
    const batched = pendingPrompts.join('\n\n');
    pendingPrompts = [];
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

function sendPrompt(sessionId: string, update: string | null | undefined) {
    if (!update) return;
    pendingPrompts.push(update);
    if (!isVoiceConnected()) {
        // Armed but hung up: this is the wake signal.
        wakeForEvent(sessionId);
        return;
    }
    flushPendingPrompts();
}

function injectSessionContext(sessionId: string): string | null {
    if (shownSessions.has(sessionId)) return null;
    shownSessions.add(sessionId);
    const session = storage.getState().sessions[sessionId];
    if (!session) return null;
    const messages = storage.getState().sessionMessages[sessionId]?.messages ?? [];
    return formatSessionFull(session, messages);
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
        if (!isVoiceConnected()) return;
        const ctx = injectSessionContext(sessionId);
        if (ctx) sendContext(ctx);
        sendContext(formatSessionFocus(sessionId, sessionOf(sessionId)));
    },

    /** A tool-call approval is being held. */
    onPermissionRequested(sessionId: string, requestId: string, toolName: string, toolArgs: unknown) {
        const ctx = injectSessionContext(sessionId);
        if (ctx) sendContext(ctx);
        sendPrompt(sessionId, formatPermissionRequest(sessionId, requestId, toolName, toolArgs, sessionOf(sessionId)));
    },

    /** New or changed messages landed in the store. Detects held approvals
     *  and <joy-options> questions on the way through. */
    onMessages(sessionId: string, messages: Message[]) {
        const session = sessionOf(sessionId);
        for (const m of messages) {
            if (m.kind === 'tool-call' && m.tool.permission?.status === 'pending' && !seenRequests.has(m.tool.permission.id)) {
                seenRequests.add(m.tool.permission.id);
                this.onPermissionRequested(sessionId, m.tool.permission.id, m.tool.name, m.tool.input);
            }
            if (m.kind === 'agent-text' && !m.isThinking && !seenQuestions.has(m.id)) {
                const options = parseJoyOptions(m.text);
                if (options) {
                    seenQuestions.add(m.id);
                    const question = cleanAgentText(m.text.replace(/<joy-options>[\s\S]*?<\/joy-options>/, ''));
                    const ctx = injectSessionContext(sessionId);
                    if (ctx) sendContext(ctx);
                    sendPrompt(sessionId, formatQuestion(sessionId, question, options, session));
                }
            }
        }
        if (!isVoiceConnected()) return;
        const ctx = injectSessionContext(sessionId);
        if (ctx) sendContext(ctx);
        sendContext(formatNewMessages(sessionId, messages, session));
    },

    /** The session's turn ended (thinking → idle). */
    onReady(sessionId: string) {
        const ctx = injectSessionContext(sessionId);
        if (ctx) sendContext(ctx);
        sendPrompt(sessionId, formatReadyEvent(sessionId, sessionOf(sessionId)));
    },

    /** Builds the prompt context for a (re)connect. */
    onVoiceStarted(sessionId: string): string {
        log('voice started for', sessionId);
        shownSessions.clear();
        ensureModeSubscription();
        let prompt = formatSessionDirectory() + '\n\n';
        const ctx = injectSessionContext(sessionId);
        if (ctx) prompt += 'FOCUSED SESSION:\n\n' + ctx;
        return prompt;
    },

    /** Voice fully ended (disarmed). Hang-ups keep the queue. */
    onVoiceStopped() {
        log('voice stopped');
        shownSessions.clear();
        pendingPrompts = [];
        seenRequests.clear();
        seenQuestions.clear();
    },
};

const seenRequests = new Set<string>();
const seenQuestions = new Set<string>();
