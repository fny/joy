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
 * What a terminal send call came back with (#155). The daemon answers a
 * landed key script with 2xx + `{ ok: true }`; anything else — a 5xx, an
 * `{ ok: false }` with no error text, a null body — is a FAILURE, and the
 * former "no `error` field means success" check reported it as landed. A
 * definite failure keeps the text retryable; only a timeout is ambiguous
 * (see `SendOutcome`).
 */
export type SendOutcome = 'ok' | 'failed' | 'unknown';

export function sendKeysOutcome(r: { status: number; data: { ok?: boolean; error?: string } | null }): { outcome: 'ok' } | { outcome: 'failed'; message: string } {
    if (r.status >= 200 && r.status < 300 && r.data?.ok === true) return { outcome: 'ok' };
    return { outcome: 'failed', message: r.data?.error || `HTTP ${r.status}` };
}

/**
 * What this screen believes the pane's input box holds because of a send it
 * made (#155). `certain` is false after a TIMEOUT: the keys may or may not
 * have landed, so the box may hold the text, part of it, or nothing.
 */
export type TypedPending = { text: string; certain: boolean } | null;

/**
 * Text mode types the message, then sends a real Enter — two daemon calls.
 * If the text landed and only the Enter failed, the text already sits in the
 * pane's input box; re-submitting the same text would type it TWICE, and
 * re-submitting EDITED text would append it to the old text (#155).
 * `clearFirst` empties the box before typing; `typeText` is false only when
 * the exact text is known to be sitting there already (Enter alone).
 */
export function planTextSubmit(input: string, typedPending: TypedPending): { clearFirst: boolean; typeText: boolean } {
    if (typedPending === null) return { clearFirst: false, typeText: true };
    if (typedPending.certain && typedPending.text === input) return { clearFirst: false, typeText: false };
    return { clearFirst: true, typeText: true };
}

/**
 * Key script that empties the pane's input box of `pending` (#155). C-u,
 * not C-c: C-c reaches claude as SIGINT when the tty is damaged and can
 * kill it (docs/pane-input-clearing.md); C-u kills one line per press, two
 * presses cover a wrapped line, and extra presses on an empty box are
 * harmless — so send two per line, and a floor of two.
 */
export function clearPendingScript(pending: string): string {
    const lines = pending.split('\n').length;
    return '<C-u>'.repeat(Math.min(12, Math.max(2, lines * 2)));
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
