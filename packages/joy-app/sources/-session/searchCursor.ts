/**
 * Cursor reconciliation for the in-session search bar (#122).
 *
 * The bar navigates a list of matches that CHANGES under it: an optimistic
 * message whose send failed disappears, a new matching message arrives, an
 * older page loads in. Tracking the selection as a bare index meant the
 * counter read "3/2" after a match vanished and next/previous pointed at a
 * different message than the one on screen. The selection is therefore the
 * MESSAGE ID; this maps it back onto the current match list.
 */
export interface SearchCursor {
    /** Index into `matches`, always in range (0 when there are none). */
    index: number;
    /** The selected match's message id, or null when there are no matches. */
    messageId: string | null;
    /** True when the visible hit changed and the chat should scroll to it. */
    scroll: boolean;
}

export function reconcileSearchCursor(
    matches: ReadonlyArray<{ messageId: string }>,
    selectedId: string | null,
    previousIndex: number,
): SearchCursor {
    if (matches.length === 0) {
        return { index: 0, messageId: null, scroll: false };
    }
    if (selectedId !== null) {
        const at = matches.findIndex((m) => m.messageId === selectedId);
        // Still present: follow it wherever it moved — no scroll, it is the
        // same hit the user is looking at.
        if (at >= 0) return { index: at, messageId: selectedId, scroll: false };
    }
    // Gone (or nothing selected yet): fall back to the nearest position, and
    // bring that hit into view since it is a different message.
    const index = Math.min(Math.max(previousIndex, 0), matches.length - 1);
    return { index, messageId: matches[index].messageId, scroll: true };
}
