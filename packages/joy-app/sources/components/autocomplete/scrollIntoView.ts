/**
 * The scroll offset that brings a fixed-height row into a viewport, or null
 * when it is already fully visible. Shared by the web (DOM scrollTop) and the
 * native (ScrollView.scrollTo) branches of the autocomplete dropdown: native
 * used to fall into the DOM branch because getScrollableNode returns a truthy
 * numeric handle there, read undefined scrollTop/clientHeight, and never
 * scrolled the selected suggestion into view (#194).
 */
export function scrollOffsetToReveal(
    itemTop: number,
    itemHeight: number,
    visibleTop: number,
    viewportHeight: number,
): number | null {
    if (viewportHeight <= 0) return null;
    const itemBottom = itemTop + itemHeight;
    const visibleBottom = visibleTop + viewportHeight;
    if (itemTop < visibleTop) return itemTop;
    if (itemBottom > visibleBottom) return itemBottom - viewportHeight;
    return null;
}
