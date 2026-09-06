/**
 * What the web visibility listener should do when the tab becomes visible.
 *
 * Decided from the preference CURRENT at that moment, never a startup
 * snapshot: the old listener closed over the boot-time preference and palette,
 * so after the user switched to fixed Light (or picked another palette) a
 * hidden→visible transition re-enabled adaptive themes, flipped to the OS
 * scheme and restored the startup palette (#420).
 *
 * Returns null when nothing must be resynchronized (a fixed preference is
 * the user's explicit choice — the OS scheme is irrelevant to it).
 */
export type ThemePreference = 'light' | 'dark' | 'adaptive';

export function planVisibilityResync(
    preference: ThemePreference,
    systemScheme: string | null | undefined, // Appearance.getColorScheme() may also be 'unspecified'
): { theme: 'light' | 'dark' } | null {
    if (preference !== 'adaptive') return null;
    return { theme: systemScheme === 'dark' ? 'dark' : 'light' };
}
