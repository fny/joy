// One connection attempt that settles exactly once.
//
// The native ElevenLabs SDK's startSession resolves as soon as it has a token
// and has told LiveKit to connect — BEFORE the room is up. A LiveKit failure
// after that point surfaced only as onError/onDisconnect on a call the
// orchestrator believed had started, so the retry loop stopped after one
// attempt (#339). Wrapping the attempt in this gate keeps startSession
// pending until onConnect (success), a pre-connect onError/onDisconnect
// (failure), an endSession while pending (cancel, #244) or a timeout. Every
// later signal is ignored: an attempt settles once.

export class ConnectAttemptCancelled extends Error {
    constructor() {
        super('voice connect attempt cancelled');
        this.name = 'ConnectAttemptCancelled';
    }
}

export class ConnectAttemptTimeout extends Error {
    constructor(ms: number) {
        super(`voice connect attempt timed out after ${ms}ms`);
        this.name = 'ConnectAttemptTimeout';
    }
}

export type ConnectAttemptOutcome = 'connected' | 'failed' | 'cancelled' | 'timeout';

export class ConnectAttempt {
    readonly promise: Promise<void>;
    private outcomeValue: ConnectAttemptOutcome | null = null;
    private resolveFn!: () => void;
    private rejectFn!: (error: unknown) => void;
    private timer: ReturnType<typeof setTimeout> | null = null;

    constructor(timeoutMs: number) {
        this.promise = new Promise<void>((resolve, reject) => {
            this.resolveFn = resolve;
            this.rejectFn = reject;
        });
        // A rejection nobody awaits yet must not be "unhandled": the SDK can
        // fail before the caller reaches `await attempt.promise`.
        this.promise.catch(() => {});
        if (timeoutMs > 0) {
            this.timer = setTimeout(() => this.settle('timeout', new ConnectAttemptTimeout(timeoutMs)), timeoutMs);
        }
    }

    /** null while pending. */
    get outcome(): ConnectAttemptOutcome | null {
        return this.outcomeValue;
    }

    get pending(): boolean {
        return this.outcomeValue === null;
    }

    /** onConnect. True if this call settled the attempt. */
    connected(): boolean {
        return this.settle('connected');
    }

    /** A pre-connect onError / onDisconnect. True if this call settled it. */
    fail(error: unknown): boolean {
        return this.settle('failed', error instanceof Error ? error : new Error(String(error)));
    }

    /** endSession or unmount while still pending. True if this call settled it. */
    cancel(): boolean {
        return this.settle('cancelled', new ConnectAttemptCancelled());
    }

    private settle(outcome: ConnectAttemptOutcome, error?: unknown): boolean {
        if (this.outcomeValue !== null) return false;
        this.outcomeValue = outcome;
        if (this.timer) { clearTimeout(this.timer); this.timer = null; }
        if (outcome === 'connected') this.resolveFn();
        else this.rejectFn(error);
        return true;
    }
}
