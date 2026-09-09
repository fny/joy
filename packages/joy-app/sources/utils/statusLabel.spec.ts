import { describe, it, expect, vi } from 'vitest';

vi.mock('@/text', () => ({
    t: (key: string, params?: Record<string, unknown>) => params ? `${key}(${JSON.stringify(params)})` : key,
}));

import { statusHeadline, statusText, backgroundSuffixParts } from './statusLabel';
import { sessionFacts, type SessionState, type SessionFacts } from '@/sync/sessionFacts';

const ALL_STATES: SessionState[] = [
    'disconnected', 'detached', 'blocked', 'retrying', 'compacting',
    'stalled', 'thinking', 'tasks', 'agents', 'waiting', 'permission_required',
];

const words = { vibing: 'brewing…', lastSeen: 'last seen 5m ago' };
const facts = (over: Partial<SessionFacts> = {}): SessionFacts => ({
    ...sessionFacts({ thinking: false, presence: 'online', activeAt: Date.now() }, true),
    ...over,
});

describe('statusHeadline', () => {
    it('says something specific for every state', () => {
        // The bug this replaces: a state the chain had not been taught fell
        // through to "online" while the dot showed that state's colour, so the
        // sidebar text contradicted the session it was describing. Adding a
        // state to the union without a word for it now fails here.
        const generic = 'status.online';
        for (const state of ALL_STATES) {
            const text = statusHeadline(state, facts(), words);
            expect(text, state).toBeTruthy();
            if (state !== 'waiting') expect(text, state).not.toBe(generic);
        }
    });

    it('names which prompt is holding the pane', () => {
        expect(statusHeadline('blocked', facts({ blocked: { kind: 'login' } }), words)).toBe('status.signInRequired');
        expect(statusHeadline('blocked', facts({ blocked: { kind: 'approval' } }), words)).toBe('status.approvalRequired');
        expect(statusHeadline('blocked', facts({ blocked: { kind: 'dialog' } }), words)).toBe('status.waitingInTerminal');
    });

    it('says how long a stalled turn has been quiet, rounded to whole minutes', () => {
        const now = 100 * 60_000;
        const f = facts({ stalled: { since: now - 42 * 60_000 } });
        expect(statusHeadline('stalled', f, { ...words, now })).toBe('status.stalled({"minutes":42})');
        // Never "0m": a stall that has only just been declared still reads as one.
        expect(statusHeadline('stalled', facts({ stalled: { since: now } }), { ...words, now })).toBe('status.stalled({"minutes":1})');
    });

    it('uses the caller-supplied words where the clock or randomness is involved', () => {
        expect(statusHeadline('thinking', facts(), words)).toBe('brewing…');
        expect(statusHeadline('disconnected', facts(), words)).toBe('last seen 5m ago');
    });
});

describe('backgroundSuffixParts', () => {
    const busy = facts({ agents: { done: 1, total: 3 }, tasks: { done: 2, total: 4 }, longRunning: 2 });

    it('lists concurrent work the single badge could not show', () => {
        expect(backgroundSuffixParts('thinking', busy)).toEqual([
            'status.agentsRunning({"done":1,"total":3})',
            'status.tasksCompleted({"done":2,"total":4})',
            'status.backgroundProcesses({"count":2})',
        ]);
    });

    it('omits the count that is already the headline', () => {
        expect(backgroundSuffixParts('agents', busy)).not.toContain('status.agentsRunning({"done":1,"total":3})');
        expect(backgroundSuffixParts('tasks', busy)).not.toContain('status.tasksCompleted({"done":2,"total":4})');
    });

    it('says nothing for a session we cannot hear from', () => {
        // Its counts are a snapshot of a dead session, not live work.
        for (const state of ['disconnected', 'detached'] as SessionState[]) {
            expect(backgroundSuffixParts(state, busy)).toEqual([]);
        }
    });
});

describe('statusText', () => {
    it('joins with a space after an ellipsis and a comma otherwise', () => {
        const one = facts({ longRunning: 3 });
        expect(statusText('thinking', one, words)).toBe('brewing… status.backgroundProcesses({"count":3})');
        expect(statusText('waiting', one, words)).toBe('status.online, status.backgroundProcesses({"count":3})');
    });

    it('is just the headline when nothing runs behind it', () => {
        expect(statusText('waiting', facts(), words)).toBe('status.online');
    });
});
