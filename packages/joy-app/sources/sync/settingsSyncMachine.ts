/**
 * Account settings sync as an explicit machine. Pure: no imports but a type.
 *
 * The engine (sync.ts) pulls the relay's sealed blob on a slow timer and on
 * foreground, replays this device's unpushed deltas on top, and pushes. That
 * loop used to keep its state in one field (`pendingSettings`) and clear it
 * after the push — which dropped any change made WHILE the push was in
 * flight: the toggle stayed device-local until the next unrelated change
 * (the "pins don't sync" family). Here every phase is a state and a change
 * during a push lands in `dirtiedDuringPush`, which becomes the next
 * `dirty` the moment the push settles.
 *
 * The 409 path is explicit too: the first conflict retries once against the
 * winner's version (`pushing.retried`); a second loss parks the deltas in
 * `conflicted`, which the next tick pushes again — it used to throw, and
 * the throw's backoff was the only thing that retried it.
 *
 * `failed` carries a bounded backoff; the engine arms a timer for `retryAt`
 * and sends `tick` when it fires.
 */
import type { Settings } from './settings';

export type Pending = Partial<Settings>;

/** What a change made during a push means for the next dirty state: a
 *  delta merges over the deltas being pushed; a replace supersedes them
 *  (the raw editor drops keys, and a stale delta must not put one back). */
export type Dirtied = { pending: Pending; replace: boolean };

export type SettingsSyncState =
    | { kind: 'clean' }
    | { kind: 'dirty'; pending: Pending }
    | { kind: 'pushing'; pending: Pending; dirtiedDuringPush: Dirtied | null; retried: boolean }
    | { kind: 'conflicted'; pending: Pending; winnerVersion: number }
    | { kind: 'failed'; pending: Pending; attempt: number; retryAt: number };

export type SettingsSyncEvent =
    | { type: 'local_change'; delta: Pending }
    | { type: 'local_replace'; settings: Pending }
    /** The pull landed and was absorbed; a sync run is under way. */
    | { type: 'pull_ok'; version: number; now: number }
    | { type: 'push_ok'; version: number }
    | { type: 'push_conflict'; winnerVersion: number }
    | { type: 'push_failed'; now: number }
    /** The retry timer fired (or any other reason to reconsider). */
    | { type: 'tick'; now: number };

export const FAILED_BACKOFF_BASE_MS = 1_000;
export const FAILED_BACKOFF_MAX_MS = 60_000;

export function failedBackoffMs(attempt: number): number {
    return Math.min(FAILED_BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1), FAILED_BACKOFF_MAX_MS);
}

const isEmpty = (p: Pending) => Object.keys(p).length === 0;

/** The deltas a push that settles now must still carry. */
function carried(pending: Pending, dirtied: Dirtied | null): Pending {
    if (!dirtied) return pending;
    return dirtied.replace ? dirtied.pending : { ...pending, ...dirtied.pending };
}

function dirtyOrClean(pending: Pending): SettingsSyncState {
    return isEmpty(pending) ? { kind: 'clean' } : { kind: 'dirty', pending };
}

/** The state to boot from: the persisted pending deltas, or nothing. */
export function initialSettingsSync(pending: Pending): SettingsSyncState {
    return dirtyOrClean(pending);
}

/** What must be persisted so a restart pushes what this process would have:
 *  every delta not yet confirmed by the relay. */
export function pendingOf(s: SettingsSyncState): Pending {
    switch (s.kind) {
        case 'clean': return {};
        case 'dirty': return s.pending;
        case 'pushing': return carried(s.pending, s.dirtiedDuringPush);
        case 'conflicted': return s.pending;
        case 'failed': return s.pending;
    }
}

export function nextSettingsSync(s: SettingsSyncState, ev: SettingsSyncEvent): SettingsSyncState {
    switch (s.kind) {
        case 'clean':
            switch (ev.type) {
                case 'local_change': return dirtyOrClean(ev.delta);
                case 'local_replace': return { kind: 'dirty', pending: ev.settings };
                case 'pull_ok': return s;
                case 'push_ok': return s;
                case 'push_conflict': return s;
                case 'push_failed': return s;
                case 'tick': return s;
            }
            return unreachable(ev);
        case 'dirty':
            switch (ev.type) {
                case 'local_change': return { kind: 'dirty', pending: { ...s.pending, ...ev.delta } };
                case 'local_replace': return { kind: 'dirty', pending: ev.settings };
                // The pull is in; the engine now replays `pending` on top and pushes.
                case 'pull_ok': return { kind: 'pushing', pending: s.pending, dirtiedDuringPush: null, retried: false };
                case 'push_ok': return s;      // no push was ours to settle
                case 'push_conflict': return s;
                case 'push_failed': return s;
                case 'tick': return s;
            }
            return unreachable(ev);
        case 'pushing':
            switch (ev.type) {
                case 'local_change': {
                    const d = s.dirtiedDuringPush;
                    const dirtied: Dirtied = d
                        ? { pending: { ...d.pending, ...ev.delta }, replace: d.replace }
                        : { pending: ev.delta, replace: false };
                    return { ...s, dirtiedDuringPush: dirtied };
                }
                case 'local_replace': return { ...s, dirtiedDuringPush: { pending: ev.settings, replace: true } };
                case 'pull_ok': return s;      // a run is already pushing (the engine serialises runs)
                // The relay holds what we pushed; whatever changed meanwhile
                // is the next dirty state — never dropped (the lost update).
                case 'push_ok': return dirtyOrClean(s.dirtiedDuringPush ? s.dirtiedDuringPush.pending : {});
                case 'push_conflict': {
                    const pending = carried(s.pending, s.dirtiedDuringPush);
                    if (!s.retried) return { kind: 'pushing', pending, dirtiedDuringPush: null, retried: true };
                    return { kind: 'conflicted', pending, winnerVersion: ev.winnerVersion };
                }
                case 'push_failed': {
                    const pending = carried(s.pending, s.dirtiedDuringPush);
                    return { kind: 'failed', pending, attempt: 1, retryAt: ev.now + failedBackoffMs(1) };
                }
                case 'tick': return s;
            }
            return unreachable(ev);
        case 'conflicted':
            switch (ev.type) {
                case 'local_change': return { ...s, pending: { ...s.pending, ...ev.delta } };
                case 'local_replace': return { ...s, pending: ev.settings };
                // The next run: pull (the winner, or newer), replay, push again.
                case 'pull_ok': return { kind: 'pushing', pending: s.pending, dirtiedDuringPush: null, retried: false };
                case 'push_ok': return s;
                case 'push_conflict': return s;
                case 'push_failed': return s;
                case 'tick': return s;
            }
            return unreachable(ev);
        case 'failed':
            switch (ev.type) {
                case 'local_change': return { ...s, pending: { ...s.pending, ...ev.delta } };
                case 'local_replace': return { ...s, pending: ev.settings };
                case 'pull_ok':
                    if (ev.now < s.retryAt) return s; // still backing off: the run pulls, does not push
                    return { kind: 'pushing', pending: s.pending, dirtiedDuringPush: null, retried: false };
                case 'push_ok': return s;
                case 'push_conflict': return s;
                case 'push_failed':
                    return { ...s, attempt: s.attempt + 1, retryAt: ev.now + failedBackoffMs(s.attempt + 1) };
                // Backoff over: eligible again; the engine invalidates its sync.
                case 'tick': return ev.now >= s.retryAt ? { kind: 'dirty', pending: s.pending } : s;
            }
            return unreachable(ev);
    }
    // Every (state, event) pair is handled above; this is the compiler's exhaustiveness proof.
    return unreachable(s);
}

function unreachable(x: never): never {
    throw new Error(`settingsSync: unhandled ${JSON.stringify(x)}`);
}
