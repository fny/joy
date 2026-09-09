import { describe, it, expect } from 'vitest';
import {
    sessionFacts, liveFacts, statusState, isTurnActive, hasWorkInFlight, finishedWork,
    type SessionFactsInput, type SessionState,
} from './sessionFacts';

/**
 * The ladder EXACTLY as buildSessionRowData spelled it inline, kept here as an
 * oracle. The point of the refactor was that this expression stops existing in
 * two places; the point of this test is that the replacement agrees with it on
 * every input, not just the ones somebody thought to try.
 *
 * Scope: the axes the old ladder could actually read. It had never heard of a
 * pane-owning prompt, so `blocked` is a deliberate divergence, asserted
 * separately below rather than smuggled past this oracle.
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

    it('a pane-owning prompt wins from every state we can still hear from', () => {
        // The one intended divergence, asserted across the whole space rather
        // than on the handful of combinations that came to mind: whatever else
        // is true, if something is waiting on a human at the terminal that is
        // what the badge says — unless we cannot reach the session at all, or
        // Claude itself is gone, which are both worse news.
        for (const { session, online } of everyCombination()) {
            const blocked = {
                ...session,
                metadata: { ...session.metadata, joy__dialog: { title: 'Switch model?', options: ['Yes', 'No'] } },
            };
            const got = statusState(sessionFacts(blocked, online));
            const expected = !online ? 'disconnected'
                : session.metadata?.joy__state === 'detached' ? 'detached'
                : 'blocked';
            expect(got).toBe(expected);
        }
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

    it('reports a pane-blocking prompt over a turn that cannot be progressing', () => {
        const dialog = sessionFacts(base({
            thinking: true,
            metadata: { joy__thinking: { since: 0 }, joy__dialog: { title: 'Switch model?', options: ['Yes', 'No'] } },
        }), true);
        expect(dialog.blocked).toEqual({ kind: 'dialog', title: 'Switch model?' });
        // The turn is still open as far as the thinking signals go, but a dialog
        // owns the pane so nothing is going to move. The badge used to say a
        // reply was streaming while the terminal sat on a model picker.
        expect(dialog.turn).toBe('thinking');
        expect(statusState(dialog)).toBe('blocked');
    });

    it('ranks a pane prompt above the states it usually explains', () => {
        const blocking = { joy__login: { url: 'https://example.test' } };
        for (const other of [
            { joy__retry: { attempt: 2, total: 5 } },
            { joy__compacting: { trigger: 'auto' as const, since: 0 } },
        ]) {
            expect(statusState(sessionFacts(base({ metadata: { ...blocking, ...other } }), true))).toBe('blocked');
        }
        // A permission request can coexist with a pane prompt; the prompt wins,
        // because the permission cannot be reached until the pane clears.
        expect(statusState(sessionFacts(base({
            agentState: { requests: { 'req-1': {} } }, metadata: blocking,
        }), true))).toBe('blocked');
    });

    it('still reads as offline when we cannot hear from the session at all', () => {
        const stale = { thinking: false, presence: 600_000, activeAt: 0, metadata: { joy__dialog: { title: null, options: [] } } };
        expect(statusState(sessionFacts(stale, false))).toBe('disconnected');
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
        // Both are true at once; the pane prompt is the one to act on first.
        expect(statusState(f)).toBe('blocked');
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

describe('finishedWork — the falling edge behind the unread marker', () => {
    const live = (over: Partial<SessionFactsInput> = {}) => liveFacts(base(over));
    const idle = () => live();

    it('fires when a turn ends, whichever signal was carrying it', () => {
        const carriers: Array<[string, Partial<SessionFactsInput>]> = [
            ['ephemeral flag', { thinking: true }],
            ['persisted mirror', { metadata: { joy__thinking: { since: 0 } } }],
            ['compaction', { metadata: { joy__compacting: { trigger: 'auto', since: 0 } } }],
            ['retry backoff', { metadata: { joy__retry: { attempt: 1, total: 3 } } }],
        ];
        for (const [name, over] of carriers) {
            expect(finishedWork(live(over), idle()), name).toBe(true);
        }
    });

    it('does not fire when nothing was happening', () => {
        expect(finishedWork(idle(), idle())).toBe(false);
    });

    it('does not fire while the turn is still open', () => {
        expect(finishedWork(live({ thinking: true }), live({ thinking: true }))).toBe(false);
    });

    it('does not fire when the session merely went quiet because it needs you', () => {
        // Stopping at a question is not finishing: no result has been produced,
        // and the status already says what is being asked.
        const asks: Array<[string, Partial<SessionFactsInput>]> = [
            ['a permission request', { agentState: { requests: { 'r1': {} } } }],
            ['a login prompt', { metadata: { joy__login: { url: 'https://example.test' } } }],
            ['a terminal dialog', { metadata: { joy__dialog: { title: null, options: [] } } }],
            ['a codex approval', { metadata: { joy__codexApproval: { title: 'rm -rf', kind: 'command' } } }],
        ];
        for (const [name, over] of asks) {
            expect(finishedWork(live({ thinking: true }), live(over)), name).toBe(false);
            // ...and clearing it afterwards IS the finish.
            expect(finishedWork(live(over), idle()), name).toBe(true);
        }
    });

    it('does not fire when the session went offline instead of finishing', () => {
        const gone = liveFacts({ thinking: false, presence: 600_000, activeAt: 0 });
        expect(finishedWork(live({ thinking: true }), gone)).toBe(false);
    });
});

describe('stalled — a long-silent turn is reported, never acted on', () => {
    const quiet = { joy__stalled: { since: 1_000, silentForMs: 30 * 60_000 } };

    it('replaces the vibing message over an open turn', () => {
        const f = sessionFacts(base({ thinking: true, metadata: quiet }), true);
        expect(f.stalled).toEqual({ since: 1_000 });
        expect(f.turn).toBe('thinking');
        expect(statusState(f)).toBe('stalled');
    });

    it('is still a live turn for everything that asks — eviction, the send gate, unread', () => {
        expect(isTurnActive(sessionFacts(base({ thinking: true, metadata: quiet }), true))).toBe(true);
    });

    it('is ignored when there is no open turn to be stalled', () => {
        // The daemon clears the flag on turn end; if a stale one survives, an
        // idle session must not read as stuck.
        const f = sessionFacts(base({ thinking: false, metadata: quiet }), true);
        expect(f.stalled).toBeNull();
        expect(statusState(f)).toBe('waiting');
    });

    it('yields to the states you can act on, and to being unreachable', () => {
        const withPermission = base({ thinking: true, agentState: { requests: { r1: {} } }, metadata: quiet });
        expect(statusState(sessionFacts(withPermission, true))).toBe('permission_required');
        const withDialog = base({ thinking: true, metadata: { ...quiet, joy__dialog: { title: null, options: [] } } });
        expect(statusState(sessionFacts(withDialog, true))).toBe('blocked');
        const gone = { thinking: true, presence: 600_000, activeAt: 0, metadata: quiet };
        expect(statusState(sessionFacts(gone, false))).toBe('disconnected');
    });
});
