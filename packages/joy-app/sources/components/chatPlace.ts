/**
 * Place-keeping for the chat: keep the row the reader is looking at where it
 * is on screen while the content around it changes. Pure and import-free;
 * ChatList supplies the list geometry and applies the deltas.
 *
 * FlashList used to do this itself (maintainVisibleContentPosition), alone:
 * it could not be told a jump was in progress, on web it corrected from a
 * stale recorded offset, and while correcting it hid the reader's scrolling
 * from the app for 100ms. Now the library only renders and measures
 * (patches/flash-list-app-owned-correction.cjs), and this decides.
 *
 * The anchor is a row and its layout y (list coordinates) at the last sync.
 * After every layout commit the same row's y is read again; whatever it moved
 * by is exactly how far the content around the reader shifted, so the
 * viewport shifts by the same amount. Deltas are y-to-y, never computed from
 * a scroll offset — the native offset the app knows can be a frame stale,
 * and a shift already issued may not have landed yet.
 *
 * A jump (prompt stepper, search hit, restoring a reading position) is the
 * same mechanism: scroll near the target once, then anchor on the TARGET, so
 * every commit that measures the rows around it (estimates → real heights)
 * refines toward keeping it where it was put. There is no fallback to the
 * bottom anywhere: a target that disappears ends the jump in place.
 */

export interface RowLayout {
    /** Top of the row in list coordinates (FlashList's getLayout: excludes
     *  the list header). */
    y: number;
    height: number;
}

export interface PlaceAnchor {
    /** Display row id (FlashList key). */
    key: string;
    /** A message inside the row: finds it again after regrouping replaced
     *  the row (a work group folding, a tool run growing into a group). */
    messageId: string | null;
    /** The row's y when last synced. */
    y: number;
}

/** What the place-keeper needs to know about the list right now. */
export interface PlaceList {
    count: number;
    indexOfKey(key: string): number;
    indexOfMessage(messageId: string): number;
    keyAt(index: number): string | undefined;
    messageIdAt(index: number): string | null;
    layout(index: number): RowLayout | undefined;
}

/**
 * The row at list-coordinate `y` (the viewport's top: offset minus the
 * header), by binary search over the rows' tops. Computed from the FRESH
 * offset: FlashList's own first-visible index follows its recorded offset,
 * which lags a scroll in progress — anchoring on a row below the real top
 * pushed the visible rows up whenever the ones revealed above it were
 * measured.
 */
export function rowAt(y: number, list: PlaceList): number {
    let lo = 0;
    let hi = list.count - 1;
    let found = -1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const l = list.layout(mid);
        if (!l) return found;
        if (l.y <= y) { found = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return found === -1 && list.count > 0 ? 0 : found;
}

export function anchorAt(index: number, list: PlaceList): PlaceAnchor | null {
    const key = list.keyAt(index);
    const layout = list.layout(index);
    if (key === undefined || !layout) return null;
    return { key, messageId: list.messageIdAt(index), y: layout.y };
}

/**
 * After a commit: how far the anchor row moved, and the anchor re-synced.
 * A row replaced by regrouping is followed through its message; its new
 * row's top takes the old row's place. A row that is gone for good ends the
 * anchor (null) with no shift — the viewport stays where it is.
 */
export function reanchor(anchor: PlaceAnchor, list: PlaceList): { anchor: PlaceAnchor | null; delta: number } {
    let index = list.indexOfKey(anchor.key);
    if (index < 0 && anchor.messageId) index = list.indexOfMessage(anchor.messageId);
    if (index < 0) return { anchor: null, delta: 0 };
    const next = anchorAt(index, list);
    if (!next) return { anchor, delta: 0 };
    return { anchor: { ...next, messageId: anchor.messageId ?? next.messageId }, delta: next.y - anchor.y };
}

/** Deltas below this are layout noise (sub-pixel rounding), not movement. */
export const SHIFT_EPSILON = 0.5;

/**
 * Where on screen a row's top goes for FlashList-style scrollToIndex params:
 * `viewPosition` 0 = top, 1 = bottom of the window; `viewOffset` scrolls that
 * much further down (so the row sits that much higher).
 */
export function rowTopFor(viewPosition: number, viewOffset: number, windowHeight: number, rowHeight: number): number {
    return viewPosition * Math.max(0, windowHeight - rowHeight) - viewOffset;
}

/** The scroll offset that puts a row's top at `top` px from the viewport top. */
export function offsetForRowTop(firstItemOffset: number, rowY: number, top: number): number {
    return Math.max(0, firstItemOffset + rowY - top);
}

/**
 * Where a restored row's top goes, given the saved offset `intra` into it
 * (positive: the row began above the viewport top; negative: part of the
 * header above it was visible). Until the row is measured its real height is
 * unknown, so it is first brought to the top of the view, where it renders
 * and measures — jumping straight to `estimatedY + intra` can skip past a
 * row the render window then never reaches. Once measured, the offset is
 * clamped to the row: a group that folded while away is shorter than the
 * saved offset into it, and the restore must not land past its end.
 */
export function restoreTopFor(intra: number): (rowHeight: number, measured: boolean) => number {
    return (rowHeight, measured) => {
        if (intra <= 0) return -intra;
        if (!measured) return 0;
        return -Math.min(intra, Math.max(0, rowHeight - 1));
    };
}
