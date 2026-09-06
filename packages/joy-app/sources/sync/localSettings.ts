import * as z from 'zod';
import { recoverFields } from '@/utils/isolateBad';

//
// Schema
//

export const LocalSettingsSchema = z.object({
    // Developer settings (device-specific)
    debugMode: z.boolean().describe('Enable debug logging'),
    devModeEnabled: z.boolean().describe('Enable developer menu in settings'),
    commandPaletteEnabled: z.boolean().describe('Enable CMD+K command palette (web only)'),
    themePreference: z.enum(['light', 'dark', 'adaptive']).describe('Theme preference: light, dark, or adaptive (follows system)'),
    themePalette: z.string().describe('Selected color palette id ("default" = original theme, "custom" = user-entered)'),
    themePaletteDark: z.string().describe('Selected dark palette id ("default" = stock dark theme); presets only'),
    customPalette: z.record(z.string(), z.string()).nullable().describe('User-defined palette colors (keyed by palette field)'),
    accentOverrides: z.record(z.string(), z.string()).nullable().describe('User overrides for named accent tints (keyed by accent name)'),
    fontOverride: z.string().nullable().describe('Override for the default UI font family (null = IBM Plex Sans)'),
    terminalTheme: z.string().describe('Selected terminal colour theme id (pane + bash output)'),
    markdownCopyV2: z.boolean().describe('Replace native paragraph selection with long-press modal for full markdown copy'),
    consoleLoggingEnabled: z.boolean().describe('Enable console output in production builds'),
    verboseLogging: z.boolean().describe('Log all network requests and responses'),
    zenMode: z.boolean().describe('Hide all sidebars and non-essential UI for focused work'),
    limitSessionMemory: z.number().nullable().describe('Max sessions to keep in memory (most-recently-viewed; unload the rest, reloaded on revisit). null/empty = keep all'),
    fileViewerFontSize: z.number().describe('Code/file viewer font size in px'),
    fileViewerWrap: z.boolean().describe('Code/file viewer word wrap (off = horizontal scroll)'),
    chatFontScale: z.number().describe('Chat message text scale multiplier (1 = 100%), clamped to [0.8, 1.4]'),
    // CLI version acknowledgments - keyed by machineId
    acknowledgedCliVersions: z.record(z.string(), z.string()).describe('Acknowledged CLI versions per machine'),
    appLock: z.boolean().describe('Require Face ID / device PIN to open the app (native only; device-local)'),
    // .catch: a value retired from this enum (the old 'hashicon') is coerced
    // rather than treated as invalid, so the preference survives an upgrade.
    avatarVariant: z.enum(['circles', 'squares']).catch('circles').describe('Identicon style: circular (default) or square confetti grid'),
    sessionAvatarSize: z.number().describe('Session-list identicon size in px, clamped to [8, 24]'),
});

//
// NOTE: Local settings are device-specific and should NOT be synced.
// These are preferences that make sense to be different on each device.
//

export type LocalSettings = z.infer<typeof LocalSettingsSchema>;

//
// Defaults
//

export const localSettingsDefaults: LocalSettings = {
    debugMode: false,
    devModeEnabled: false,
    commandPaletteEnabled: false,
    themePreference: 'adaptive',
    themePalette: 'default',
    themePaletteDark: 'default',
    customPalette: null,
    accentOverrides: null,
    fontOverride: null,
    limitSessionMemory: 5,
    fileViewerFontSize: 14,
    fileViewerWrap: true,
    chatFontScale: 1,
    terminalTheme: 'default',
    markdownCopyV2: false,
    consoleLoggingEnabled: false,
    verboseLogging: false,
    zenMode: false,
    acknowledgedCliVersions: {},
    appLock: false,
    avatarVariant: 'circles',
    sessionAvatarSize: 16,
};
Object.freeze(localSettingsDefaults);

//
// Parsing
//

export function localSettingsParse(settings: unknown): LocalSettings {
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
        return { ...localSettingsDefaults };
    }
    const input = settings as Record<string, unknown>;

    // Fields are validated INDEPENDENTLY: one malformed value (e.g.
    // limitSessionMemory:'5') used to fail the whole-object parse and return
    // every default — silently turning appLock OFF and dropping the theme and
    // font the user chose (#380). Only the bad field falls back now.
    const { value, invalidKeys } = recoverFields(LocalSettingsSchema.shape, input, localSettingsDefaults);
    if (invalidKeys.length > 0) {
        console.warn(`[localSettings] ignoring invalid saved field(s), keeping the rest: ${invalidKeys.join(', ')}`);
    }

    // Unknown fields (written by a newer app version) ride along untouched.
    const unknownFields: Record<string, unknown> = { ...input };
    Object.keys(LocalSettingsSchema.shape).forEach(key => delete unknownFields[key]);

    return { ...localSettingsDefaults, ...unknownFields, ...value };
}

//
// Applying changes
//

export function applyLocalSettings(settings: LocalSettings, delta: Partial<LocalSettings>): LocalSettings {
    return { ...localSettingsDefaults, ...settings, ...delta };
}
