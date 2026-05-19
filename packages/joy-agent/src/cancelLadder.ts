/**
 * Cancel ladder — comm-layer-spec §14.
 *
 * Three rungs with graced timeouts, plus stopTask for live background tasks
 * (§16). Caller passes a `Stopper` for the backend.
 */
import { CONSTANTS } from 'joy-daemon/src/protocol';

export interface Stopper {
    /** Graceful: backend control-channel interrupt. */
    interrupt(): Promise<void>;
    /** Hard: AbortController.abort on the current turn signal. */
    abort(): Promise<void>;
    /** Force: terminate the spawned child. After this, no further events. */
    close(): Promise<void>;
    /** Stop a live background task by id. */
    stopTask(taskId: string): Promise<void>;
    /** Returns true once the backend has acknowledged the turn fully stopped. */
    isStopped(): boolean;
}

export interface RunOpts {
    stopper: Stopper;
    /** Live background task ids belonging to the cancelled turn. */
    liveTaskIds: string[];
    /** Optional override for grace windows (testing). */
    graceInterruptMs?: number;
    graceAbortMs?: number;
}

export async function runLadder(opts: RunOpts): Promise<void> {
    const gi = opts.graceInterruptMs ?? CONSTANTS.GRACE_INTERRUPT_MS;
    const ga = opts.graceAbortMs ?? CONSTANTS.GRACE_ABORT_MS;
    // Stop live bg tasks in parallel with the ladder (§16).
    for (const id of opts.liveTaskIds) void opts.stopper.stopTask(id).catch(() => undefined);
    await opts.stopper.interrupt();
    if (await waitStopped(opts.stopper, gi)) return;
    await opts.stopper.abort();
    if (await waitStopped(opts.stopper, ga)) return;
    await opts.stopper.close();
}

async function waitStopped(s: Stopper, ms: number): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        if (s.isStopped()) return true;
        await new Promise((r) => setTimeout(r, 50));
    }
    return s.isStopped();
}
