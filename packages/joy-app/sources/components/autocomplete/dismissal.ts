/**
 * Escape with suggestions open DISMISSES the current autocomplete query: the
 * word stays in the text, but no suggestions are requested for it until the
 * text or the caret changes (#195). The dismissal's identity is the whole
 * text plus the caret — NOT the active-word string: with "/co /co" dismissed
 * at caret 3, a caret landing at 7 is a different word with the same string
 * and must reopen, and an edit anywhere else in the text (a different text)
 * re-arms it too.
 */
export interface AutocompleteDismissal {
    text: string;
    caret: number;
}

export function dismissalAt(text: string, selection: { start: number; end: number }): AutocompleteDismissal {
    return { text, caret: selection.start };
}

/** True while the input is still exactly where it was when dismissed. */
export function isDismissalActive(
    dismissal: AutocompleteDismissal | null,
    text: string,
    selection: { start: number; end: number },
): boolean {
    return dismissal !== null
        && dismissal.text === text
        && selection.start === selection.end
        && selection.start === dismissal.caret;
}
