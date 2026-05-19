/**
 * Anchor-then-emit suppress mode — comm-layer-spec §18.
 *
 * On daemon-supervised respawn the agent rebuilds backend-internal memory via
 * SDK `resume` / ACP `session/load`. Every message the backend re-emits as
 * part of that replay MUST be DROPPED at the agent emitter so it is never
 * re-appended to the durable log. Concrete rule: stay in `suppress` mode and
 * drop messages until we observe the configured anchor `messageId`; then
 * flip to `emit` mode.
 *
 * If there is no anchor (cold start), we start in `emit` mode.
 *
 * Anchor matching: by messageId. The backend adapter passes each candidate
 * messageId through `observe(messageId)` BEFORE emitting; if it matches the
 * anchor, the next call returns true and the mode flips.
 */

export class SuppressMode {
    private mode: 'suppress' | 'emit';
    private readonly anchor: string | null;

    constructor(anchor: string | null) {
        this.anchor = anchor;
        this.mode = anchor ? 'suppress' : 'emit';
    }

    /** Pass each candidate messageId BEFORE emitting. */
    shouldEmit(messageId: string | null): boolean {
        if (this.mode === 'emit') return true;
        if (!this.anchor) {
            this.mode = 'emit';
            return true;
        }
        if (messageId && messageId === this.anchor) {
            // The anchor itself is the LAST already-logged message; we still
            // suppress IT (already logged), then flip to emit for everything
            // after.
            this.mode = 'emit';
            return false;
        }
        return false;
    }

    inSuppress(): boolean {
        return this.mode === 'suppress';
    }
}
