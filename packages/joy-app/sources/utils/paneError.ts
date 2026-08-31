// How the terminal view should present a failed pane read.
//
// The view used to render EVERY failure the same way: keep the (empty) pane and
// show "⚠ <error> — retrying…". That is right for a blip — a timeout, a daemon
// restart mid-poll — because the 1.5s poll really will recover. It is wrong,
// and actively misleading, when the daemon has told us the session does not
// exist: nothing is going to change, and the user is left staring at a blank
// terminal reading "retrying…" forever, with no idea the session is gone.
//
// So: classify. Transient failures keep the old banner. Terminal ones replace
// the empty pane with a plain statement of what happened.

export type PaneFailureKind = 'transient' | 'gone';

export interface PaneFailure {
    kind: PaneFailureKind;
    /** Sentence shown to the user. Says what happened, not what threw. */
    message: string;
}

/** Daemon error codes that mean "this session is not on the machine". Matched
 *  as substrings: they arrive bare from ops and wrapped from the HTTP layer. */
const GONE_CODES = ['session_not_found', 'no such session', 'not_found'];

/** The machine-plane context is missing entirely — the app cannot address this
 *  machine at all (no per-machine key, or no v2 link on the session). */
const NO_MACHINE = ['machine encryption not found', 'no machinectx'];

export function describePaneError(raw: string | null | undefined): PaneFailure | null {
    if (!raw) return null;
    const s = String(raw).toLowerCase();

    if (NO_MACHINE.some(c => s.includes(c))) {
        return {
            kind: 'gone',
            message: 'This machine is not available to your account on this relay, so its terminal cannot be read.',
        };
    }
    if (GONE_CODES.some(c => s.includes(c))) {
        return {
            kind: 'gone',
            message: 'This session is no longer running on the machine. It ended, or the daemon was restarted and did not reattach it.',
        };
    }
    return { kind: 'transient', message: `${raw} — retrying…` };
}
