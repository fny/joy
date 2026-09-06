/**
 * Wheel deltas in PIXELS regardless of the event's deltaMode. Line-mode wheels
 * (deltaMode 1, common on Windows/Linux mice) report a delta of ~3 LINES and
 * page-mode wheels (deltaMode 2) report pages; treating those as pixels made
 * Shift+wheel move a wide code block three pixels per notch (#223).
 */
export const WHEEL_DELTA_PIXEL = 0;
export const WHEEL_DELTA_LINE = 1;
export const WHEEL_DELTA_PAGE = 2;

export function normalizeWheelDelta(
    deltaX: number,
    deltaY: number,
    deltaMode: number,
    lineSizePx: number,
    pageSizePx: number,
): { deltaX: number; deltaY: number } {
    const factor = deltaMode === WHEEL_DELTA_LINE ? lineSizePx
        : deltaMode === WHEEL_DELTA_PAGE ? pageSizePx
        : 1;
    return { deltaX: deltaX * factor, deltaY: deltaY * factor };
}
