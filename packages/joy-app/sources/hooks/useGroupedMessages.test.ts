import { describe, expect, it, vi } from 'vitest';
import { generateGroupSummary, groupMessagesForDisplay, groupToolCallsForDisplay, hasPendingPermission } from './useGroupedMessages';
import { Message, ToolCallMessage } from '@/sync/typesMessage';

vi.mock('@/components/tools/knownTools', () => ({
    knownTools: {},
}));

vi.mock('@/text', () => ({
    t: (key: string, params?: { count?: number }) => `${key}:${params?.count ?? ''}`,
}));

function toolMessage(id: string, createdAt: number, options: { pendingPermission?: boolean } = {}): ToolCallMessage {
    return {
        kind: 'tool-call',
        id,
        localId: null,
        createdAt,
        tool: {
            name: 'CodexBash',
            state: 'completed',
            input: { command: id },
            createdAt,
            startedAt: createdAt,
            completedAt: createdAt + 1,
            description: id,
            ...(options.pendingPermission
                ? {
                    permission: {
                        id: `permission-${id}`,
                        status: 'pending' as const,
                    },
                }
                : {}),
        },
        children: [],
    };
}

describe('useGroupedMessages', () => {
    it('stores grouped tools in chronological render order', () => {
        const messages: Message[] = [
            {
                kind: 'agent-text',
                id: 'agent-after-tools',
                localId: null,
                createdAt: 5,
                text: 'done',
            },
            toolMessage('tool-latest', 4),
            toolMessage('tool-middle', 3),
            toolMessage('tool-earliest', 2),
            {
                kind: 'user-text',
                id: 'user',
                localId: null,
                createdAt: 1,
                text: 'run tools',
            },
        ];

        const group = groupToolCallsForDisplay(messages, true).find((item) => item.type === 'tool-group');

        expect(group?.messages.map((message) => message.id)).toEqual([
            'tool-earliest',
            'tool-middle',
            'tool-latest',
        ]);
    });

    it('groups only adjacent tool calls between text messages', () => {
        const messages: Message[] = [
            {
                kind: 'agent-text',
                id: 'agent-final',
                localId: null,
                createdAt: 7,
                text: 'done',
            },
            toolMessage('tool-4', 6),
            toolMessage('tool-3', 5),
            {
                kind: 'agent-text',
                id: 'agent-middle',
                localId: null,
                createdAt: 4,
                text: 'next step',
            },
            toolMessage('tool-2', 3),
            toolMessage('tool-1', 2),
            {
                kind: 'user-text',
                id: 'user',
                localId: null,
                createdAt: 1,
                text: 'run tools',
            },
        ];

        const groups = groupToolCallsForDisplay(messages, true).filter((item) => item.type === 'tool-group');

        expect(groups).toHaveLength(2);
        expect(groups[0]?.messages.map((message) => message.id)).toEqual(['tool-3', 'tool-4']);
        expect(groups[1]?.messages.map((message) => message.id)).toEqual(['tool-1', 'tool-2']);
    });

    it('keeps the final agent message visible and collapses earlier agent work', () => {
        const messages: Message[] = [
            {
                kind: 'agent-text',
                id: 'agent-final',
                localId: null,
                createdAt: 5,
                text: 'done',
            },
            toolMessage('tool-latest', 4),
            {
                kind: 'agent-text',
                id: 'agent-progress',
                localId: null,
                createdAt: 3,
                text: 'checking',
            },
            toolMessage('tool-earliest', 2),
            {
                kind: 'user-text',
                id: 'user',
                localId: null,
                createdAt: 1,
                text: 'run tools',
            },
        ];

        const items = groupMessagesForDisplay(messages, true);

        expect(items.map((item) => item.type)).toEqual(['message', 'agent-work-group', 'message']);
        expect(items[0]).toMatchObject({ type: 'message', id: 'agent-final' });
        expect(items[1]).toMatchObject({ type: 'agent-work-group', id: 'work-tool-earliest' });
        if (items[1].type !== 'agent-work-group') {
            throw new Error('Expected an agent work group');
        }
        expect(items[1].messages.map((message) => message.id)).toEqual([
            'tool-latest',
            'agent-progress',
            'tool-earliest',
        ]);
    });

    it('keeps a could-not-decrypt placeholder as its own row instead of folding it into agent work (#128)', () => {
        const messages: Message[] = [
            { kind: 'agent-text', id: 'agent-final', localId: null, createdAt: 6, text: 'done' },
            toolMessage('tool-latest', 5),
            { kind: 'unopenable-gap', id: 'gap', seq: 3, createdAt: 0, count: 2, fromSeq: 2, toSeq: 4 },
            toolMessage('tool-earliest', 2),
            { kind: 'user-text', id: 'user', localId: null, createdAt: 1, text: 'run tools' },
        ];

        const items = groupMessagesForDisplay(messages, true);

        // The agent work around the gap still collapses; the gap stays visible.
        expect(items.map((item) => item.type)).toEqual(['message', 'message', 'agent-work-group', 'message']);
        expect(items[1]).toMatchObject({ type: 'message', id: 'gap' });
        if (items[2].type !== 'agent-work-group') {
            throw new Error('Expected an agent work group');
        }
        expect(items[2].messages.map((message) => message.id)).toEqual(['tool-latest', 'tool-earliest']);
    });

    it('does not collapse the current turn while the agent is still working', () => {
        const messages: Message[] = [
            {
                kind: 'agent-text',
                id: 'agent-streaming',
                localId: null,
                createdAt: 5,
                text: 'still working',
            },
            toolMessage('tool-latest', 4),
            {
                kind: 'agent-text',
                id: 'agent-progress',
                localId: null,
                createdAt: 3,
                text: 'checking',
            },
            toolMessage('tool-earliest', 2),
            {
                kind: 'user-text',
                id: 'user',
                localId: null,
                createdAt: 1,
                text: 'run tools',
            },
        ];

        const items = groupMessagesForDisplay(messages, true, { collapseCurrentTurn: false });

        expect(items.map((item) => item.type)).toEqual([
            'message',
            'message',
            'message',
            'message',
            'message',
        ]);
        expect(items.map((item) => item.id)).toEqual([
            'agent-streaming',
            'tool-latest',
            'agent-progress',
            'tool-earliest',
            'user',
        ]);
    });

    it('still groups adjacent current-turn tools while the agent is working', () => {
        const messages: Message[] = [
            {
                kind: 'agent-text',
                id: 'agent-streaming',
                localId: null,
                createdAt: 5,
                text: 'still working',
            },
            toolMessage('tool-latest', 4),
            toolMessage('tool-earliest', 3),
            {
                kind: 'user-text',
                id: 'user',
                localId: null,
                createdAt: 1,
                text: 'run tools',
            },
        ];

        const items = groupMessagesForDisplay(messages, true, { collapseCurrentTurn: false });

        expect(items.map((item) => item.type)).toEqual(['message', 'tool-group', 'message']);
        expect(items[1]).toMatchObject({
            type: 'tool-group',
            id: 'group-tool-earliest',
            hasPendingPermission: false,
        });
    });

    it('marks a tool group when it contains a pending permission', () => {
        const messages: Message[] = [
            toolMessage('tool-latest', 3, { pendingPermission: true }),
            toolMessage('tool-earliest', 2),
            {
                kind: 'user-text',
                id: 'user',
                localId: null,
                createdAt: 1,
                text: 'run tools',
            },
        ];

        const group = groupMessagesForDisplay(messages, true).find((item) => item.type === 'tool-group');

        expect(group).toMatchObject({
            type: 'tool-group',
            id: 'group-tool-earliest',
            hasPendingPermission: true,
        });
    });

    it('does not collapse a single standalone tool call into a tool group', () => {
        const messages: Message[] = [
            toolMessage('tool-only', 2),
            {
                kind: 'user-text',
                id: 'user',
                localId: null,
                createdAt: 1,
                text: 'run one tool',
            },
        ];

        const items = groupMessagesForDisplay(messages, true);

        expect(items.map((item) => item.type)).toEqual(['message', 'message']);
        expect(items[0]).toMatchObject({ type: 'message', id: 'tool-only' });
    });

    it('can collapse single standalone tool calls for nested work details', () => {
        const messages: Message[] = [
            toolMessage('tool-only', 2),
            {
                kind: 'user-text',
                id: 'user',
                localId: null,
                createdAt: 1,
                text: 'run one tool',
            },
        ];

        const items = groupToolCallsForDisplay(messages, true, { groupSingleToolCalls: true });

        expect(items.map((item) => item.type)).toEqual(['tool-group', 'message']);
        expect(items[0]).toMatchObject({
            type: 'tool-group',
            id: 'group-tool-only',
            hasPendingPermission: false,
        });
        if (items[0].type !== 'tool-group') {
            throw new Error('Expected a tool group');
        }
        expect(items[0].messages.map((message) => message.id)).toEqual(['tool-only']);
    });
});

describe('group summaries follow the canonical outcome', () => {
    function edit(id: string, filePath: string, options: { state?: 'completed' | 'error' | 'running'; result?: unknown; pending?: boolean } = {}): ToolCallMessage {
        return {
            kind: 'tool-call',
            id,
            localId: null,
            createdAt: 1,
            tool: {
                name: 'Edit',
                state: options.state ?? 'completed',
                input: { file_path: filePath, old_string: 'a', new_string: 'b' },
                createdAt: 1,
                startedAt: 1,
                completedAt: 2,
                description: null,
                result: options.result,
                ...(options.pending ? { permission: { id: `p-${id}`, status: 'pending' as const } } : {}),
            },
            children: [],
        };
    }

    it('reports a failed edit as a failure, not as an edited file (#318)', () => {
        const summary = generateGroupSummary([edit('ok', '/a.ts'), edit('bad', '/b.ts', { state: 'error', result: 'No matching text found' })]);
        expect(summary).toBe('toolGroup.editedFiles:1, tools.group.failed:1');
    });

    it('reports a pending approval as awaiting, not as done', () => {
        expect(generateGroupSummary([edit('wait', '/a.ts', { state: 'running', pending: true })])).toBe('tools.group.awaiting:1');
    });

    it('reports a still-running edit as pending, never as an edited file (#318)', () => {
        expect(generateGroupSummary([edit('live', '/a.ts', { state: 'running' })])).toBe('tools.outcome.pending:');
        expect(generateGroupSummary([edit('done', '/a.ts'), edit('live', '/b.ts', { state: 'running' })]))
            .toBe('toolGroup.editedFiles:1, tools.outcome.pending:');
    });

    it('counts distinct affected files, not tool calls (#319)', () => {
        const patch: ToolCallMessage = {
            kind: 'tool-call',
            id: 'patch',
            localId: null,
            createdAt: 1,
            tool: {
                name: 'CodexPatch',
                state: 'completed',
                input: { changes: { 'a.ts': { diff: '@@ -1 +1 @@\n-x\n+y' }, 'b.ts': { add: { content: 'new' } } } },
                createdAt: 1,
                startedAt: 1,
                completedAt: 2,
                description: null,
            },
            children: [],
        };
        expect(generateGroupSummary([patch])).toBe('toolGroup.editedFiles:2');
        expect(generateGroupSummary([edit('e1', '/a.ts'), edit('e2', '/a.ts')])).toBe('toolGroup.editedFiles:1');
    });

    it('sees a pending permission nested under a Task (#317)', () => {
        const task: ToolCallMessage = {
            kind: 'tool-call',
            id: 'task',
            localId: null,
            createdAt: 1,
            tool: { name: 'Task', state: 'running', input: { prompt: 'p' }, createdAt: 1, startedAt: 1, completedAt: null, description: null },
            children: [edit('nested', '/a.ts', { state: 'running', pending: true })],
        };
        expect(hasPendingPermission([task])).toBe(true);
        expect(groupToolCallsForDisplay([task, edit('other', '/b.ts')], true)[0]).toMatchObject({ type: 'tool-group', hasPendingPermission: true });
    });
});
