/**
 * Whether the drawing pad may export right now (#161).
 *
 * Choosing a background image enabled Save immediately, but the surface
 * loads the image asynchronously and capture paints whatever has loaded so
 * far — pressing Save quickly on a large pasted screenshot deposited a
 * blank (or previous-background) PNG and left the screen. Save waits until
 * the surface reports the CURRENT background source loaded; a failed load
 * is surfaced by the screen and clears the background.
 *
 * Readiness is per LOAD ATTEMPT, not per URI string: every change of the
 * background source (a new image, removal, and re-selecting an image that
 * was removed) starts a fresh load on the surface and forgets the previous
 * readiness. Comparing URIs alone let "load A, remove it, choose A again"
 * export at once, while the surface had cleared its image and was loading A
 * a second time.
 */
export interface DrawingBackgroundState {
    /** The chosen source, or null for plain paper. */
    bgImage: string | null;
    /** The source the surface reported loaded for the CURRENT choice. */
    loadedBgImage: string | null;
}

export const NO_BACKGROUND: DrawingBackgroundState = { bgImage: null, loadedBgImage: null };

/** The user chose `uri` (null removes the background). Any change of source
 *  resets readiness; choosing the source already in place changes nothing —
 *  the surface would not reload it, so the readiness it reported stands. */
export function chooseBackground(state: DrawingBackgroundState, uri: string | null): DrawingBackgroundState {
    if (uri === state.bgImage) return state;
    return { bgImage: uri, loadedBgImage: null };
}

/** The surface finished loading `uri`. Only a report for the CURRENT choice
 *  counts; a failed load clears the choice so the screen can say so. */
export function reportBackgroundLoad(state: DrawingBackgroundState, uri: string, ok: boolean): DrawingBackgroundState {
    if (uri !== state.bgImage) return state;
    return ok ? { bgImage: uri, loadedBgImage: uri } : NO_BACKGROUND;
}

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
