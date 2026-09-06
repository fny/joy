/**
 * Geometry for the web session-actions menu, kept pure so it can be tested.
 *
 * The menu used to be positioned as if the whole action list always fit: in
 * a short window (a 320px-high browser, a split-screen tablet) the top was
 * clamped to the margin and the last rows — Archive, Delete — sat below the
 * viewport with no scroll container to reach them (#237). The menu now gets a
 * height budget (viewport minus margins) and its owner renders the rows in a
 * ScrollView bounded by `maxHeight`.
 */

export type MenuAnchor =
    | { type: 'point'; x: number; y: number }
    | { type: 'rect'; x: number; y: number; width: number; height: number };

export interface MenuLayoutInput {
    anchor: MenuAnchor;
    itemCount: number;
    itemHeight: number;
    menuWidth: number;
    margin: number;
    windowWidth: number;
    windowHeight: number;
}

export interface MenuLayout {
    left: number;
    top: number;
    /** Height the menu may occupy; rows beyond it scroll. */
    maxHeight: number;
}

export function computeMenuLayout(input: MenuLayoutInput): MenuLayout {
    const { anchor, itemCount, itemHeight, menuWidth, margin, windowWidth, windowHeight } = input;
    const available = Math.max(itemHeight, windowHeight - 2 * margin);
    const naturalHeight = itemCount * itemHeight;
    const height = Math.min(naturalHeight, available);

    const leftBase = anchor.type === 'point'
        ? anchor.x
        : anchor.x + anchor.width - menuWidth;

    let topBase = anchor.type === 'point'
        ? anchor.y
        : anchor.y + anchor.height + 8;

    // Below the anchor row does not fit: flip above it, if that fits better.
    if (anchor.type === 'rect' && topBase + height > windowHeight - margin) {
        const above = anchor.y - height - 8;
        if (above >= margin) topBase = above;
    }

    return {
        left: Math.max(margin, Math.min(windowWidth - menuWidth - margin, leftBase)),
        top: Math.max(margin, Math.min(windowHeight - height - margin, topBase)),
        maxHeight: available,
    };
}

/** Height budget for the native bottom sheet: everything below the status
 *  bar / notch, minus a breathing margin, so long menus scroll instead of
 *  pushing rows off the top (#237). */
export function computeSheetMaxHeight(windowHeight: number, safeAreaTop: number, margin: number): number {
    return Math.max(0, windowHeight - safeAreaTop - margin);
}
