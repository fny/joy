/**
 * On iOS/Android a return key the onKeyPress handler consumed (autocomplete
 * applied a suggestion) still inserts a newline natively — preventDefault is a
 * no-op there — and the following onChangeText overwrote the applied
 * suggestion (#27). MultiTextInput records the text and caret as they were at
 * that key press; the ONE native change that is exactly that text with the
 * newline inserted at that caret is swallowed, whenever it arrives. Identity is
 * the key press and its selection, not elapsed time: a change delivered late
 * (busy JS render) is still the consumed newline, and a change with the newline
 * anywhere else is the user's own edit.
 */
export interface PendingNewlineSwallow {
    /** Text as it was when the handled return key was pressed. */
    base: string;
    /** Caret (or selected range) at that key press — where native inserts "\n". */
    selection: { start: number; end: number };
}

/**
 * True when `text` is `pending.base` with the selection recorded at the key
 * press replaced by exactly one "\n".
 */
export function isNewlineInsertedAtSelection(pending: PendingNewlineSwallow, text: string): boolean {
    const { base, selection } = pending;
    const lo = Math.min(selection.start, selection.end);
    const hi = Math.max(selection.start, selection.end);
    const start = Math.max(0, Math.min(lo, base.length));
    const end = Math.max(start, Math.min(hi, base.length));
    if (text.length !== base.length - (end - start) + 1) return false;
    return text === base.slice(0, start) + '\n' + base.slice(end);
}
