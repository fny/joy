/**
 * The composer's settings panel: which level it shows, and what the root
 * rows say.
 *
 * The panel used to render all three lists at once — permission mode full
 * width, model and effort side by side — inside a card pinned above the
 * composer (`bottom: 100%`, so it grows UPWARD). At four models that
 * already overflowed its 400pt cap and clipped, with the scroll indicator
 * turned off, so it read as though the list ended. At ten it would be half
 * a screen of scrolling, and the capability work means a harness can now
 * offer 20 models or no permission modes at all.
 *
 * So the panel shows ONE list at a time: a root of current values, and a
 * drill-in per setting. The card's height then follows one short list
 * rather than the sum of three, a long list scrolls inside it instead of
 * pushing its ceiling toward the status bar, and every harness renders in
 * the same frame regardless of how much it offers.
 *
 * Pure: the level rules are decided here so they can be checked without a
 * renderer.
 */
import type { ModeOption } from './modelModeOptions';

export type SettingsSectionLevel = 'permission' | 'model' | 'effort';
export type SettingsLevel = 'root' | SettingsSectionLevel;

export interface SettingsSection {
    level: SettingsSectionLevel;
    /** Row label on the root ("Model"). */
    label: string;
    /** Header of the section's own list — the harness's wording ("MODEL"). */
    title: string;
    options: ModeOption[];
    /** Key of the option in force, if the app knows it. */
    selectedKey: string | null;
}

/** A section with nothing to choose from is not a row: a harness with no
 *  permission surface (opencode, pi, agy before the capability work) would
 *  otherwise offer an empty list to drill into. */
export function visibleSections(sections: SettingsSection[]): SettingsSection[] {
    return sections.filter((s) => s.options.length > 0);
}

/** What the root row shows on its right: the selected option's name, or its
 *  raw key when the key is one this app build has no name for (a daemon
 *  ahead of the app), or null when nothing is selected. */
export function selectedName(section: SettingsSection): string | null {
    if (!section.selectedKey) return null;
    const hit = section.options.find((o) => o.key === section.selectedKey);
    return hit ? hit.name : section.selectedKey;
}

/**
 * Where the panel opens. With one section there is no choice to present, so
 * a root listing exactly one row — which every tap would then have to pass
 * through — is a tap tax; open that list directly.
 */
export function initialLevel(sections: SettingsSection[]): SettingsLevel {
    const visible = visibleSections(sections);
    return visible.length === 1 ? visible[0].level : 'root';
}

/** Is there a root to go back to? False when a single section IS the panel. */
export function canGoBack(sections: SettingsSection[], level: SettingsLevel): boolean {
    if (level === 'root') return false;
    return visibleSections(sections).length > 1;
}

/**
 * Where a selection leaves you. Returning to the root is what makes changing
 * model and effort together one visit rather than two — but a panel that has
 * no root has nowhere to return to, so it closes, as the old one did.
 */
export function levelAfterSelect(sections: SettingsSection[], level: SettingsLevel): SettingsLevel | 'close' {
    return canGoBack(sections, level) ? 'root' : 'close';
}
