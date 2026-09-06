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
 * What a terminal send call came back with (#155). 'ok' only when the daemon
 * ACKNOWLEDGED the keys (2xx + `{ ok: true }`). 'failed' is definite — the
 * daemon refused BEFORE touching the pane (a 4xx: 400 empty script, 404 no
 * such session), so the text is safe to retype. Everything else is
 * 'unknown': a 5xx, a `{ ok: false }` (the daemon's sendRawKeys reports a
 * failed tmux segment AFTER earlier segments landed), a null body — some or
 * all of the keys may sit in the pane. The former "no `error` field means
 * success" check reported all of these as landed, and the first fix called
 * them all definite failures, which let a retry type the text twice.
 */
export type SendOutcome = 'ok' | 'failed' | 'unknown';
export type SendVerdict = { outcome: 'ok' } | { outcome: 'failed' | 'unknown'; message: string; timedOut?: boolean };

export function sendKeysOutcome(r: { status: number; data: { ok?: boolean; error?: string } | null }): SendVerdict {
    if (r.status >= 200 && r.status < 300 && r.data?.ok === true) return { outcome: 'ok' };
    const message = r.data?.error || `HTTP ${r.status}`;
    if (r.status >= 400 && r.status < 500) return { outcome: 'failed', message };
    return { outcome: 'unknown', message };
}

/**
 * What a REJECTED send promise means (#155 residual). Once the request has
 * been dispatched, a rejection says nothing about whether the keys landed:
 * a lost response, a cut stream, a relay 5xx or a network error can all
 * arrive after the daemon executed the script. Only a refusal the transport
 * can prove happened before execution — a 4xx TunnelError, i.e. the relay
 * refused admission (auth, unknown machine, over-size) and never forwarded
 * the request — is a definite failure. Everything else is 'unknown', so the
 * next submit clears the box before typing instead of appending to, or
 * duplicating, text that may already be there. (Duck-typed on the error's
 * name + status so this module stays free of the tunnel's native imports.)
 */
export function transportFailureOutcome(e: unknown): { outcome: 'failed' | 'unknown'; message: string } {
    const message = e instanceof Error ? e.message : String(e);
    const status = e instanceof Error && e.name === 'TunnelError' ? (e as { status?: unknown }).status : undefined;
    if (typeof status === 'number' && status >= 400 && status < 500) return { outcome: 'failed', message };
    return { outcome: 'unknown', message };
}

/**
 * One send-keys call classified into a SendVerdict (#155): 'ok' only on the
 * daemon's acknowledgement; a response or rejection that cannot prove the
 * keys never landed is 'unknown'; only a provable pre-execution refusal is
 * 'failed'. A request that never left — `send` throwing synchronously — is
 * definite too. A call still in flight after `timeoutMs` is 'unknown' with
 * `timedOut` set; the request keeps running on its own.
 */
export async function performSendKeys(
    send: () => Promise<{ status: number; data: { ok?: boolean; error?: string } | null }>,
    timeoutMs: number,
): Promise<SendVerdict> {
    let inFlight: ReturnType<typeof send>;
    try {
        inFlight = send();
    } catch (e) {
        return { outcome: 'failed', message: e instanceof Error ? e.message : String(e) };
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        const result = await Promise.race([
            inFlight,
            new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), timeoutMs); }),
        ]);
        if (result === 'timeout') return { outcome: 'unknown', message: 'timeout', timedOut: true };
        return sendKeysOutcome(result);
    } catch (e) {
        return transportFailureOutcome(e);
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
}

/**
 * What this screen believes the pane's input box holds because of a send it
 * made (#155). `certain` is false after an UNKNOWN outcome (a timeout, a
 * rejected transport promise, an unacknowledged answer): the keys may or
 * may not have landed, so the box may hold the text, part of it, or nothing.
 */
export type TypedPending = { text: string; certain: boolean } | null;

/**
 * The pending entry after any other script reached the pane (a quick key,
 * raw tokens, an Enter from the key bar) (#155): an acknowledged script
 * changes what the box holds, so stop assuming; an unknown one keeps the
 * entry but marks it uncertain; a definite refusal changed nothing.
 */
export function pendingAfterScript(outcome: SendOutcome, pending: TypedPending): TypedPending {
    if (outcome === 'ok') return null;
    if (outcome === 'unknown' && pending) return { text: pending.text, certain: false };
    return pending;
}

/**
 * Text-mode submit as ONE operation (#155): clear the box if the plan says
 * so, type the text, then a real Enter — three daemon calls whose outcomes
 * are tracked separately. An 'unknown' step keeps the text as an uncertain
 * pending entry (the next submit clears first, so a retry never types
 * `hellohello`); a definite refusal leaves the entry as it was; an
 * acknowledged Enter resolves it. `send` is the screen's classified sender.
 */
export async function submitTextOperation(
    script: string,
    pending: TypedPending,
    send: (script: string, literal: boolean) => Promise<SendOutcome>,
): Promise<{ submitted: boolean; pending: TypedPending }> {
    const { clearFirst, typeText } = planTextSubmit(script, pending);
    if (clearFirst) {
        const cleared = await send(clearPendingScript(pending?.text ?? script), false);
        if (cleared !== 'ok') {
            return { submitted: false, pending: cleared === 'unknown' ? { text: pending?.text ?? script, certain: false } : pending };
        }
        pending = null;
    }
    if (typeText) {
        const typed = await send(script, true);
        if (typed !== 'ok') {
            return { submitted: false, pending: typed === 'unknown' ? { text: script, certain: false } : pending };
        }
        pending = { text: script, certain: true };
    }
    const submitted = await send('<Enter>', false);
    if (submitted !== 'ok') {
        return { submitted: false, pending: submitted === 'unknown' ? { text: script, certain: false } : pending };
    }
    return { submitted: true, pending: null };
}

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
