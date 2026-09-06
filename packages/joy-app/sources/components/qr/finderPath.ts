/**
 * Geometry of one QR finder (locator) pattern: a 7x7 square ring, a 5x5 hole,
 * a 3x3 centre — all SQUARE.
 *
 * Two decoding bugs lived in the old finders (#272, #273):
 *  - the rings were drawn with rounded corners; OpenCV detected the code but
 *    could not decode it at 200px or 400px, and squaring only the finders
 *    restored decoding — the 1:1:3:1:1 ratio scan expects square geometry;
 *  - on web the hole was painted as a `backgroundColor` rectangle over the
 *    ring, so a transparent background produced a SOLID square (paint cannot
 *    erase). The hole is now cut out of a single even-odd path.
 */
export type Square = { x: number; y: number; size: number };

export function finderSquares(x: number, y: number, moduleSize: number): [outer: Square, hole: Square, centre: Square] {
    return [
        { x, y, size: 7 * moduleSize },
        { x: x + moduleSize, y: y + moduleSize, size: 5 * moduleSize },
        { x: x + 2 * moduleSize, y: y + 2 * moduleSize, size: 3 * moduleSize },
    ];
}

/** SVG path for the finder, to be filled with fill-rule "evenodd". */
export function finderPath(x: number, y: number, moduleSize: number): string {
    return finderSquares(x, y, moduleSize)
        .map((s) => `M ${s.x} ${s.y} h ${s.size} v ${s.size} h ${-s.size} Z`)
        .join(' ');
}
