/**
 * Keyboard-event predicates for the command palette, kept free of React so
 * they can be unit-tested.
 */

export const PALETTE_NAVIGATION_KEYS = ['ArrowDown', 'ArrowUp', 'Enter', 'Escape'] as const;

interface KeyEventLike {
    key?: string;
    /** True while an IME composition (Japanese/Chinese/Korean input) is open. */
    isComposing?: boolean;
    /** Legacy IME marker: browsers report keyCode 229 for keys consumed by the IME. */
    keyCode?: number;
}

/**
 * Enter/arrows pressed to CONFIRM an IME composition belong to the IME, not
 * to the palette: React Native Web fires onKeyPress before its own
 * composition guard, so without this check confirming a Japanese word ran the
 * selected command (#204).
 */
export function isComposingKeyEvent(e: KeyEventLike | null | undefined): boolean {
    if (!e) return false;
    return e.isComposing === true || e.keyCode === 229;
}

/** The palette handles `key` itself (and swallows it) only when it is a
 *  navigation/execution key AND no IME composition is in progress. */
export function shouldHandlePaletteKey(e: KeyEventLike | null | undefined): boolean {
    if (!e || typeof e.key !== 'string') return false;
    if (isComposingKeyEvent(e)) return false;
    return (PALETTE_NAVIGATION_KEYS as readonly string[]).includes(e.key);
}

/**
 * Keep the keyboard cursor on a real row after the result list changes
 * (#208): commands removed under a stale index left Enter doing nothing.
 * An empty list parks the cursor at 0 so it is valid again when rows return.
 */
export function clampSelectedIndex(selectedIndex: number, resultCount: number): number {
    if (resultCount <= 0) return 0;
    return Math.min(Math.max(0, selectedIndex), resultCount - 1);
}
