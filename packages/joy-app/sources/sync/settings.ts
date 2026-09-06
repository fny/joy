import * as z from 'zod';
import { AgentDefaultOverridesSchema } from './agentDefaults';
import { recoverFields } from '@/utils/isolateBad';
import { preserveUnknownFields } from './settingsPreserve';

//
// Settings Schema
//

// Current schema version for backward compatibility
export const SUPPORTED_SCHEMA_VERSION = 2;

export const SettingsSchema = z.object({
    // Schema version for compatibility detection
    schemaVersion: z.number().default(SUPPORTED_SCHEMA_VERSION).describe('Settings schema version for compatibility checks'),

    viewInline: z.boolean().describe('Whether to view inline tool calls'),
    inferenceOpenAIKey: z.string().nullish().describe('OpenAI API key for inference'),
    expandTodos: z.boolean().describe('Whether to expand todo lists'),
    showLineNumbers: z.boolean().describe('Whether to show line numbers in diffs'),
    showLineNumbersInToolViews: z.boolean().describe('Whether to show line numbers in tool view diffs'),
    wrapLinesInDiffs: z.boolean().describe('Whether to wrap long lines in diff views'),
    diffStyle: z.enum(['unified', 'split']).describe('Diff view style (split is web-only)'),
    notificationsDesktop: z.boolean().describe('Show desktop notifications (web/desktop app)'),
    notificationsMobile: z.boolean().describe('Send mobile push notifications'),
    alwaysShowContextSize: z.boolean().describe('Always show context size in agent input'),
    agentInputEnterToSend: z.boolean().describe('Whether pressing Enter submits/sends in the agent input (web)'),
    avatarStyle: z.string().describe('Avatar display style'),
    showFlavorIcons: z.boolean().describe('Whether to show AI provider icons in avatars'),

    hideInactiveSessions: z.boolean().describe('Hide inactive sessions in the main list'),
    fileDiffsSidebar: z.boolean().describe('Show the file diffs sidebar next to the chat on desktop'),
    groupToolCalls: z.boolean().describe('Collapse consecutive tool calls into grouped containers in chat'),
    reviewPromptAnswered: z.boolean().describe('Whether the review prompt has been answered'),
    reviewPromptLikedApp: z.boolean().nullish().describe('Whether user liked the app when asked'),
    preferredLanguage: z.string().nullable().describe('Preferred UI language (null for auto-detect from device locale)'),
    recentMachinePaths: z.array(z.object({
        machineId: z.string(),
        path: z.string()
    })).describe('Last 10 machine-path combinations, ordered by most recent first'),
    lastUsedAgent: z.string().nullable().describe('Last selected agent type for new sessions'),
    lastUsedPermissionMode: z.string().nullable().describe('Last selected permission mode for new sessions'),
    lastUsedModelMode: z.string().nullable().describe('Last selected model mode for new sessions'),
    agentDefaultOverrides: AgentDefaultOverridesSchema.describe('User-selected agent defaults. Missing values use code defaults and are not sent as agent metadata.'),
    // Dismissed CLI warning banners (supports both per-machine and global dismissal)
    joy__chatHistoryLimit: z.number().nullable().describe('Mod 05: max messages to display per conversation (null = unlimited / off)'),
    joy__doubleTapEnabled: z.boolean().describe('Mod 06: require double tap to commit AskUserQuestion option/submit selections'),
    joy__tmuxServerUrl: z.string().nullable().describe('URL of the joy-tmux server for session management'),
    joy__newSessionDefault: z.boolean().describe('Joy: New session buttons open the joy-tmux create page instead of /new'),
    // Voice (ElevenLabs Conversational AI, bring-your-own agent). Synced
    // end-to-end encrypted like every other setting; the API key never goes
    // anywhere but api.elevenlabs.io from the device.
    voiceAgents: z.array(z.object({
        id: z.string(),
        name: z.string(),
        agentId: z.string(),
        apiKey: z.string().nullish(),
    })).describe('Voice agents the user added: a public agent id alone, or a private one with its API key'),
    voiceActiveAgentId: z.string().nullable().describe('Which voice agent to use (id from voiceAgents)'),
    voiceWakeOnEvents: z.boolean().describe('While voice is armed, session events (turn ended, approval, question) reconnect and speak'),
    voiceWakeOnSound: z.boolean().describe('While voice is idle and the app is in the foreground, listen locally and reconnect when speech-like sound is heard'),
    voiceIdleTimeoutSec: z.number().describe('Seconds of silence before an open voice conversation hangs up (stays armed); 0 = never'),
    dismissedCLIWarnings: z.object({
        perMachine: z.record(z.string(), z.object({
            claude: z.boolean().optional(),
            codex: z.boolean().optional(),
            gemini: z.boolean().optional(),
            openclaw: z.boolean().optional(),
        })).default({}),
        global: z.object({
            claude: z.boolean().optional(),
            codex: z.boolean().optional(),
            gemini: z.boolean().optional(),
            openclaw: z.boolean().optional(),
        }).default({}),
    }).default({ perMachine: {}, global: {} }).describe('Tracks which CLI installation warnings user has dismissed (per-machine or globally)'),
});

//
// NOTE: Settings must be a flat object with no to minimal nesting, one field == one setting,
// you can name them with a prefix if you want to group them, but don't nest them.
// You can nest if value is a single value (like image with url and width and height)
// Settings are always merged with defaults and field by field.
//
// This structure must be forward and backward compatible. Meaning that some versions of the app
// could be missing some fields or have a new fields. Everything must be preserved and client must
// only touch the fields it knows about.
//

export const SettingsSchemaPartial = SettingsSchema.partial();

export type Settings = z.infer<typeof SettingsSchema>;

//
// Defaults
//

export const settingsDefaults: Settings = {
    schemaVersion: SUPPORTED_SCHEMA_VERSION,
    viewInline: false,
    inferenceOpenAIKey: null,
    expandTodos: true,
    showLineNumbers: true,
    showLineNumbersInToolViews: false,
    wrapLinesInDiffs: true,
    diffStyle: 'unified',
    notificationsDesktop: true,
    notificationsMobile: true,
    alwaysShowContextSize: false,
    agentInputEnterToSend: true,
    avatarStyle: 'brutalist',
    showFlavorIcons: false,

    hideInactiveSessions: false,
    fileDiffsSidebar: false,
    groupToolCalls: false,
    reviewPromptAnswered: false,
    reviewPromptLikedApp: null,
    preferredLanguage: null,
    recentMachinePaths: [],
    lastUsedAgent: null,
    lastUsedPermissionMode: null,
    lastUsedModelMode: null,
    joy__chatHistoryLimit: null,
    joy__doubleTapEnabled: false,
    joy__tmuxServerUrl: null,
    joy__newSessionDefault: false,
    voiceAgents: [],
    voiceActiveAgentId: null,
    voiceWakeOnEvents: true,
    voiceWakeOnSound: true,
    voiceIdleTimeoutSec: 45,
    agentDefaultOverrides: {},
    dismissedCLIWarnings: { perMachine: {}, global: {} },
};
Object.freeze(settingsDefaults);

//
// Resolving
//

export function settingsParse(settings: unknown): Settings {
    // Handle null/undefined/invalid inputs
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
        return { ...settingsDefaults };
    }
    const input = settings as Record<string, unknown>;

    // Fields are validated INDEPENDENTLY: one malformed value (e.g.
    // showLineNumbers:"false" written by another client) used to fail the
    // whole-object parse and reset EVERY known setting to its default — saved
    // API keys, notificationsMobile, the explicit Claude permission-mode
    // override — and the next unrelated edit synced those defaults back (#399).
    const { value, invalidKeys } = recoverFields(SettingsSchema.shape, input, settingsDefaults);
    if (invalidKeys.length > 0) {
        console.warn(`[settings] ignoring invalid synced field(s), keeping the rest: ${invalidKeys.join(', ')}`);
    }

    // Migration: Convert old 'zh' language code to 'zh-Hans'
    if (value.preferredLanguage === 'zh') {
        console.log('[Settings Migration] Converting language code from "zh" to "zh-Hans"');
        value.preferredLanguage = 'zh-Hans';
    }

    // Nested forward compatibility: Zod strips keys it does not know from
    // nested objects (a newer client's voice-agent fields, an `opencode` entry
    // in dismissedCLIWarnings), and the next ordinary edit here synced the
    // stripped objects back, deleting the newer client's configuration (#400).
    // Restore what the schema dropped — only under fields that VALIDATED, so a
    // rejected value can never be partially resurrected; validated keys win.
    const invalid = new Set(invalidKeys);
    const known = value as Record<string, unknown>;
    for (const key of Object.keys(SettingsSchema.shape)) {
        if (invalid.has(key) || !Object.prototype.hasOwnProperty.call(input, key)) continue;
        known[key] = preserveUnknownFields(known[key], input[key]);
    }

    // Preserve unknown fields (forward compatibility): everything that is not
    // a known schema key rides along untouched.
    const unknownFields: Record<string, unknown> = { ...input };
    Object.keys(SettingsSchema.shape).forEach(key => delete unknownFields[key]);

    return { ...settingsDefaults, ...unknownFields, ...value };
}

//
// Applying changes
// NOTE: May be something more sophisticated here around defaults and merging, but for now this is fine.
//

export function applySettings(settings: Settings, delta: Partial<Settings>): Settings {
    // Original behavior: start with settings, apply delta, fill in missing with defaults
    const result = { ...settings, ...delta };

    // Fill in any missing fields with defaults
    Object.keys(settingsDefaults).forEach(key => {
        if (!(key in result)) {
            (result as any)[key] = (settingsDefaults as any)[key];
        }
    });

    return result;
}

export function settingsToSyncPayload(settings: Settings): Partial<Settings> {
    const result: Partial<Settings> = { ...settings };
    const compactAgentOverrides = Object.fromEntries(
        Object.entries(settings.agentDefaultOverrides ?? {}).filter(([, value]) => (
            value && typeof value === 'object' && Object.keys(value).length > 0
        )),
    ) as Settings['agentDefaultOverrides'];
    if (Object.keys(compactAgentOverrides).length === 0) {
        delete result.agentDefaultOverrides;
    } else {
        result.agentDefaultOverrides = compactAgentOverrides;
    }
    return result;
}
