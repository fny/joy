// Terminal pane sizing: map the RENDERED pixel box of the pane view to the
// tmux window size we ask the daemon for.
//
// Two rules here are load-bearing, and both were learned from breakage:
//
//  1. An unmeasured layout must never drive a resize. React Native fires
//     onLayout with 0×0 before the view has been measured; the clamps below
//     would turn that into a real 20×10 resize that STICKS after this screen
//     closes, leaving the agent on a 20-column terminal. At that width claude's
//     TUI is mangled enough to blind the daemon's pane parser, which silently
//     breaks message dispatch — so a bad size costs far more than a bad view.
//
//  2. The window matches the viewport, and is NOT doubled. Doubling once bought
//     scrollback (claude runs on tmux's alternate screen, history_size=0, so a
//     taller window is the only way to see further back), but claude pins its
//     input box to the window's BOTTOM and the pane view auto-scrolls to the
//     end — so a doubled window opens on the input box with a screenful of dead
//     space above it and the conversation pushed off the fold.

/** Pane font metrics — must match styles.paneText in the pane screen. */
export const PANE_LINE_HEIGHT = 15; // styles.paneText.lineHeight
export const CHAR_WIDTH = 11 * 0.6; // fontSize (11) × mono advance ≈ 0.6em
export const PANE_H_PADDING = 16; // styles.paneScroll paddingHorizontal (8) × 2

/** Smallest window we will ever ask for. The floor exists so a sliver of a
 *  layout still yields a legible window rather than a 1-column one. */
export const MIN_COLS = 20;
export const MIN_ROWS = 10;

export interface PaneSize { cols: number; rows: number }

/**
 * The tmux window size for a rendered pane box, or null when the layout has
 * not been measured yet (see rule 1 above — null means "do not resize").
 */
export function paneSizeFor(widthPx: number, heightPx: number): PaneSize | null {
    if (!(widthPx > 0) || !(heightPx > 0)) return null;
    // floor (not round) of the padding-adjusted width, so a rendered line never
    // exceeds the content box — otherwise it wraps or scrolls sideways.
    const cols = Math.max(MIN_COLS, Math.floor((widthPx - PANE_H_PADDING) / CHAR_WIDTH));
    const rows = Math.max(MIN_ROWS, Math.round(heightPx / PANE_LINE_HEIGHT));
    return { cols, rows };
}

/** Whether a newly computed size differs from the last one we sent. Both axes
 *  count: rows track the viewport, so a height-only change (rotation, keyboard,
 *  split resize) must re-size the window too. */
export function paneSizeChanged(next: PaneSize, last: PaneSize | null): boolean {
    if (!last) return true;
    return next.cols !== last.cols || next.rows !== last.rows;
}
