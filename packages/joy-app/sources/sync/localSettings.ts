import * as z from 'zod';

//
// Schema
//

export const LocalSettingsSchema = z.object({
    // Developer settings (device-specific)
    debugMode: z.boolean().describe('Enable debug logging'),
    devModeEnabled: z.boolean().describe('Enable developer menu in settings'),
    voiceUpsellOverride: z.enum(['control', 'show-paywall-before-first-voice-chat', 'voice-onboarding-and-upsell']).nullable().describe('Developer-only local override for the voice-upsell PostHog flag'),
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
    includePluginCommands: z.boolean().describe('Include plugin slash commands in the composer / autocomplete (off = personal + project commands only)'),
    // CLI version acknowledgments - keyed by machineId
    acknowledgedCliVersions: z.record(z.string(), z.string()).describe('Acknowledged CLI versions per machine'),
});

//
// NOTE: Local settings are device-specific and should NOT be synced.
// These are preferences that make sense to be different on each device.
//

const LocalSettingsSchemaPartial = LocalSettingsSchema.passthrough().partial();

export type LocalSettings = z.infer<typeof LocalSettingsSchema>;

//
// Defaults
//

export const localSettingsDefaults: LocalSettings = {
    debugMode: false,
    devModeEnabled: false,
    voiceUpsellOverride: null,
    commandPaletteEnabled: false,
    themePreference: 'adaptive',
    themePalette: 'default',
    themePaletteDark: 'default',
    customPalette: null,
    accentOverrides: null,
    fontOverride: null,
    limitSessionMemory: 5,
    includePluginCommands: true,
    terminalTheme: 'default',
    markdownCopyV2: false,
    consoleLoggingEnabled: false,
    verboseLogging: false,
    zenMode: false,
    acknowledgedCliVersions: {},
};
Object.freeze(localSettingsDefaults);

//
// Parsing
//

export function localSettingsParse(settings: unknown): LocalSettings {
    const parsed = LocalSettingsSchemaPartial.safeParse(settings);
    if (!parsed.success) {
        return { ...localSettingsDefaults };
    }
    return { ...localSettingsDefaults, ...parsed.data };
}

//
// Applying changes
//

export function applyLocalSettings(settings: LocalSettings, delta: Partial<LocalSettings>): LocalSettings {
    return { ...localSettingsDefaults, ...settings, ...delta };
}
