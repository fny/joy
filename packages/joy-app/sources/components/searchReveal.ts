/**
 * In-session search (Cmd/Ctrl+F) reveal contract between ChatList and the
 * group rows (#203). Pure so the resolution is unit-testable.
 *
 * A search hit can sit inside a collapsed row, inside a collapsed NESTED tool
 * group of an agent-work-group row, and anywhere down a long expanded row.
 * ChatList hands the target down as a `reveal` prop; the group views open
 * whatever holds it and the rendered hit reports its layout relative to the
 * row's root view (RevealLayout). ChatList then scrolls to the hit's ACTUAL
 * position — scrolling to the group start alone need not bring a later hit of
 * a long group into the viewport.
 */
import type { DisplayItem, ToolDisplayItem } from '@/hooks/useGroupedMessages';

export interface RevealTarget {
    messageId: string;
    /** Distinguishes repeated searches for the same message, so each one
     *  re-measures and re-scrolls. */
    nonce: number;
}

/** A rendered hit's box, relative to the top of its FlashList row. */
export interface RevealLayout extends RevealTarget {
    y: number;
    height: number;
}

/** Fraction of the viewport above the revealed hit — comfortably below the
 *  header rather than flush against it. */
export const SEARCH_VIEW_POSITION = 0.3;

export function rowContainsMessage(row: DisplayItem, messageId: string): boolean {
    if (row.type === 'message') return row.message.id === messageId;
    return row.messages.some((m) => m.id === messageId);
}

/** Id of the nested tool group (inside an agent-work-group) holding the
 *  message, or null when it is a bare item or absent. */
export function nestedGroupContaining(items: ToolDisplayItem[], messageId: string): string | null {
    for (const item of items) {
        if (item.type === 'tool-group' && item.messages.some((m) => m.id === messageId)) return item.id;
    }
    return null;
}

export interface RevealScroll {
    index: number;
    viewPosition: number;
    viewOffset?: number;
}

/**
 * FlashList.scrollToIndex params that bring the hit into view. Resolves the
 * row index from the CURRENT items (data may have shifted since the search
 * started). With the hit's measured layout, the offset lands the hit itself
 * at SEARCH_VIEW_POSITION of the window; without one (row not mounted yet,
 * or a bare message row) it falls back to positioning the row.
 */
export function resolveRevealScroll(
    items: DisplayItem[],
    messageId: string,
    hit: { y: number; height: number } | null,
    windowHeight: number,
): RevealScroll | null {
    const index = items.findIndex((i) => rowContainsMessage(i, messageId));
    if (index < 0) return null;
    if (!hit) return { index, viewPosition: SEARCH_VIEW_POSITION };
    const room = Math.max(0, windowHeight - hit.height);
    return { index, viewPosition: 0, viewOffset: hit.y - room * SEARCH_VIEW_POSITION };
}
