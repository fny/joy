/**
 * Accent overrides after "Copy selected → Custom".
 *
 * The Custom palette has no accents of its own, so the preset's accents are
 * persisted into the global overrides — but the user's saved overrides must
 * WIN, exactly as they did while the preset was displayed (applyAppearance
 * layers overrides over preset accents). The copy used to merge the preset
 * LAST, so a saved blue #123456 was replaced by the preset's blue (#251).
 */
export function mergeCopiedAccents(
    presetAccents: Record<string, string> | null | undefined,
    overrides: Record<string, string> | null | undefined,
): Record<string, string> | null {
    if (!presetAccents) return overrides ?? null;
    return { ...presetAccents, ...(overrides ?? {}) };
}
