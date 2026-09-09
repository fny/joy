import { describe, it, expect } from 'vitest';
import {
    sessionFacts, statusState, isTurnActive, hasWorkInFlight,
    type SessionFactsInput, type SessionState,
} from './sessionFacts';

/**
 * The ladder EXACTLY as buildSessionRowData spelled it inline, kept here as an
 * oracle. The point of the refactor is that this expression stops existing in
 * two places; the point of this test is that the replacement agrees with it on
 * every input, not just the ones somebody thought to try.
 */
function legacyState(s: SessionFactsInput, isOnline: boolean): SessionState {
    const hasPermissions = !!(s.agentState?.requests && Object.keys(s.agentState.requests).length > 0);
    if (isOnline && s.metadata?.joy__state === 'detached') return 'detached';
    if (!isOnline) return 'disconnected';
    if (s.metadata?.joy__retry) return 'retrying';
    if (s.metadata?.joy__compacting) return 'compacting';
    if (hasPermissions) return 'permission_required';
    if (s.thinking || (isOnline && s.metadata?.joy__thinking != null)) return 'thinking';
    if (s.metadata?.joy__agents && s.metadata.joy__agents.total > 0) return 'agents';
    if (s.metadata?.joy__tasks && s.metadata.joy__tasks.total > 0) return 'tasks';
    return 'waiting';
}

const ONLINE = [true, false];
const LIFECYCLE = [undefined, 'running', 'detached', 'archived'];
const RETRY = [null, { attempt: 1, total: 3, nextAt: 0, status: 500 }];
const COMPACTING = [null, { trigger: 'auto' as const, since: 0 }];
const PERMS = [null, { 'req-1': {} }];
const THINKING = [true, false];
const MIRROR = [null, { since: 0 }];
const COUNTS = [null, { done: 0, total: 0 }, { done: 1, total: 3 }];

function* everyCombination(): Generator<{ session: SessionFactsInput; online: boolean }> {
    const now = Date.now();
    for (const online of ONLINE)
        for (const joy__state of LIFECYCLE)
            for (const joy__retry of RETRY)
                for (const joy__compacting of COMPACTING)
                    for (const requests of PERMS)
                        for (const thinking of THINKING)
                            for (const joy__thinking of MIRROR)
                                for (const joy__agents of COUNTS)
                                    for (const joy__tasks of COUNTS) {
                                        yield {
                                            online,
                                            session: {
                                                thinking,
                                                // Online is presence + freshness; make the pair agree with
                                                // the flag so isAgentBusy sees the same world the ladder does.
                                                presence: online ? 'online' : now - 600_000,
                                                activeAt: online ? now : now - 600_000,
                                                agentState: { requests },
                                                metadata: {
                                                    joy__state, joy__retry, joy__compacting,
                                                    joy__thinking, joy__agents, joy__tasks,
                                                },
                                            },
                                        };
                                    }
}

describe('statusState is the ladder that storage.ts and sessionUtils.ts each had', () => {
    it('agrees with the previous inline implementation on every combination', () => {
        let checked = 0;
        const disagreements: string[] = [];
        for (const { session, online } of everyCombination()) {
            const got = statusState(sessionFacts(session, online));
            const want = legacyState(session, online);
            if (got !== want) {
                disagreements.push(`${JSON.stringify({ online, ...session.metadata, thinking: session.thinking })}: ${got} ≠ ${want}`);
            }
            checked++;
        }
        expect(disagreements).toEqual([]);
        // Guard the guard: a generator that silently yields nothing would pass.
        expect(checked).toBe(2 * 4 * 2 * 2 * 2 * 2 * 2 * 3 * 3);
    });
});

const base = (over: Partial<SessionFactsInput> = {}): SessionFactsInput => ({
    thinking: false, presence: 'online', activeAt: Date.now(), ...over,
});

describe('facts the ladder used to throw away', () => {
    it('keeps background counts alongside a live turn', () => {
        const f = sessionFacts(base({
            thinking: true,
            metadata: { joy__agents: { done: 1, total: 3 }, joy__tasks: { done: 2, total: 4 }, joy__longRunning: 2 },
        }), true);
        // The badge can only say one thing...
        expect(statusState(f)).toBe('thinking');
        // ...but the counts are still there to render, rather than needing to be
        // recovered from a concatenated string.
        expect(f.agents).toEqual({ done: 1, total: 3 });
        expect(f.tasks).toEqual({ done: 2, total: 4 });
        expect(f.longRunning).toBe(2);
    });

    it('treats a zero total as nothing running', () => {
        const f = sessionFacts(base({ metadata: { joy__agents: { done: 0, total: 0 } } }), true);
        expect(f.agents).toBeNull();
        expect(statusState(f)).toBe('waiting');
    });

    it('reports the pane-blocking prompt the status ladder never knew about', () => {
        const dialog = sessionFacts(base({
            thinking: true,
            metadata: { joy__thinking: { since: 0 }, joy__dialog: { title: 'Switch model?', options: ['Yes', 'No'] } },
        }), true);
        expect(dialog.blocked).toEqual({ kind: 'dialog', title: 'Switch model?' });
        // Documents today's behaviour, which is the bug: a dialog owns the pane
        // and nothing will move, yet the badge still says a reply is streaming.
        expect(statusState(dialog)).toBe('thinking');
    });

    it('ranks pane-owning prompts most-blocking first', () => {
        const all = base({
            metadata: {
                joy__login: { url: 'https://example.test' },
                joy__dialog: { title: null, options: [] },
                joy__codexApproval: { title: 'rm -rf', kind: 'command' },
            },
        });
        expect(sessionFacts(all, true).blocked?.kind).toBe('login');
    });

    it('keeps a permission request separate from a pane prompt — both can be up', () => {
        const f = sessionFacts(base({
            agentState: { requests: { 'req-1': {} } },
            metadata: { joy__dialog: { title: null, options: [] } },
        }), true);
        expect(f.blocked?.kind).toBe('dialog');
        expect(f.permission).toBe(true);
        // Unchanged: permission still wins the badge, as it did before.
        expect(statusState(f)).toBe('permission_required');
    });

    it('surfaces the queue, including a halted auto-drain', () => {
        const f = sessionFacts(base({
            metadata: {
                joy__queue: {
                    queue: [{ id: 'a' }, { id: 'b' }], inFlight: 'c',
                    paused: true, pauseReason: 'dispatch_timeout',
                },
            },
        }), true);
        expect(f.queue).toEqual({ depth: 2, inFlight: true, paused: true, pauseReason: 'dispatch_timeout' });
    });

    it('surfaces the terminal event-budget state', () => {
        expect(sessionFacts(base({ metadata: { joy__eventBudget: { since: 1, dropped: 7 } } }), true).budgetExhausted).toBe(true);
        expect(sessionFacts(base({ metadata: { joy__eventBudget: { since: 1, dropped: 0 } } }), true).budgetExhausted).toBe(false);
    });

    it('distinguishes lifecycle from connectivity', () => {
        const archived = sessionFacts(base({ metadata: { joy__state: 'archived' } }), true);
        expect(archived.lifecycle).toBe('archived');
        // The badge has no 'archived' — such rows are filtered out of the active
        // group instead — so it reads as ready, exactly as it did before.
        expect(statusState(archived)).toBe('waiting');
    });
});

describe('isTurnActive — the question eviction, unread and the send gate all meant to ask', () => {
    const turnCases: Array<[string, SessionFactsInput]> = [
        ['ephemeral thinking flag', base({ thinking: true })],
        ['persisted mirror only', base({ metadata: { joy__thinking: { since: 0 } } })],
        ['compacting', base({ metadata: { joy__compacting: { trigger: 'auto', since: 0 } } })],
        ['retrying', base({ metadata: { joy__retry: { attempt: 1, total: 3 } } })],
    ];

    for (const [name, session] of turnCases) {
        it(`counts ${name} as a live turn`, () => {
            expect(isTurnActive(sessionFacts(session, true))).toBe(true);
        });
    }

    it('is false for an idle session', () => {
        expect(isTurnActive(sessionFacts(base(), true))).toBe(false);
    });

    it('does not trust either thinking signal once the session is stale', () => {
        const dead = { thinking: true, presence: 600_000, activeAt: 0, metadata: { joy__thinking: { since: 0 } } };
        expect(isTurnActive(sessionFacts(dead, false))).toBe(false);
    });

    it('hasWorkInFlight also covers background work outliving the turn', () => {
        const f = sessionFacts(base({ metadata: { joy__tasks: { done: 1, total: 2 } } }), true);
        expect(isTurnActive(f)).toBe(false);
        expect(hasWorkInFlight(f)).toBe(true);
    });
});
