/**
 * How a limit prompt's answer maps to the stored limit (#176):
 *   null   → cancelled, keep the current value
 *   ''     → the user cleared the field and confirmed: disable the limit
 *   digits → the new positive limit
 *   other  → ignored (keep the current value)
 * The native iOS prompt used to collapse a confirmed empty field into null, so
 * "erase and press OK" could never turn a limit off; the prompt now resolves
 * '' for that case and, belt and braces, every limit row also has an explicit
 * clear button.
 */
export function limitFromPromptValue(value: string | null): { change: false } | { change: true; limit: number | null } {
    if (value === null) return { change: false };
    const trimmed = value.trim();
    if (trimmed === '') return { change: true, limit: null };
    if (!/^\d+$/.test(trimmed)) return { change: false };
    const parsed = parseInt(trimmed, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return { change: false };
    return { change: true, limit: parsed };
}
