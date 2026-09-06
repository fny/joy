/**
 * What the Remote Log Server prompt's result means for the saved URL.
 *
 * Modal.prompt resolves `null` when the dialog is CANCELLED and '' when the
 * user submits an erased field. The handler used to test only for
 * `undefined`, so a cancel read as an explicit clear: it deleted the saved
 * URL and announced "Remote logging disabled" (#138). Only a submitted empty
 * string disables remote logging now.
 */
export type LogServerPromptOutcome =
    | { kind: 'cancelled' }
    | { kind: 'unchanged' }
    | { kind: 'disable' }
    | { kind: 'set'; url: string };

export function logServerPromptOutcome(result: string | null | undefined, currentUrl: string): LogServerPromptOutcome {
    if (result === null || result === undefined) return { kind: 'cancelled' };
    if (result === currentUrl) return { kind: 'unchanged' };
    if (result.trim() === '') return { kind: 'disable' };
    return { kind: 'set', url: result };
}
