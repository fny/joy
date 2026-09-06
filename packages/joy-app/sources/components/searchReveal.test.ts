import { describe, expect, it, vi } from 'vitest';
import { nestedGroupContaining, resolveRevealScroll, rowContainsMessage, SEARCH_VIEW_POSITION } from './searchReveal';
import { groupToolCallsForDisplay } from '@/hooks/useGroupedMessages';
import type { AgentWorkGroupItem, DisplayItem } from '@/hooks/useGroupedMessages';
import type { Message, ToolCallMessage } from '@/sync/typesMessage';

vi.mock('@/components/tools/knownTools', () => ({
    knownTools: {},
}));

vi.mock('@/text', () => ({
    t: (key: string, params?: { count?: number }) => `${key}:${params?.count ?? ''}`,
}));

function toolMessage(id: string, createdAt: number): ToolCallMessage {
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
        },
        children: [],
    };
}

function agentText(id: string, createdAt: number): Message {
    return { kind: 'agent-text', id, localId: null, createdAt, text: id };
}

describe('search reveal (#203)', () => {
    it('locates the nested tool group that holds a hit inside an agent-work-group', () => {
        // Newest-first, as AgentWorkGroupItem.messages are stored: two tool
        // calls (one nested group) after an intermediate agent text.
        const work: AgentWorkGroupItem = {
            type: 'agent-work-group',
            id: 'outer',
            messages: [toolMessage('hit', 4), toolMessage('tool-a', 3), agentText('thought', 2)],
            hasRunning: false,
            hasPendingPermission: false,
            startedAt: 2,
            completedAt: 5,
        };
        const nested = groupToolCallsForDisplay(work.messages, true, { groupSingleToolCalls: true });
        const groupId = nestedGroupContaining(nested, 'hit');
        expect(groupId).not.toBeNull();
        expect(nested.find((i) => i.id === groupId)?.type).toBe('tool-group');
        // A bare text item is not inside any nested group.
        expect(nestedGroupContaining(nested, 'thought')).toBeNull();
        expect(nestedGroupContaining(nested, 'absent')).toBeNull();
    });

    it('a single tool call still forms a nested group (groupSingleToolCalls), so it must be opened too', () => {
        const nested = groupToolCallsForDisplay([toolMessage('only', 1)], true, { groupSingleToolCalls: true });
        expect(nestedGroupContaining(nested, 'only')).toBe(nested[0].id);
    });

    it('resolves the row from the current items and lands the measured hit, not the group start', () => {
        const items: DisplayItem[] = [
            { type: 'message', id: 'm-user', message: { kind: 'user-text', id: 'user', localId: null, createdAt: 0, text: 'q' } },
            {
                type: 'agent-work-group',
                id: 'outer',
                messages: [toolMessage('hit', 3), toolMessage('a', 2), toolMessage('b', 1)],
                hasRunning: false, hasPendingPermission: false, startedAt: 1, completedAt: 4,
            },
        ];
        // Reviewer case: a long group whose hit sits 900px below the row top,
        // in a 600px window. Scrolling to the row start would leave it out.
        const windowHeight = 600;
        const scroll = resolveRevealScroll(items, 'hit', { y: 900, height: 40 }, windowHeight);
        expect(scroll).toEqual({ index: 1, viewPosition: 0, viewOffset: 900 - (windowHeight - 40) * SEARCH_VIEW_POSITION });
        // The hit's top ends up at 30% of the free window height.
        const contentOffset = /* row top */ 0 + scroll!.viewOffset!;
        expect(900 - contentOffset).toBeCloseTo((windowHeight - 40) * SEARCH_VIEW_POSITION);
        expect(900 - contentOffset).toBeLessThan(windowHeight);
    });

    it('re-resolves the index when the data shifted under a pending reveal', () => {
        const hitRow: DisplayItem = {
            type: 'tool-group', id: 'g', messages: [toolMessage('hit', 2)], hasRunning: false, hasPendingPermission: false,
        };
        const before: DisplayItem[] = [hitRow];
        const older: DisplayItem = { type: 'message', id: 'm-old', message: agentText('old', 1) };
        const after: DisplayItem[] = [older, hitRow];
        expect(resolveRevealScroll(before, 'hit', null, 600)?.index).toBe(0);
        expect(resolveRevealScroll(after, 'hit', null, 600)?.index).toBe(1);
    });

    it('falls back to positioning the row when no layout is known, and reports a missing hit', () => {
        const items: DisplayItem[] = [
            { type: 'tool-group', id: 'g', messages: [toolMessage('hit', 1)], hasRunning: false, hasPendingPermission: false },
        ];
        expect(resolveRevealScroll(items, 'hit', null, 600)).toEqual({ index: 0, viewPosition: SEARCH_VIEW_POSITION });
        expect(resolveRevealScroll(items, 'nope', null, 600)).toBeNull();
        expect(rowContainsMessage(items[0], 'hit')).toBe(true);
        expect(rowContainsMessage(items[0], 'nope')).toBe(false);
    });

    it('never asks for a hit above the row when the window is unmeasured', () => {
        const items: DisplayItem[] = [
            { type: 'tool-group', id: 'g', messages: [toolMessage('hit', 1)], hasRunning: false, hasPendingPermission: false },
        ];
        expect(resolveRevealScroll(items, 'hit', { y: 120, height: 40 }, 0)?.viewOffset).toBe(120);
    });
});
