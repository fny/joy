/**
 * Pure helpers for the terminal screen's send path (#155, #156).
 */
import type { PaneSize } from '@/utils/paneSize';

/**
 * What the input box should hold after a send FAILED (#155). The submitted
 * text used to be cleared the moment the operation took the guard, and a
 * failure (no machine context, key request refused, daemon timeout) left an
 * alert and an empty box — the only copy of the text was gone. Put it back,
 * but never over something newer the user has typed since.
 */
export function restoreFailedInput(current: string, submitted: string): string {
    return current.trim().length ? current : submitted;
}

/**
 * Text mode types the message, then sends a real Enter — two daemon calls.
 * If the text landed and only the Enter failed, the text already sits in the
 * pane's input box; re-submitting the same text would type it TWICE (#155).
 * `typedPending` is the text known to be sitting there unsubmitted.
 */
export function planTextSubmit(input: string, typedPending: string | null): { typeText: boolean } {
    return { typeText: typedPending === null || typedPending !== input };
}

/**
 * Whether a measured viewport still needs to reach the daemon (#156). The
 * size the daemon last ACKNOWLEDGED is tracked separately from the size we
 * measured: a resize that never got a context, or failed in a blip, used to
 * be recorded as sent and was never retried until the layout changed again.
 */
export function resizePending(measured: PaneSize | null, acked: PaneSize | null): boolean {
    if (!measured) return false;
    if (!acked) return true;
    return measured.cols !== acked.cols || measured.rows !== acked.rows;
}
