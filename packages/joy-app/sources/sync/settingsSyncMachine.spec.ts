import { describe, it, expect } from 'vitest';
import {
    nextSettingsSync, initialSettingsSync, pendingOf, failedBackoffMs, FAILED_BACKOFF_MAX_MS,
    type SettingsSyncState, type SettingsSyncEvent, type Pending,
} from './settingsSyncMachine';

type Kind = SettingsSyncState['kind'];
type Type = SettingsSyncEvent['type'];

const P: Pending = { viewInline: true };
const Q: Pending = { expandTodos: true };

const STATES: Record<Kind, SettingsSyncState> = {
    clean: { kind: 'clean' },
    dirty: { kind: 'dirty', pending: P },
    pushing: { kind: 'pushing', pending: P, dirtiedDuringPush: null, retried: false },
    conflicted: { kind: 'conflicted', pending: P, winnerVersion: 7 },
    failed: { kind: 'failed', pending: P, attempt: 1, retryAt: 1_000 },
};
const EVENTS: Record<Type, SettingsSyncEvent> = {
    local_change: { type: 'local_change', delta: Q },
    local_replace: { type: 'local_replace', settings: Q },
    pull_ok: { type: 'pull_ok', version: 3, now: 5_000 },  // past failed.retryAt
    push_ok: { type: 'push_ok', version: 4 },
    push_conflict: { type: 'push_conflict', winnerVersion: 9 },
    push_failed: { type: 'push_failed', now: 5_000 },
    tick: { type: 'tick', now: 5_000 },
};

/** state × event → resulting kind. A pair missing here fails the test. */
const EXPECTED: Record<`${Kind}+${Type}`, Kind> = {
    'clean+local_change': 'dirty', 'clean+local_replace': 'dirty', 'clean+pull_ok': 'clean', 'clean+push_ok': 'clean',
    'clean+push_conflict': 'clean', 'clean+push_failed': 'clean', 'clean+tick': 'clean',
    'dirty+local_change': 'dirty', 'dirty+local_replace': 'dirty', 'dirty+pull_ok': 'pushing', 'dirty+push_ok': 'dirty',
    'dirty+push_conflict': 'dirty', 'dirty+push_failed': 'dirty', 'dirty+tick': 'dirty',
    'pushing+local_change': 'pushing', 'pushing+local_replace': 'pushing', 'pushing+pull_ok': 'pushing', 'pushing+push_ok': 'clean',
    'pushing+push_conflict': 'pushing', 'pushing+push_failed': 'failed', 'pushing+tick': 'pushing',
    'conflicted+local_change': 'conflicted', 'conflicted+local_replace': 'conflicted', 'conflicted+pull_ok': 'pushing',
    'conflicted+push_ok': 'conflicted', 'conflicted+push_conflict': 'conflicted', 'conflicted+push_failed': 'conflicted', 'conflicted+tick': 'conflicted',
    'failed+local_change': 'failed', 'failed+local_replace': 'failed', 'failed+pull_ok': 'pushing', 'failed+push_ok': 'failed',
    'failed+push_conflict': 'failed', 'failed+push_failed': 'failed', 'failed+tick': 'dirty',
};

describe('settingsSyncMachine: the transition table is total', () => {
    for (const [kind, s] of Object.entries(STATES) as [Kind, SettingsSyncState][]) {
        for (const [type, ev] of Object.entries(EVENTS) as [Type, SettingsSyncEvent][]) {
            it(`${kind} + ${type} → ${EXPECTED[`${kind}+${type}`] ?? 'MISSING'}`, () => {
                const want = EXPECTED[`${kind}+${type}`];
                expect(want, `no expectation for ${kind}+${type}`).toBeDefined();
                expect(nextSettingsSync(s, ev).kind).toBe(want);
            });
        }
    }
});

describe('settingsSyncMachine: the lost update', () => {
    it('a change made while a push is in flight becomes the next dirty state — never dropped', () => {
        let s = initialSettingsSync(P);
        s = nextSettingsSync(s, EVENTS.pull_ok);           // pushing P
        s = nextSettingsSync(s, { type: 'local_change', delta: Q }); // the user toggles mid-push
        expect(pendingOf(s)).toEqual({ ...P, ...Q });       // a crash here still pushes both
        s = nextSettingsSync(s, EVENTS.push_ok);
        expect(s).toEqual({ kind: 'dirty', pending: Q });   // Q waits for the next run
        s = nextSettingsSync(s, EVENTS.pull_ok);
        expect(s.kind).toBe('pushing');
        s = nextSettingsSync(s, EVENTS.push_ok);
        expect(s.kind).toBe('clean');
    });
    it('a wholesale replace during a push supersedes the deltas being pushed (a removed key must not come back)', () => {
        let s = nextSettingsSync(initialSettingsSync(P), EVENTS.pull_ok);
        s = nextSettingsSync(s, { type: 'local_replace', settings: Q });
        expect(pendingOf(s)).toEqual(Q);
        s = nextSettingsSync(s, EVENTS.push_ok);
        expect(s).toEqual({ kind: 'dirty', pending: Q });
    });
    it('a delta after a replace during the same push merges over the replace', () => {
        let s = nextSettingsSync(initialSettingsSync(P), EVENTS.pull_ok);
        s = nextSettingsSync(s, { type: 'local_replace', settings: Q });
        s = nextSettingsSync(s, { type: 'local_change', delta: { viewInline: false } });
        s = nextSettingsSync(s, EVENTS.push_ok);
        expect(s).toEqual({ kind: 'dirty', pending: { ...Q, viewInline: false } });
    });
});

describe('settingsSyncMachine: conflicts', () => {
    it('the first 409 retries at once; the second parks the deltas until the next run', () => {
        let s = nextSettingsSync(initialSettingsSync(P), EVENTS.pull_ok);
        s = nextSettingsSync(s, EVENTS.push_conflict);
        expect(s).toMatchObject({ kind: 'pushing', retried: true, pending: P });
        s = nextSettingsSync(s, EVENTS.push_conflict);
        expect(s).toEqual({ kind: 'conflicted', pending: P, winnerVersion: 9 });
        s = nextSettingsSync(s, EVENTS.pull_ok);
        expect(s).toMatchObject({ kind: 'pushing', retried: false, pending: P });
    });
    it('a change during the conflicted push rides the retry', () => {
        let s = nextSettingsSync(initialSettingsSync(P), EVENTS.pull_ok);
        s = nextSettingsSync(s, { type: 'local_change', delta: Q });
        s = nextSettingsSync(s, EVENTS.push_conflict);
        expect(s).toMatchObject({ kind: 'pushing', retried: true, pending: { ...P, ...Q }, dirtiedDuringPush: null });
    });
});

describe('settingsSyncMachine: failure backoff', () => {
    it('backs off exponentially to a cap and pushes again only once the backoff is over', () => {
        expect(failedBackoffMs(1)).toBe(1_000);
        expect(failedBackoffMs(4)).toBe(8_000);
        expect(failedBackoffMs(20)).toBe(FAILED_BACKOFF_MAX_MS);
        let s = nextSettingsSync(initialSettingsSync(P), { type: 'pull_ok', version: 1, now: 0 });
        s = nextSettingsSync(s, { type: 'push_failed', now: 0 });
        expect(s).toEqual({ kind: 'failed', pending: P, attempt: 1, retryAt: 1_000 });
        expect(nextSettingsSync(s, { type: 'pull_ok', version: 1, now: 500 }).kind).toBe('failed');   // still backing off
        expect(nextSettingsSync(s, { type: 'tick', now: 500 }).kind).toBe('failed');
        expect(nextSettingsSync(s, { type: 'tick', now: 1_000 })).toEqual({ kind: 'dirty', pending: P });
        s = nextSettingsSync(s, { type: 'push_failed', now: 1_000 });
        expect(s).toMatchObject({ kind: 'failed', attempt: 2, retryAt: 3_000 });
    });
    it('deltas made while failed are kept', () => {
        const s = nextSettingsSync(STATES.failed, { type: 'local_change', delta: Q });
        expect(pendingOf(s)).toEqual({ ...P, ...Q });
    });
});

describe('settingsSyncMachine: boot', () => {
    it('boots clean with nothing pending and dirty with the persisted deltas', () => {
        expect(initialSettingsSync({})).toEqual({ kind: 'clean' });
        expect(initialSettingsSync(P)).toEqual({ kind: 'dirty', pending: P });
        expect(nextSettingsSync(STATES.clean, { type: 'local_change', delta: {} })).toEqual({ kind: 'clean' });
    });
});
