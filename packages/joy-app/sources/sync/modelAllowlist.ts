/**
 * Which models a picker shows for a harness (Settings → Models).
 *
 * Live catalogs are big — an opencode install lists a few hundred models,
 * pi a few dozen — and a picker that cycles through all of them on tap is
 * unusable. The daemon marks a handful of each catalog `recommended`; the
 * user may then trim or extend that set per harness, and the choice is
 * stored in synced settings as `harnessModels[harness]` (model keys).
 *
 * Rules, in order:
 *  - no stored list → the recommended subset; a catalog with nothing marked
 *    recommended is shown whole (the user has to see SOMETHING to pick from);
 *  - a stored list → exactly those keys, in catalog order;
 *  - a stored list that matches nothing (the catalog changed under it) →
 *    the recommended subset again, never an empty picker;
 *  - the catalog's default entry and `keep` (the model a session is on now)
 *    are always present, so the current value can be displayed and re-picked.
 */
export interface AllowlistModel {
    key: string;
    recommended?: boolean;
    isDefault?: boolean;
}

export function enabledModels<T extends AllowlistModel>(
    catalog: readonly T[],
    allowlist: readonly string[] | undefined,
    keep?: string | null,
): T[] {
    const recommended = catalog.filter((m) => m.recommended === true);
    const base = recommended.length > 0 ? recommended : [...catalog];
    let chosen: T[];
    if (!allowlist) {
        chosen = base;
    } else {
        const set = new Set(allowlist);
        chosen = catalog.filter((m) => set.has(m.key));
        if (chosen.length === 0) chosen = base;
    }
    const keys = new Set(chosen.map((m) => m.key));
    const extras = catalog.filter((m) => !keys.has(m.key) && (m.isDefault === true || (keep != null && m.key === keep)));
    if (extras.length === 0) return chosen;
    // Catalog order, so the picker cycles the way the catalog lists.
    const all = new Set([...keys, ...extras.map((m) => m.key)]);
    return catalog.filter((m) => all.has(m.key));
}

/** The keys a "recommended only" reset stores: nothing — absent means recommended. */
export function isRecommendedOnly(allowlist: readonly string[] | undefined): boolean {
    return allowlist === undefined;
}
