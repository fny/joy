import { describe, it, expect } from 'vitest';
import {
    DONE, IDLE_LANE, MAX_AUTO_ATTEMPTS, MAX_CANCEL_ATTEMPTS, MAX_HOLD_MS, RELEASE_BACKSTOP_MS, RELEASE_SETTLE_MS,
    attemptOwnsDraft, decideRelease, isRemovalPending, localIdOf, nextDraftRelease, nextLane, queuedDraft,
    type DraftReleaseEvent, type DraftReleaseState,
} from './draftReleaseMachine';

const L = 'L1';
const releasing = (over: Partial<Extract<DraftReleaseState, { kind: 'releasing' }>> = {}): DraftReleaseState =>
    ({ kind: 'releasing', attempt: 0, lastError: null, localId: L, leaseUntil: 1_000, token: 7, removal: false, ...over });
const cancelling = (cancelAttempts = 1): DraftReleaseState => ({ kind: 'cancelling', attempt: 0, localId: L, cancelAttempts });
const failed = (over: Partial<Extract<DraftReleaseState, { kind: 'failed' }>> = {}): DraftReleaseState =>
    ({ kind: 'failed', attempt: MAX_AUTO_ATTEMPTS, lastError: 'e', localId: L, cancelFailed: false, cancelAttempts: 0, ...over });

const STATES: Array<[string, DraftReleaseState]> = [
    ['queued', queuedDraft(0, null, null)],
    ['queued(with identity)', queuedDraft(1, 'offline', L)],
    ['releasing', releasing()],
    ['releasing(removal)', releasing({ removal: true })],
    ['cancelling', cancelling()],
    ['failed(attempts)', failed()],
    ['failed(cancel)', failed({ attempt: 1, cancelFailed: true, cancelAttempts: 1 })],
    ['failed(cancel, exhausted)', failed({ attempt: 1, cancelFailed: true, cancelAttempts: MAX_CANCEL_ATTEMPTS })],
    ['done', DONE],
];
const EVENTS: Array<[string, DraftReleaseEvent]> = [
    ['release_started', { type: 'release_started', token: 9, localId: L, leaseUntil: 2_000 }],
    ['rejected(own)', { type: 'rejected', token: 7, localId: L, error: 'boom' }],
    ['rejected(stale token)', { type: 'rejected', token: 6, localId: L, error: 'boom' }],
    ['rejected(other identity)', { type: 'rejected', token: 7, localId: 'L9', error: 'boom' }],
    ['ack(own)', { type: 'ack', localId: L }],
    ['ack(other)', { type: 'ack', localId: 'L9' }],
    ['cancel_ok(own)', { type: 'cancel_ok', localId: L }],
    ['cancel_ok(other)', { type: 'cancel_ok', localId: 'L9' }],
    ['cancel_failed(own)', { type: 'cancel_failed', localId: L, error: 'cf' }],
    ['cancel_failed(other)', { type: 'cancel_failed', localId: 'L9', error: 'cf' }],
    ['user_cancel', { type: 'user_cancel' }],
    ['user_edit', { type: 'user_edit' }],
    ['user_retry', { type: 'user_retry' }],
    ['attachments_missing', { type: 'attachments_missing', ids: ['u'] }],
    ['attachments_ready', { type: 'attachments_ready' }],
];

/** The expected answer for every pair — the rules as prose, in code. */
function expected(name: string, s: DraftReleaseState, ev: DraftReleaseEvent): DraftReleaseState {
    if (s.kind === 'done') return DONE;
    switch (s.kind) {
        case 'queued':
            if (ev.type === 'release_started') return { kind: 'releasing', attempt: s.attempt, lastError: s.lastError, localId: ev.localId, leaseUntil: ev.leaseUntil, token: ev.token, removal: false };
            if (ev.type === 'ack') return ev.localId === s.localId ? DONE : s;
            if (ev.type === 'user_cancel') return DONE;
            if (ev.type === 'user_edit') return { ...s, localId: null };
            if (ev.type === 'user_retry') return { ...s, attempt: 0, lastError: null };
            if (ev.type === 'attachments_missing') return { ...s, missing: ev.ids };
            if (ev.type === 'attachments_ready') return { ...s, missing: [] };
            return s;
        case 'releasing':
            if (ev.type === 'release_started') return { ...s, localId: ev.localId, leaseUntil: ev.leaseUntil, token: ev.token };
            if (ev.type === 'rejected') {
                if (ev.token !== s.token || ev.localId !== s.localId) return s;
                if (s.removal) return DONE;
                return { kind: 'queued', attempt: 1, lastError: 'boom', localId: L, missing: [] };
            }
            if (ev.type === 'ack') return ev.localId !== s.localId ? s : (s.removal ? cancelling(1) : DONE);
            if (ev.type === 'user_cancel') return { ...s, removal: true };
            if (ev.type === 'user_edit') return { kind: 'queued', attempt: 0, lastError: null, localId: null, missing: [] };
            return s;
        case 'cancelling':
            if (ev.type === 'cancel_ok') return ev.localId === s.localId ? DONE : s;
            if (ev.type === 'cancel_failed') return ev.localId === s.localId ? { kind: 'failed', attempt: 1, lastError: 'cf', localId: L, cancelFailed: true, cancelAttempts: 1 } : s;
            if (ev.type === 'user_edit') return { kind: 'queued', attempt: 0, lastError: null, localId: null, missing: [] };
            return s;
        case 'failed':
            if (ev.type === 'ack') {
                if (ev.localId !== s.localId) return s;
                if (!s.cancelFailed) return DONE;
                if (s.cancelAttempts >= MAX_CANCEL_ATTEMPTS) return s;
                return { kind: 'cancelling', attempt: s.attempt, localId: L, cancelAttempts: s.cancelAttempts + 1 };
            }
            if (ev.type === 'user_cancel') return DONE;
            if (ev.type === 'user_edit') return s.attempt >= MAX_AUTO_ATTEMPTS
                ? { ...s, localId: null, cancelFailed: false, cancelAttempts: 0 }
                : { kind: 'queued', attempt: s.attempt, lastError: s.lastError, localId: null, missing: [] };
            if (ev.type === 'user_retry') return { kind: 'queued', attempt: 0, lastError: null, localId: s.localId, missing: [] };
            return s;
    }
    throw new Error(`no expectation for ${name}`);
}

describe('draft release machine (table: every state × every event)', () => {
    for (const [sn, s] of STATES) for (const [en, ev] of EVENTS) {
        it(`${sn} × ${en}`, () => {
            expect(nextDraftRelease(s, ev)).toEqual(expected(sn, s, ev));
        });
    }
});

describe('draft release machine (rules)', () => {
    it('#133: only the owning attempt may revert; a later attempt under the same identity is not reverted by the first one\'s failure', () => {
        const first = nextDraftRelease(queuedDraft(), { type: 'release_started', token: 1, localId: L, leaseUntil: 10 });
        const retried = nextDraftRelease(first, { type: 'release_started', token: 2, localId: L, leaseUntil: 20 });
        expect(attemptOwnsDraft(retried, L, 1)).toBe(false);
        expect(nextDraftRelease(retried, { type: 'rejected', token: 1, localId: L, error: 'late' })).toBe(retried);
        expect(nextDraftRelease(retried, { type: 'rejected', token: 2, localId: L, error: 'own' }).kind).toBe('queued');
    });
    it('the auto-attempt budget parks the draft; a manual retry clears it and keeps the identity', () => {
        let s: DraftReleaseState = queuedDraft();
        for (let i = 0; i < MAX_AUTO_ATTEMPTS; i++) {
            s = nextDraftRelease(s, { type: 'release_started', token: i, localId: L, leaseUntil: 0 });
            s = nextDraftRelease(s, { type: 'rejected', token: i, localId: L, error: 'offline' });
        }
        expect(s).toMatchObject({ kind: 'failed', attempt: MAX_AUTO_ATTEMPTS, cancelFailed: false });
        expect(nextDraftRelease(s, { type: 'user_retry' })).toEqual(queuedDraft(0, null, L));
    });
    it('#134: removal during release settles with the send — failure removes, ack cancels, a failed cancel parks, a replayed ack retries the cancel, bounded', () => {
        const pending = nextDraftRelease(releasing(), { type: 'user_cancel' });
        expect(isRemovalPending(pending)).toBe(true);
        expect(nextDraftRelease(pending, { type: 'rejected', token: 7, localId: L, error: 'offline' })).toBe(DONE);
        let s = nextDraftRelease(pending, { type: 'ack', localId: L });
        expect(s).toEqual(cancelling(1));
        for (let n = 1; n < MAX_CANCEL_ATTEMPTS; n++) {
            s = nextDraftRelease(s, { type: 'cancel_failed', localId: L, error: 'cf' });
            expect(s).toMatchObject({ kind: 'failed', cancelFailed: true, cancelAttempts: n });
            expect(isRemovalPending(s)).toBe(false);
            s = nextDraftRelease(s, { type: 'ack', localId: L });
            expect(s).toMatchObject({ kind: 'cancelling', cancelAttempts: n + 1 });
        }
        s = nextDraftRelease(s, { type: 'cancel_failed', localId: L, error: 'cf' });
        expect(nextDraftRelease(s, { type: 'ack', localId: L })).toBe(s); // budget spent: parked for the human
        expect(nextDraftRelease(s, { type: 'user_cancel' })).toBe(DONE);
    });
    it('an edit reclaims the draft: the old identity is gone, so the old send\'s ack, failure and cancel answers no longer touch it', () => {
        const edited = nextDraftRelease(cancelling(), { type: 'user_edit' });
        expect(localIdOf(edited)).toBeNull();
        expect(nextDraftRelease(edited, { type: 'ack', localId: L })).toBe(edited);
        expect(nextDraftRelease(edited, { type: 'cancel_ok', localId: L })).toBe(edited);
        expect(nextDraftRelease(edited, { type: 'cancel_failed', localId: L, error: 'cf' })).toBe(edited);
    });
});

describe('the lane and the sweep\'s ladder', () => {
    const now = 100_000;
    it('busy clears the in-flight backstop and starts the settle window; a release arms the backstop', () => {
        const released = nextLane(IDLE_LANE, { type: 'released', now });
        expect(released.inFlightUntil).toBe(now + RELEASE_BACKSTOP_MS);
        const busy = nextLane(released, { type: 'busy', now: now + 1 });
        expect(busy).toEqual({ lastBusyAt: now + 1, inFlightUntil: null });
    });
    it('holds while busy, then for the settle window, then for the backstop — each capped by MAX_HOLD_MS', () => {
        const q = queuedDraft();
        expect(decideRelease({ draft: q, lane: IDLE_LANE, busy: true, age: 0, now, missing: 0 })).toBe('hold_busy');
        expect(decideRelease({ draft: q, lane: IDLE_LANE, busy: true, age: MAX_HOLD_MS, now, missing: 0 })).toBe('release');
        const lane = { lastBusyAt: now - RELEASE_SETTLE_MS + 1, inFlightUntil: null };
        expect(decideRelease({ draft: q, lane, busy: false, age: 0, now, missing: 0 })).toBe('hold_settle');
        expect(decideRelease({ draft: q, lane: { lastBusyAt: 0, inFlightUntil: now + 1 }, busy: false, age: 0, now, missing: 0 })).toBe('hold_in_flight');
    });
    it('the draft\'s own state decides the rest: a live lease waits, an expired one retries, cancelling and parked never resend, missing images never auto-send', () => {
        expect(decideRelease({ draft: releasing({ leaseUntil: now + 1 }), lane: IDLE_LANE, busy: false, age: 0, now, missing: 0 })).toBe('leased');
        expect(decideRelease({ draft: releasing({ leaseUntil: now }), lane: IDLE_LANE, busy: false, age: 0, now, missing: 0 })).toBe('release');
        expect(decideRelease({ draft: cancelling(), lane: IDLE_LANE, busy: false, age: 0, now, missing: 0 })).toBe('cancelling');
        expect(decideRelease({ draft: failed(), lane: IDLE_LANE, busy: false, age: 0, now, missing: 0 })).toBe('parked');
        expect(decideRelease({ draft: queuedDraft(), lane: IDLE_LANE, busy: false, age: 0, now, missing: 2 })).toBe('missing_attachments');
        expect(decideRelease({ draft: DONE, lane: IDLE_LANE, busy: false, age: 0, now, missing: 0 })).toBe('done');
    });
});
