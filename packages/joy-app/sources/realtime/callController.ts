// Which SDK instance owns which stage of the native voice call, and what a
// callback from a given instance means. Pure: no SDK, no store, no React.
//
// The native component is re-keyed (a fresh useConversation, a fresh LiveKit
// Room) after every disconnect, so more than one SDK instance can be alive in
// the same tick: the one an attempt started on, the one that replaced it, the
// one whose late onConnect fires after its attempt was already cancelled.
// Callbacks used to read one module-wide "pending attempt" and publish
// whatever they saw: an onConnect after endSession resurrected a connected
// status with no owner (#244); an unmount mid-connect cancelled the NEXT
// instance's attempt; a stale onDisconnect could tear down a newer live
// call. Every callback now names the instance it came from and is judged
// against the attempt or live call that instance owns.
import { ConnectAttempt } from './connectAttempt';

/** Identifies one mounted SDK instance. */
export type SdkId = number;

export type ConnectVerdict =
    /** The pending attempt's own room came up: publish connected. */
    | 'connected'
    /** The live call's instance reported connect again: nothing to do. */
    | 'duplicate'
    /** A room nobody is waiting for (attempt cancelled, timed out or on
     *  another instance): close that instance, publish nothing. */
    | 'orphan';

export type DisconnectVerdict =
    /** The pending attempt's room failed before it came up: the attempt is
     *  failed; its owner's catch path publishes the outcome (#339). */
    | 'attempt-failed'
    /** The live call dropped. */
    | 'live-dropped'
    /** An instance that owns nothing: ignore. */
    | 'stale';

export type ErrorVerdict = 'attempt-failed' | 'live-error' | 'stale';

export class CallController {
    private attempt: ConnectAttempt | null = null;
    private attemptOwner: SdkId | null = null;
    private liveOwner: SdkId | null = null;

    /** The attempt still in flight, if any. */
    get pending(): ConnectAttempt | null {
        return this.attempt?.pending ? this.attempt : null;
    }

    /** Instance the pending attempt started on; null when nothing is pending. */
    get pendingOwner(): SdkId | null {
        return this.attempt?.pending ? this.attemptOwner : null;
    }

    /** Instance carrying the live call; null when hung up. */
    get live(): SdkId | null {
        return this.liveOwner;
    }

    /** Is `owner` the instance of the pending attempt or the live call? */
    owns(owner: SdkId): boolean {
        return this.pendingOwner === owner || this.liveOwner === owner;
    }

    /** Start an attempt on `owner`. An attempt still pending elsewhere is
     *  cancelled; its own catch path closes its own instance. */
    begin(owner: SdkId, timeoutMs: number): ConnectAttempt {
        this.attempt?.cancel();
        const attempt = new ConnectAttempt(timeoutMs);
        this.attempt = attempt;
        this.attemptOwner = owner;
        return attempt;
    }

    /** endSession: abandon a pending attempt (#244) and forget the live call.
     *  Returns the instances that must be closed, pending first. */
    end(): SdkId[] {
        const owners: SdkId[] = [];
        if (this.pendingOwner !== null) owners.push(this.pendingOwner);
        if (this.liveOwner !== null && this.liveOwner !== owners[0]) owners.push(this.liveOwner);
        this.attempt?.cancel();
        this.liveOwner = null;
        return owners;
    }

    /** `owner` unmounted. Only ITS pending attempt is cancelled — a remount
     *  mid-connect must not cancel the attempt of the instance that replaced
     *  it. True when the instance owned something. */
    release(owner: SdkId): boolean {
        let owned = false;
        if (this.pendingOwner === owner) {
            this.attempt?.cancel();
            owned = true;
        }
        if (this.liveOwner === owner) {
            this.liveOwner = null;
            owned = true;
        }
        return owned;
    }

    onConnect(owner: SdkId): ConnectVerdict {
        if (this.pendingOwner === owner) {
            this.attempt!.connected();
            this.liveOwner = owner;
            return 'connected';
        }
        if (this.liveOwner === owner) return 'duplicate';
        return 'orphan';
    }

    onDisconnect(owner: SdkId, error: unknown): DisconnectVerdict {
        if (this.pendingOwner === owner) {
            this.attempt!.fail(error);
            return 'attempt-failed';
        }
        if (this.liveOwner === owner) {
            this.liveOwner = null;
            return 'live-dropped';
        }
        return 'stale';
    }

    onError(owner: SdkId, error: unknown): ErrorVerdict {
        if (this.pendingOwner === owner) {
            this.attempt!.fail(error);
            return 'attempt-failed';
        }
        if (this.liveOwner === owner) return 'live-error';
        return 'stale';
    }
}

/**
 * Run the SDK's startSession against an attempt. The SDK resolving does NOT
 * settle the attempt — the native SDK resolves once it has a token and has
 * asked LiveKit to connect, before the room is up; onConnect settles it.
 * Rejecting fails it. Both stages are bounded by the attempt's own deadline
 * and cancellation: `await sdk.startSession()` used to come BEFORE the gate,
 * so neither the timeout (#339) nor endSession (#244) could settle an attempt
 * whose SDK call was still pending. When the attempt settles first — cancel,
 * timeout, a callback — a late SDK result closes the instance it belongs to
 * instead of leaving a room half-open with no owner.
 */
export function raceStart(
    attempt: ConnectAttempt,
    start: () => Promise<unknown>,
    closeOwned: () => Promise<void>,
): Promise<void> {
    const abandoned = () => attempt.outcome !== null && attempt.outcome !== 'connected';
    let started: Promise<unknown>;
    try {
        started = start();
    } catch (error) {
        started = Promise.reject(error);
    }
    started.then(
        () => { if (abandoned()) void closeOwned(); },
        (error) => { if (!attempt.fail(error) && abandoned()) void closeOwned(); },
    );
    return attempt.promise;
}
