/**
 * How tall the composer's text area should be (#648).
 *
 * It used to have no explicit height at all, relying on iOS sizing a
 * `multiline` TextInput to its content under a `maxHeight` cap. That grows
 * fine and does not reliably shrink: clearing the field through `value` — the
 * only mutation path Fabric honours — leaves the last measured intrinsic
 * height in place. Send a twelve-line message and the empty box stays at the
 * 120pt cap, with `minHeight: 40` setting a floor that nothing ever pulls it
 * back down to.
 *
 * So the height becomes state, driven by the measurements the platform
 * reports, and this decides what to do with them.
 */

export interface ComposerHeightInput {
    /** Content height last reported by onContentSizeChange, if any. */
    measured: number | null;
    /** Is the field empty? Empty always collapses, whatever was measured. */
    isEmpty: boolean;
    /** One line of text, including the field's vertical padding. */
    minHeight: number;
    /** The cap; content beyond this scrolls inside the field. */
    maxHeight: number;
}

/**
 * Empty collapses to one line unconditionally — that is the whole fix, and it
 * must not depend on a measurement arriving, because the stale measurement IS
 * the bug. Otherwise clamp what was measured into [min, max].
 */
export function composerHeight({ measured, isEmpty, minHeight, maxHeight }: ComposerHeightInput): number {
    const floor = Math.max(1, minHeight);
    const ceiling = Math.max(floor, maxHeight);
    if (isEmpty) return floor;
    if (measured == null || !Number.isFinite(measured)) return floor;
    return Math.min(ceiling, Math.max(floor, Math.ceil(measured)));
}

/**
 * Should a newly measured height replace the one in state?
 *
 * iOS reports content size on nearly every keystroke, often with sub-pixel
 * jitter that changes nothing visible. Committing each one re-renders the
 * component on the typing path for no reason, so ignore movement below a
 * pixel — but never ignore a change that crosses the floor, or a collapse
 * back to it would be the thing that gets dropped.
 */
export function shouldCommitHeight(prev: number | null, next: number, minHeight: number): boolean {
    if (prev == null) return true;
    if (next <= minHeight && prev > minHeight) return true;
    return Math.abs(next - prev) >= 1;
}
