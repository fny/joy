/**
 * Whether the chat list should follow new content to the bottom right now.
 *
 * FlashList's own `autoscrollToBottomThreshold` used to do this. Two things
 * made it yank a reader back down: its band was a fraction of the viewport
 * (20% — 120px or more on a phone), far wider than the 48px this list
 * already calls "live"; and it ran on every data change with no idea whether
 * a finger was on the screen or a fling was still moving, so during a stream
 * — a data change several times a second — scrolling up from the bottom was
 * answered by an animated scroll straight back. "Sometimes when I scroll up
 * the text jumps back to the bottom."
 *
 * So following is decided here, from what the list actually knows: the last
 * real scroll event's distance from the bottom, and whether the user is
 * mid-gesture. Pure so the four inputs can be checked exhaustively.
 */
export interface FollowInput {
    /** onLoad has fired: the list has laid out its first window. Before
     *  that, FlashList's startRenderingFromBottom owns the position. */
    loaded: boolean;
    /** A saved reading position is being restored; a follow would undo it. */
    restoring: boolean;
    /** Within the live band at the last scroll event. */
    nearBottom: boolean;
    /** Finger down, or momentum still running. Following would fight it. */
    interacting: boolean;
}

export function shouldFollowBottom(input: FollowInput): boolean {
    if (!input.loaded || input.restoring) return false;
    if (input.interacting) return false;
    return input.nearBottom;
}
