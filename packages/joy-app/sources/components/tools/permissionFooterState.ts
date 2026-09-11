/**
 * The permission footer's submit state, as one value. Pure, import-free.
 *
 * The footer used to hold four booleans — a "loading button" plus one flag
 * each for all-edits, bypass and for-session — and every one of its eight
 * handlers re-checked all four plus the permission's status in a five-clause
 * guard. One submission at a time is the whole rule: it is either idle or
 * submitting exactly one answer, and nothing may be pressed until the
 * daemon has answered (#381: only an explicit ok is an answer — a 500 with
 * an empty body rejects, and the state goes back to idle with the
 * permission still pending, so the user can press again).
 */
export type AnswerKind = 'allow' | 'deny' | 'abort' | 'all_edits' | 'bypass' | 'for_session';

export type FooterState =
    | { kind: 'idle' }
    | { kind: 'submitting'; answer: AnswerKind };

export type FooterEvent =
    | { type: 'press'; answer: AnswerKind }
    /** The daemon answered — applied or refused; either way the press is over. */
    | { type: 'settled' };

export const IDLE: FooterState = { kind: 'idle' };

export function nextFooterState(s: FooterState, ev: FooterEvent): FooterState {
    switch (s.kind) {
        case 'idle':
            switch (ev.type) {
                case 'press': return { kind: 'submitting', answer: ev.answer };
                case 'settled': return s;
            }
            return unreachable(ev);
        case 'submitting':
            switch (ev.type) {
                case 'press': return s; // one answer at a time
                case 'settled': return IDLE;
            }
            return unreachable(ev);
    }
    return unreachable(s);
}

/** May an answer be pressed now? Idle, and the request still open. */
export function canAct(s: FooterState, permission: { status: string }): boolean {
    return s.kind === 'idle' && permission.status === 'pending';
}

/** Which answer is in flight, for the button that shows the spinner. */
export function submittingAnswer(s: FooterState): AnswerKind | null {
    return s.kind === 'submitting' ? s.answer : null;
}

function unreachable(x: never): never {
    throw new Error(`permissionFooter: unhandled ${JSON.stringify(x)}`);
}
