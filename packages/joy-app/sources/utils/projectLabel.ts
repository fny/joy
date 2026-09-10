/**
 * The project as a pinned row shows it: the last segment of the path.
 *
 * It leads the row and it never shrinks — the title after it does. Between
 * the two, the project is the one you scan for, so it is the one that must
 * survive a narrow sidebar intact.
 */
export function projectLabel(path: string | null | undefined): string | null {
    if (!path) return null;
    return path.split(/[/\\]/).filter(Boolean).pop() ?? null;
}
