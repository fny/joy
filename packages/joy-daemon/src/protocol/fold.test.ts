/**
 * Pure-fold conformance tests — comm-layer-spec §17 + §22.
 *
 * Every spec invariant should be enforceable by a unit test that runs on
 * a synthetic event log. Same log ⇒ identical projection on every consumer
 * (I5). These tests are also the seed of the shared golden corpus used by
 * the app-side fold (§22 conformance harness).
 */
import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { fold, foldAll, type FoldEvent } from './fold';
import { initialProjection, isTerminalState } from './projection';
import type { Envelope } from './envelope';
import type { AnyEvent } from './events';

let nextSeq = 0;
function ev<T extends AnyEvent>(event: T, opts: { by?: string; eventId?: string; turnId?: string | null } = {}): FoldEvent {
    nextSeq += 1;
    const envelope: Envelope = {
        eventId: opts.eventId ?? randomUUID(),
        type: event.type,
        v: 1,
        vmin: null,
        sessionId: 's',
        turnId: opts.turnId ?? null,
        by: opts.by ?? 't',
        ts: nextSeq,
        payload: event.payload,
    };
    return { seq: nextSeq, envelope, event };
}

function resetSeq() {
    nextSeq = 0;
}

describe('fold: basics', () => {
    it('empty fold yields initial projection', () => {
        resetSeq();
        const p = foldAll([]);
        expect(p).toEqual(initialProjection());
    });

    it('lastEventSeq advances monotonically', () => {
        resetSeq();
        const a = ev({ type: 'mode-change', payload: { permissionMode: 'auto' } });
        const b = ev({ type: 'mode-change', payload: { permissionMode: 'plan' } });
        const p = foldAll([a, b]);
        expect(p.lastEventSeq).toBe(b.seq);
    });

    it('duplicate/out-of-order seq is identity', () => {
        resetSeq();
        const a = ev({ type: 'mode-change', payload: { model: 'opus' } });
        const p1 = fold(initialProjection(), a);
        const dup = { ...a }; // same seq
        const p2 = fold(p1, dup);
        expect(p2).toBe(p1);
        const stale = { ...a, seq: a.seq - 1 };
        const p3 = fold(p1, stale);
        expect(p3).toBe(p1);
    });

    it('unknown event type is identity (forward-compat)', () => {
        resetSeq();
        // Construct an "AnyEvent" off-union by casting; the fold's switch is
        // exhaustive but its trailing `return next;` (out of switch) catches
        // unknown types.
        const unknown = { type: 'future-event', payload: { foo: 1 } } as unknown as AnyEvent;
        const e = ev(unknown);
        const p = fold(initialProjection(), e);
        expect(p.lastEventSeq).toBe(e.seq);
        // No other state should have changed
        expect(p.turns).toEqual({});
    });
});

describe('fold: writer-claim / lease', () => {
    it('higher epoch wins; lower no-op', () => {
        resetSeq();
        const claim1 = ev({ type: 'writer-claim', payload: { daemonId: 'd1', epoch: 1 } });
        const claim3 = ev({ type: 'writer-claim', payload: { daemonId: 'd2', epoch: 3 } });
        const claim2 = ev({ type: 'writer-claim', payload: { daemonId: 'd3', epoch: 2 } });
        const p = foldAll([claim1, claim3, claim2]);
        expect(p.writerEpoch).toBe(3);
        expect(p.writerClaimSeq).toBe(claim3.seq);
    });
});

describe('fold: mode-change', () => {
    it('last-by-seq wins; partial updates merge', () => {
        resetSeq();
        const a = ev({ type: 'mode-change', payload: { permissionMode: 'auto', model: 'sonnet' } });
        const b = ev({ type: 'mode-change', payload: { model: 'opus' } });
        const p = foldAll([a, b]);
        expect(p.config).toEqual({ permissionMode: 'auto', model: 'opus' });
    });
});

describe('fold: turn lifecycle', () => {
    it('user-message creates a pending turn id == envelope.eventId', () => {
        resetSeq();
        const u = ev({ type: 'user-message', payload: { messageId: 'm1', content: 'hi' } }, { eventId: 't-1' });
        const p = fold(initialProjection(), u);
        expect(p.order).toEqual(['t-1']);
        expect(p.turns['t-1']?.state).toBe('pending');
        expect(p.turns['t-1']?.requestEventId).toBe('t-1');
    });

    it('turn-started moves pending → running', () => {
        resetSeq();
        const u = ev({ type: 'user-message', payload: { messageId: 'm1', content: 'hi' } }, { eventId: 't-1' });
        const s = ev({ type: 'turn-started', payload: { turnId: 't-1', requestEventId: 't-1' } });
        const p = foldAll([u, s]);
        expect(p.turns['t-1']?.state).toBe('running');
    });

    it('turn-completed terminalizes; duplicate terminal is idempotent', () => {
        resetSeq();
        const u = ev({ type: 'user-message', payload: { messageId: 'm1', content: 'hi' } }, { eventId: 't-1' });
        const s = ev({ type: 'turn-started', payload: { turnId: 't-1', requestEventId: 't-1' } });
        const c = ev({ type: 'turn-completed', payload: { turnId: 't-1', usage: { tokens: 10 } } });
        const c2 = ev({ type: 'turn-completed', payload: { turnId: 't-1' } });
        const p = foldAll([u, s, c, c2]);
        expect(p.turns['t-1']?.state).toBe('completed');
        expect(p.turns['t-1']?.usage).toEqual({ tokens: 10 });
    });

    it('turn-failed records errorSubtype and terminalizes', () => {
        resetSeq();
        const u = ev({ type: 'user-message', payload: { messageId: 'm1', content: 'hi' } }, { eventId: 't-1' });
        const s = ev({ type: 'turn-started', payload: { turnId: 't-1', requestEventId: 't-1' } });
        const f = ev({ type: 'turn-failed', payload: { turnId: 't-1', errorSubtype: 'error_max_turns' } });
        const p = foldAll([u, s, f]);
        expect(p.turns['t-1']?.state).toBe('failed');
        expect(isTerminalState(p.turns['t-1']!.state)).toBe(true);
    });
});

describe('fold: cancel — including pre-emptive tombstones (§14)', () => {
    it('cancel for running turn terminalizes as cancelled', () => {
        resetSeq();
        const u = ev({ type: 'user-message', payload: { messageId: 'm1', content: 'hi' } }, { eventId: 't-1' });
        const s = ev({ type: 'turn-started', payload: { turnId: 't-1', requestEventId: 't-1' } });
        const c = ev({ type: 'cancel', payload: { targetTurnId: 't-1' } });
        const p = foldAll([u, s, c]);
        expect(p.turns['t-1']?.state).toBe('cancelled');
    });

    it('cancel for unknown turn records tombstone; on turn-started it is applied', () => {
        resetSeq();
        const cancel = ev({ type: 'cancel', payload: { targetTurnId: 't-X' } });
        const p1 = fold(initialProjection(), cancel);
        expect(p1.cancelTombstones).toContain('t-X');

        const u = ev({ type: 'user-message', payload: { messageId: 'm2', content: 'late' } }, { eventId: 't-X' });
        const s = ev({ type: 'turn-started', payload: { turnId: 't-X', requestEventId: 't-X' } });
        const p2 = foldAll([u, s], p1);
        expect(p2.turns['t-X']?.state).toBe('cancelled');
        expect(p2.cancelTombstones).not.toContain('t-X');
    });

    it('cancel * drains all pending and cancels current running', () => {
        resetSeq();
        const u1 = ev({ type: 'user-message', payload: { messageId: 'm1', content: 'a' } }, { eventId: 't-1' });
        const u2 = ev({ type: 'user-message', payload: { messageId: 'm2', content: 'b' } }, { eventId: 't-2' });
        const u3 = ev({ type: 'user-message', payload: { messageId: 'm3', content: 'c' } }, { eventId: 't-3' });
        const s = ev({ type: 'turn-started', payload: { turnId: 't-1', requestEventId: 't-1' } });
        const cancel = ev({ type: 'cancel', payload: { targetTurnId: '*' } });
        const p = foldAll([u1, u2, u3, s, cancel]);
        expect(p.turns['t-1']?.state).toBe('cancelled');
        expect(p.turns['t-2']?.state).toBe('cancelled');
        expect(p.turns['t-3']?.state).toBe('cancelled');
    });

    it('cancel for terminal turn is no-op', () => {
        resetSeq();
        const u = ev({ type: 'user-message', payload: { messageId: 'm1', content: 'hi' } }, { eventId: 't-1' });
        const s = ev({ type: 'turn-started', payload: { turnId: 't-1', requestEventId: 't-1' } });
        const c = ev({ type: 'turn-completed', payload: { turnId: 't-1' } });
        const cancel = ev({ type: 'cancel', payload: { targetTurnId: 't-1' } });
        const p = foldAll([u, s, c, cancel]);
        expect(p.turns['t-1']?.state).toBe('completed');
    });
});

describe('fold: permission lifecycle (§15)', () => {
    it('first permission-response by seq wins; later is no-op', () => {
        resetSeq();
        const req = ev({ type: 'permission-request', payload: { reqId: 'r1', turnId: 't-1', toolCall: {}, options: ['ok', 'no'] } });
        const a1 = ev({ type: 'permission-response', payload: { reqId: 'r1', optionId: 'ok' } });
        const a2 = ev({ type: 'permission-response', payload: { reqId: 'r1', optionId: 'no' } });
        const p = foldAll([req, a1, a2]);
        expect(p.openPermissions['r1']).toBeUndefined();
        expect(p.permissionsAnswered['r1']).toEqual({ optionId: 'ok', auto: false });
    });

    it('re-emitted permission-request after answer is no-op (resume idempotency)', () => {
        resetSeq();
        const req = ev({ type: 'permission-request', payload: { reqId: 'r1', turnId: 't-1', toolCall: {}, options: [] } });
        const ans = ev({ type: 'permission-response', payload: { reqId: 'r1', optionId: 'ok' } });
        const reqAgain = ev({ type: 'permission-request', payload: { reqId: 'r1', turnId: 't-1', toolCall: {}, options: [] } });
        const p = foldAll([req, ans, reqAgain]);
        expect(p.openPermissions['r1']).toBeUndefined();
        expect(p.permissionsAnswered['r1']?.optionId).toBe('ok');
    });

    it('auto-deny flag flows through', () => {
        resetSeq();
        const req = ev({ type: 'permission-request', payload: { reqId: 'r1', turnId: 't-1', toolCall: {}, options: [] } });
        const ans = ev({ type: 'permission-response', payload: { reqId: 'r1', optionId: 'deny', auto: true } });
        const p = foldAll([req, ans]);
        expect(p.permissionsAnswered['r1']).toEqual({ optionId: 'deny', auto: true });
    });
});

describe('fold: background tasks (§16)', () => {
    it('bg lifecycle: started → progress (no-op) → notification', () => {
        resetSeq();
        const s = ev({ type: 'bg-started', payload: { taskId: 'b1', turnId: 't-1', label: 'sweep' } });
        const pg = ev({ type: 'bg-progress', payload: { taskId: 'b1' } });
        const n = ev({ type: 'bg-notification', payload: { taskId: 'b1', status: 'completed' } });
        const p = foldAll([s, pg, n]);
        expect(p.bgTasks['b1']?.status).toBe('completed');
    });

    it('bg-exited marks task exited even if no terminal notification', () => {
        resetSeq();
        const s = ev({ type: 'bg-started', payload: { taskId: 'b1', turnId: 't-1', label: 'sweep' } });
        const x = ev({ type: 'bg-exited', payload: { taskId: 'b1', reason: 'daemon-restart' } });
        const p = foldAll([s, x]);
        expect(p.bgTasks['b1']?.status).toBe('exited');
    });
});

describe('fold: agent-metadata + heartbeat', () => {
    it('agent-metadata merges partial updates', () => {
        resetSeq();
        const a = ev({ type: 'agent-metadata', payload: { tools: ['Bash'], slashCommands: ['/help'] } });
        const b = ev({ type: 'agent-metadata', payload: { models: ['opus'] } });
        const p = foldAll([a, b]);
        expect(p.agentMeta.tools).toEqual(['Bash']);
        expect(p.agentMeta.slashCommands).toEqual(['/help']);
        expect(p.agentMeta.models).toEqual(['opus']);
    });

    it('heartbeat tracks the latest by seq', () => {
        resetSeq();
        const h1 = ev({ type: 'heartbeat', payload: { turnId: 't-1', hbCounter: 1 } });
        const h2 = ev({ type: 'heartbeat', payload: { turnId: 't-1', hbCounter: 2 } });
        const p = foldAll([h1, h2]);
        expect(p.lastHeartbeat?.hbCounter).toBe(2);
        expect(p.lastHeartbeat?.atSeq).toBe(h2.seq);
    });
});

describe('fold: structural-only events do not corrupt projection', () => {
    it('tool-call / tool-result / turn-output / snapshot / cursor / digest / rejected only advance lastEventSeq', () => {
        resetSeq();
        const u = ev({ type: 'user-message', payload: { messageId: 'm1', content: 'hi' } }, { eventId: 't-1' });
        const s = ev({ type: 'turn-started', payload: { turnId: 't-1', requestEventId: 't-1' } });
        const tc = ev({ type: 'tool-call', payload: { turnId: 't-1', toolCallId: 'tc1', name: 'Bash', input: { cmd: 'ls' }, state: 'running' } });
        const tr = ev({ type: 'tool-result', payload: { turnId: 't-1', toolCallId: 'tc1', ok: true, result: 'ok' } });
        const out = ev({ type: 'turn-output', payload: { turnId: 't-1', messageId: 'mid1', content: 'hello' } });
        const cur = ev({ type: 'cursor', payload: { appliedSeq: 1 } });
        const dig = ev({ type: 'projection-digest', payload: { uptoSeq: 1, hash: 'abc' } });
        const rej = ev({ type: 'rejected', payload: { refEventId: 'foo', reason: 'unknown' } });
        const snap = ev({ type: 'snapshot', payload: { uptoSeq: 1, projection: {} } });
        const p = foldAll([u, s, tc, tr, out, cur, dig, rej, snap]);
        expect(p.turns['t-1']?.state).toBe('running'); // structural events don't alter the state machine
        expect(p.lastEventSeq).toBe(snap.seq);
    });
});

describe('fold: convergence (I5)', () => {
    it('two independent folds of the same event list produce identical projections', () => {
        resetSeq();
        const events: FoldEvent[] = [
            ev({ type: 'mode-change', payload: { model: 'opus' } }),
            ev({ type: 'writer-claim', payload: { daemonId: 'd1', epoch: 1 } }),
            ev({ type: 'user-message', payload: { messageId: 'm1', content: 'hi' } }, { eventId: 't-1' }),
            ev({ type: 'turn-started', payload: { turnId: 't-1', requestEventId: 't-1' } }),
            ev({ type: 'heartbeat', payload: { turnId: 't-1', hbCounter: 1 } }),
            ev({ type: 'turn-completed', payload: { turnId: 't-1' } }),
        ];
        const a = foldAll(events);
        const b = foldAll(events);
        expect(a).toEqual(b);
    });
});
