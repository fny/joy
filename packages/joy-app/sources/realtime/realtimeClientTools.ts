import { z } from 'zod';
import { sync } from '@/sync/sync';
import { sessionAllow, sessionDeny } from '@/sync/ops';
import { storage } from '@/sync/storage';
import { noteVoiceActivity } from './RealtimeSession';

/** Actions exposed to Joy's voice conversation, executed through normal session operations. */
export const realtimeClientTools = {
    /** Send text into a coding session, exactly as if typed in the composer. */
    sendMessageToSession: async (parameters: unknown) => {
        const parsed = z.object({
            sessionId: z.string().min(1),
            message: z.string().min(1),
        }).safeParse(parameters);
        if (!parsed.success) return 'error (invalid parameters)';
        const { sessionId, message } = parsed.data;
        if (!storage.getState().sessions[sessionId]) return 'error (unknown session)';
        noteVoiceActivity();
        try {
            const result = await sync.sendMessage(sessionId, message, { source: 'voice' });
            if (!result.ok) return `error (${result.reason})`;
        } catch (e) {
            console.error('[voice] sendMessageToSession failed:', e);
            return 'error (send failed)';
        }
        return "sent [DO NOT say anything else, simply say 'sent']";
    },

    /** Answer a held tool-call approval. */
    processPermissionRequest: async (parameters: unknown) => {
        const parsed = z.object({
            requestId: z.string().min(1),
            decision: z.enum(['allow', 'deny']),
        }).safeParse(parameters);
        if (!parsed.success) return 'error (invalid parameters)';
        const { requestId, decision } = parsed.data;
        noteVoiceActivity();

        // Find the session holding this request: a tool-call message with a
        // pending permission of that id.
        const state = storage.getState();
        let sessionId: string | null = null;
        outer: for (const [sid, sm] of Object.entries(state.sessionMessages)) {
            for (const m of Object.values(sm.messagesMap)) {
                if (m.kind === 'tool-call' && m.tool.permission?.id === requestId && m.tool.permission.status === 'pending') { sessionId = sid; break outer; }
            }
        }
        if (!sessionId) return 'error (permission request not found)';
        try {
            if (decision === 'allow') await sessionAllow(sessionId, requestId);
            else await sessionDeny(sessionId, requestId);
            return "done [DO NOT say anything else, simply say 'done']";
        } catch (e) {
            console.error('[voice] processPermissionRequest failed:', e);
            return `error (failed to ${decision})`;
        }
    },
};


export const voiceToolDefinitions = [
    { name: 'sendMessageToSession', description: 'Send the user’s explicitly requested instruction or selected answer to a coding session.', parameters: {
        type: 'object', properties: { sessionId: { type: 'string' }, message: { type: 'string' } }, required: ['sessionId', 'message'], additionalProperties: false,
    } },
    { name: 'processPermissionRequest', description: 'Allow or deny a currently pending request on the user’s instruction.', parameters: {
        type: 'object', properties: { requestId: { type: 'string' }, decision: { type: 'string', enum: ['allow', 'deny'] } }, required: ['requestId', 'decision'], additionalProperties: false,
    } },
    { name: 'skip_turn', description: 'Stay silent when the user is not addressing Joy.', parameters: { type: 'object', properties: {}, additionalProperties: false } },
    { name: 'end_call', description: 'End voice when the user asks to stop talking.', parameters: { type: 'object', properties: {}, additionalProperties: false } },
];
