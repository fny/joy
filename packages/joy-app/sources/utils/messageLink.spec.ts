import { describe, expect, it } from 'vitest';
import { createReducer, reducer } from '@/sync/reducer/reducer';
import { normalizeRawMessage, NormalizedMessage } from '@/sync/typesRaw';
import { Message, ToolCallMessage } from '@/sync/typesMessage';
import * as fixtures from '@/sync/toolModel.fixtures';
import { messageDetailPath, messageLinkId, MessageLinkStore, resolveMessageLink } from './messageLink';

function norm(raw: unknown, seq: number, id: string): NormalizedMessage {
    const normalized = normalizeRawMessage(id, null, 1000 + seq, raw as any);
    if (!normalized) throw new Error('fixture did not normalize');
    normalized.seq = seq;
    return normalized;
}

/** A Task with a nested Read, and a root Bash — the rows a tool view links to. */
function history(): NormalizedMessage[] {
    return [
        norm(fixtures.claudeAssistantToolUse('call-task', 'Task', { prompt: 'Look' }), 1, 'srv-task'),
        {
            id: 'srv-nested', localId: null, createdAt: 2000, seq: 2, role: 'agent', isSidechain: true,
            content: [{ type: 'tool-call', id: 'call-read', name: 'Read', input: { file_path: '/b' }, description: null, uuid: 'nested-uuid', parentUUID: 'call-task' }],
        },
        norm(fixtures.claudeAssistantToolUse('call-bash', 'Bash', { command: 'make' }), 3, 'srv-bash'),
    ];
}

/** Project batches into the shape the session store keeps. */
function storeFrom(batches: NormalizedMessage[][]): MessageLinkStore {
    const reducerState = createReducer('s');
    const messagesMap: Record<string, Message> = {};
    for (const batch of batches) {
        for (const message of reducer(reducerState, batch).messages) {
            messagesMap[message.id] = message;
        }
    }
    return { messagesMap, reducerState };
}

function toolByCall(store: MessageLinkStore, callId: string): ToolCallMessage {
    const found = Object.values(store.messagesMap).find((m): m is ToolCallMessage => m.kind === 'tool-call' && m.tool.model?.identity.callId === callId);
    if (!found) throw new Error(`no root row for ${callId}`);
    return found;
}

describe('message deep links carry durable identity (#165)', () => {
    it('a link generated from a root tool view resolves in a reducer recreated from history', () => {
        const live = storeFrom(history().map((m) => [m]));
        const bash = toolByCall(live, 'call-bash');
        const link = messageLinkId(bash);
        expect(link).toBe('call-bash');
        expect(messageDetailPath('s', bash)).toBe('/session/s/message/call-bash');

        // A restart: a fresh reducer over the same history (one page, newest first).
        const replayed = storeFrom([[...history()].reverse()]);
        expect(replayed.messagesMap[bash.id]).toBeUndefined(); // the old row id means nothing here
        const resolved = resolveMessageLink(replayed, link);
        expect(resolved?.kind).toBe('tool-call');
        expect(resolved?.kind === 'tool-call' && resolved.tool.model?.identity.callId).toBe('call-bash');
        expect(resolved?.kind === 'tool-call' && resolved.tool.name).toBe('Bash');
    });

    it('a link generated from a tool view nested inside a Task resolves to that nested call', () => {
        const live = storeFrom(history().map((m) => [m]));
        const task = toolByCall(live, 'call-task');
        const nested = task.children.find((c): c is ToolCallMessage => c.kind === 'tool-call')!;
        const link = messageLinkId(nested);
        expect(link).toBe('call-read');

        const replayed = storeFrom([[...history()].reverse()]);
        const resolved = resolveMessageLink(replayed, link);
        expect(resolved?.kind).toBe('tool-call');
        expect(resolved?.kind === 'tool-call' && resolved.tool.model?.identity.callId).toBe('call-read');
        expect(resolved?.kind === 'tool-call' && resolved.tool.model?.identity.parentCallId).toBe('call-task');
    });

    it('a call id resolves to the same row whether the store is live or replayed', () => {
        const live = storeFrom(history().map((m) => [m]));
        const replayed = storeFrom([[...history()].reverse()]);
        for (const callId of ['call-task', 'call-bash', 'call-read']) {
            const a = resolveMessageLink(live, callId);
            const b = resolveMessageLink(replayed, callId);
            expect(a?.kind === 'tool-call' && a.tool.name).toBe(b?.kind === 'tool-call' && b.tool.name);
            expect(a?.kind === 'tool-call' && a.tool.model?.identity.callId).toBe(callId);
        }
    });

    it('a server message id resolves to the root row it produced', () => {
        const store = storeFrom([history()]);
        const resolved = resolveMessageLink(store, 'srv-bash');
        expect(resolved?.kind === 'tool-call' && resolved.tool.model?.identity.callId).toBe('call-bash');
    });

    it('still honours this store\'s own row id, an encoded id, and reports absence as null', () => {
        const store = storeFrom([history()]);
        const bash = toolByCall(store, 'call-bash');
        expect(resolveMessageLink(store, bash.id)).toBe(bash);
        expect(resolveMessageLink(store, encodeURIComponent('call-bash'))).toBe(bash);
        expect(resolveMessageLink(store, 'never-seen')).toBeNull();
        expect(resolveMessageLink(store, '')).toBeNull();
        expect(resolveMessageLink(undefined, 'call-bash')).toBeNull();
        expect(resolveMessageLink({ messagesMap: {} }, 'call-bash')).toBeNull();
    });

    it('a text message keeps its row id as the link (no durable call identity to carry)', () => {
        const text: Message = { kind: 'agent-text', id: 'row-1', localId: null, createdAt: 1, text: 'hi' };
        expect(messageLinkId(text)).toBe('row-1');
    });
});
