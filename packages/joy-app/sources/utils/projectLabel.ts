import { formatPathRelativeToHome } from './pathUtils';

/**
 * The project as a pinned row shows it — the whole path, with the home
 * directory folded to `~`.
 *
 * The rest of the list shows only the last segment, which is enough when the
 * row sits under a machine section that already said where it is. A pin has no
 * such context: it is at the top of the list, above everything, and `joy` on
 * its own does not say which checkout. So pins carry the full path, and the
 * row ellipsizes from the FRONT — the tail is the part that identifies it.
 */
export function projectLabel(path: string | null | undefined, homeDir: string | null | undefined): string | null {
    if (!path) return null;
    return formatPathRelativeToHome(path, homeDir ?? undefined);
}
