/**
 * Whether the drawing pad may export right now (#161).
 *
 * Choosing a background image enabled Save immediately, but the surface
 * loads the image asynchronously and capture paints whatever has loaded so
 * far — pressing Save quickly on a large pasted screenshot deposited a
 * blank (or previous-background) PNG and left the screen. Save waits until
 * the surface reports the CURRENT background source loaded; a failed load
 * is surfaced by the screen and clears the background.
 */
export function canSaveDrawing(input: {
    strokeCount: number;
    bgImage: string | null;
    /** The background source the surface last reported as fully loaded. */
    loadedBgImage: string | null;
    saving: boolean;
}): boolean {
    if (input.saving) return false;
    if (input.bgImage) return input.loadedBgImage === input.bgImage;
    return input.strokeCount > 0;
}
