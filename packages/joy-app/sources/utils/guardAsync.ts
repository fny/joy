/**
 * One place for "this async work runs from a void callback": a press handler,
 * an effect, a timer, a modal button. A promise dropped on the floor there
 * rejects unhandled — the spinner clears, nothing is shown, and the global
 * handler logs a stack nobody reads. `guarded` turns a maybe-async function
 * into a void-returning one whose failure (sync throw or rejection) always
 * reaches a reporter; `alertError` is the reporter for user-facing work,
 * `logError` for best-effort work (haptics, prefetch) nobody needs to see fail.
 */
import { Modal } from '@/modal';
import { t } from '@/text';
import { log } from '@/log';

export type ErrorReporter = (error: unknown) => void;

export function isThenable(value: unknown): value is PromiseLike<unknown> {
    if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return false;
    return typeof (value as { then?: unknown }).then === 'function';
}

/** A short human-readable line for any thrown value. */
export function errorMessage(error: unknown): string {
    if (error instanceof Error) return error.message || error.name;
    if (typeof error === 'string') return error;
    if (error && typeof error === 'object') {
        const m = (error as { message?: unknown }).message;
        if (typeof m === 'string' && m) return m;
        try { return JSON.stringify(error); } catch { /* fall through */ }
    }
    return String(error);
}

/** Reporter for best-effort work: the app log + console, no UI. */
export const logError: ErrorReporter = (error) => {
    console.warn('[guarded] async failure:', error);
    log.log(`[guarded] ${errorMessage(error)}`);
};

/**
 * Reporter that shows the failure in an alert. `message` replaces the raw
 * error text (use a t() string when the error itself is not user language).
 */
export function alertError(message?: string, title?: string): ErrorReporter {
    return (error) => {
        logError(error);
        Modal.alert(title ?? t('common.error'), message ?? errorMessage(error));
    };
}

function report(onError: ErrorReporter, error: unknown): void {
    try {
        onError(error);
    } catch (reporterFailure) {
        console.error('[guarded] error reporter threw:', reporterFailure, 'while reporting:', error);
    }
}

/**
 * Attach a rejection handler to a promise you are not going to await. Returns
 * nothing, so the statement is visibly handled rather than floating.
 */
export function handle(promise: PromiseLike<unknown> | unknown, onError: ErrorReporter = logError): void {
    // Assimilation happens INSIDE the guarded boundary: a value whose `then`
    // getter throws used to escape from isThenable before any reporter ran
    // (Astra on d53685b4).
    let thenable: boolean;
    try {
        thenable = isThenable(promise);
        if (!thenable) return;
        Promise.resolve(promise).then(undefined, (e) => report(onError, e));
    } catch (e) {
        report(onError, e);
    }
}

/**
 * Wrap `fn` (sync or async) into a void-returning handler. A synchronous
 * throw and a rejected promise both go to `onError`; nothing escapes.
 */
export function guarded<A extends unknown[]>(
    fn: (...args: A) => unknown,
    onError: ErrorReporter = logError,
): (...args: A) => void {
    return (...args: A) => {
        let result: unknown;
        try {
            result = fn(...args);
        } catch (e) {
            report(onError, e);
            return;
        }
        handle(result, onError);
    };
}
