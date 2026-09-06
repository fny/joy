/**
 * The sync engine boots ONCE per process. This gate owns that fact — success
 * and failure alike — for both entry points (syncCreate on login, syncRestore
 * on boot), so nobody else has to guess:
 *
 *  - a boot that threw used to leave a bare `isInitialized = true` behind, so
 *    the next login "succeeded" without any engine underneath it (#88, #190);
 *  - AuthContext kept its own failure latch, but only for the login path —
 *    a failed RESTORE never set it, and the next login sailed through;
 *  - a native logout whose reload was refused (dev builds) left the previous
 *    account's engine bound, and login(B) returned early against it (#189).
 *
 * A failed or stopped engine cannot be re-created in this process — the
 * singleton's constructor-time wiring (AppState listeners, queue release
 * valves) is not re-entrant — so after a failure or a logout-without-reload
 * every further init is REFUSED with SyncInitUnavailableError, which the UI
 * turns into "reload the app". That is a visible, honest dead end instead of
 * a silent half-login.
 */
export type SyncInitStatus = 'idle' | 'starting' | 'ready' | 'failed' | 'stopped';

export class SyncInitUnavailableError extends Error {
    constructor(readonly status: 'failed' | 'stopped') {
        super(status === 'failed'
            ? 'The sync engine failed to start earlier in this process; reload the app before signing in again.'
            : 'The sync engine was shut down by a logout; reload the app before signing in again.');
        this.name = 'SyncInitUnavailableError';
    }
}

export class SyncInitGate {
    private state: SyncInitStatus = 'idle';

    get status(): SyncInitStatus {
        return this.state;
    }

    /** True when a login attempt cannot boot an engine without a reload. */
    get reloadRequired(): boolean {
        return this.state === 'failed' || this.state === 'stopped';
    }

    /**
     * Run `init` exactly once. Resolves 'skipped' when an engine is already
     * up (or starting); throws SyncInitUnavailableError when an earlier init
     * failed or the engine was stopped; rethrows `init`'s own error after
     * recording the failure.
     */
    async run(init: () => Promise<void>): Promise<'ran' | 'skipped'> {
        if (this.state === 'failed' || this.state === 'stopped') {
            throw new SyncInitUnavailableError(this.state);
        }
        if (this.state !== 'idle') {
            return 'skipped';
        }
        this.state = 'starting';
        try {
            await init();
        } catch (e) {
            this.state = 'failed';
            throw e;
        }
        this.state = 'ready';
        return 'ran';
    }

    /** The account was torn down (logout) and no reload followed. */
    markStopped(): void {
        this.state = 'stopped';
    }
}
