/**
 * Context window sizes, for the "% left" segment under the composer.
 *
 * This used to be a single hardcoded `MAX_CONTEXT_SIZE = 190000` applied to
 * EVERY model (#646). Sessions here routinely run well past that — the
 * daemon's own comments reference a 600k-context turn — so any model with a
 * larger window pinned the display at "0% left" permanently, including right
 * after its context had been reset. A percentage against the wrong denominator
 * is not a rounding error; it is an invented number, and it read as broken
 * because it was.
 *
 * Only families whose window is actually KNOWN belong in the map. An absent
 * entry means unknown, and unknown must show the raw token count rather than a
 * percentage. Putting a guess in here recreates the original bug exactly.
 */
export const CONTEXT_WINDOWS: Record<string, number> = {};

/** The window for the model actually producing output, or null when unknown. */
export function contextWindowFor(modelCode: string | null | undefined): number | null {
    if (!modelCode) return null;
    // Resolve by FAMILY (`claude-opus-5` → `opus`), so a version bump does not
    // silently drop back to "unknown" the way a full-id key would.
    const family = /^claude-([a-z]+)/.exec(modelCode)?.[1] ?? modelCode;
    return CONTEXT_WINDOWS[family] ?? null;
}

/** `312k`, `1.3M` — compact enough for the status line. */
export function formatTokens(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
    return String(n);
}
