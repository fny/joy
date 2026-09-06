import { describe, expect, it } from 'vitest';
import {
    PENDING_PROMPT_MAX,
    PENDING_PROMPT_MAX_AGE_MS,
    PendingPromptQueue,
    shouldQueuePrompt,
} from './pendingPrompts';

const alwaysPending = () => true;

describe('PendingPromptQueue', () => {
    it('drains oldest first and empties', () => {
        const q = new PendingPromptQueue();
        q.push({ text: 'a', sessionId: 's1' }, 1);
        q.push({ text: 'b', sessionId: 's2' }, 2);
        expect(q.size).toBe(2);
        expect(q.drain()).toEqual(['a', 'b']);
        expect(q.size).toBe(0);
    });

    it('ages out stale entries (#22)', () => {
        const q = new PendingPromptQueue();
        q.push({ text: 'old', sessionId: 's1' }, 0);
        q.push({ text: 'fresh', sessionId: 's1' }, PENDING_PROMPT_MAX_AGE_MS);
        q.prune(PENDING_PROMPT_MAX_AGE_MS + 1, alwaysPending);
        expect(q.drain()).toEqual(['fresh']);
    });

    it('keeps an entry exactly at the age limit', () => {
        const q = new PendingPromptQueue();
        q.push({ text: 'edge', sessionId: 's1' }, 0);
        q.prune(PENDING_PROMPT_MAX_AGE_MS, alwaysPending);
        expect(q.size).toBe(1);
    });

    it('bounds the backlog, dropping the oldest (#22)', () => {
        const q = new PendingPromptQueue();
        for (let i = 0; i < PENDING_PROMPT_MAX + 5; i++) q.push({ text: `p${i}`, sessionId: 's1' }, i);
        expect(q.size).toBe(PENDING_PROMPT_MAX);
        expect(q.drain()[0]).toBe('p5');
    });

    it('drops an approval prompt once its request is resolved (#341)', () => {
        const q = new PendingPromptQueue();
        q.push({ text: 'approve Write?', sessionId: 's1', requestId: 'r1' }, 1);
        q.push({ text: 'turn ended', sessionId: 's1' }, 2);
        q.removeRequest('r1');
        expect(q.drain()).toEqual(['turn ended']);
    });

    it('revalidates approval prompts at flush time (#341)', () => {
        const q = new PendingPromptQueue();
        q.push({ text: 'approve Bash?', sessionId: 's1', requestId: 'r1' }, 1);
        q.push({ text: 'approve Edit?', sessionId: 's2', requestId: 'r2' }, 2);
        q.push({ text: 'question', sessionId: 's2' }, 3);
        q.prune(10, (sessionId, requestId) => sessionId === 's2' && requestId === 'r2');
        expect(q.drain()).toEqual(['approve Edit?', 'question']);
    });

    it('lists the distinct sessions with queued prompts, oldest first (#340)', () => {
        const q = new PendingPromptQueue();
        q.push({ text: 'a', sessionId: 'B' }, 1);
        q.push({ text: 'b', sessionId: 'A' }, 2);
        q.push({ text: 'c', sessionId: 'B' }, 3);
        expect(q.sessionIds()).toEqual(['B', 'A']);
    });

    it('clear empties everything', () => {
        const q = new PendingPromptQueue();
        q.push({ text: 'a', sessionId: 's1' }, 1);
        q.clear();
        expect(q.size).toBe(0);
        expect(q.sessionIds()).toEqual([]);
    });
});

describe('shouldQueuePrompt (#22)', () => {
    it('queues over a live or imminent line regardless of the event-wake setting', () => {
        expect(shouldQueuePrompt({ status: 'connected', wakeOnEvents: false })).toBe(true);
        expect(shouldQueuePrompt({ status: 'connecting', wakeOnEvents: false })).toBe(true);
    });

    it('queues while hung up only when an event wake will bring the line up', () => {
        expect(shouldQueuePrompt({ status: 'disconnected', wakeOnEvents: true })).toBe(true);
        expect(shouldQueuePrompt({ status: 'error', wakeOnEvents: true })).toBe(true);
        expect(shouldQueuePrompt({ status: 'disconnected', wakeOnEvents: false })).toBe(false);
        expect(shouldQueuePrompt({ status: 'error', wakeOnEvents: false })).toBe(false);
    });
});
