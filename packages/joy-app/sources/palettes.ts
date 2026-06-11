import { UnistylesRuntime } from 'react-native-unistyles';
import { lightTheme } from './theme';

// A palette is a small curated set of "shell" colors that override the most
// visible tokens of the light theme at runtime (page background, surfaces,
// text, accent). It deliberately does NOT redefine all ~105 theme tokens —
// it's a fast way to re-skin the bulk of the UI and to test color directions.
// Accent-heavy spots that hardcode their own hex (iOS system colors scattered
// across components) are intentionally out of scope.
export interface Palette {
    background: string;     // page background (grouped lists, scroll bg)
    surface: string;        // cards, items, header
    surfaceAlt: string;     // raised surfaces + input fields
    text: string;           // primary text
    textSecondary: string;  // muted/secondary text
    accent: string;         // links, selection, active status dot
    border: string;         // dividers
    userBubble: string;     // chat: the user's message background
}

export type AccentKey = 'blue' | 'indigo' | 'green' | 'orange' | 'red' | 'pink';

export interface NamedPalette extends Palette {
    id: string;
    name: string;
    // Optional accent tweaks that ship with this palette (e.g. a muted set).
    accents?: Partial<Record<AccentKey, string>>;
}

// Sentinel: restore the original light theme (no override).
export const DEFAULT_PALETTE_ID = 'default';
// Sentinel: use the user-entered custom colors.
export const CUSTOM_PALETTE_ID = 'custom';

export const PALETTES: NamedPalette[] = [
    {
        // Original: the stock light theme's colours, surfaced as a palette so you
        // can see/copy/edit them. (The "Default" row restores the true theme.)
        id: 'original',
        name: 'Original',
        background: '#F2F2F7',
        surface: '#ffffff',
        surfaceAlt: '#F8F8F8',
        text: '#000000',
        textSecondary: '#8E8E93',
        accent: '#2BACCC',
        border: '#eaeaea',
        userBubble: '#f0eee6',
    },
    {
        // Lively: clean warm-white shell, vivid accents pulled from the confetti
        // logo. Colour lives in the accents/icons, not the surfaces, so it reads
        // playful without being busy.
        id: 'lively',
        name: 'Lively',
        background: '#fffdf8',
        surface: '#ffffff',
        surfaceAlt: '#f4f1ea',
        text: '#1b1a17',
        textSecondary: '#8a8578',
        accent: '#00b3ff',
        border: '#ece6d8',
        userBubble: '#eaf6ff',
        accents: { blue: '#00b3ff', indigo: '#8a2dff', green: '#00c2a0', orange: '#ff8a00', red: '#ff4040', pink: '#ff2d95' },
    },
    {
        // Muted: soft warm-gray shell, desaturated logo hues. The calmest, least
        // distracting option — accents are present but quiet.
        id: 'muted',
        name: 'Muted',
        background: '#f6f5f2',
        surface: '#fbfaf7',
        surfaceAlt: '#eceae4',
        text: '#2b2a27',
        textSecondary: '#9a958c',
        accent: '#5f93b8',
        border: '#e3e0d9',
        userBubble: '#ecebe6',
        // Desaturated versions of the joy logo hues (blue/purple/cyan/orange/
        // red/magenta) — still recognizably joy, just quiet.
        accents: { blue: '#5f93b8', indigo: '#8a78b8', green: '#5fae93', orange: '#cc9658', red: '#c87b73', pink: '#c57ba1' },
    },
    {
        id: 'cream',
        name: 'Cream',
        background: '#fffdf8',
        surface: '#fffefb',
        surfaceAlt: '#f4efe3',
        text: '#1b1a17',
        textSecondary: '#8a8578',
        accent: '#c2410c',
        border: '#ece5d6',
        userBubble: '#f0e9d9',
    },
    {
        id: 'sepia',
        name: 'Sepia',
        background: '#f4ecd8',
        surface: '#fbf5e6',
        surfaceAlt: '#ece0c4',
        text: '#3a2f23',
        textSecondary: '#8a7857',
        accent: '#9a3412',
        border: '#ddcfb0',
        userBubble: '#e8dcc0',
    },
    {
        id: 'slate',
        name: 'Slate',
        background: '#eef1f4',
        surface: '#ffffff',
        surfaceAlt: '#e2e7ee',
        text: '#1f2933',
        textSecondary: '#7b8794',
        accent: '#2563eb',
        border: '#d6dce4',
        userBubble: '#dde4ed',
    },
    {
        id: 'mint',
        name: 'Mint',
        background: '#f2faf6',
        surface: '#ffffff',
        surfaceAlt: '#e2f1ea',
        text: '#13241c',
        textSecondary: '#6b8a7c',
        accent: '#0f766e',
        border: '#d3e8df',
        userBubble: '#dcefe4',
    },
    {
        // Paper: warm, low-contrast, easy on the eyes.
        id: 'paper',
        name: 'Paper',
        background: '#f5f2ea',
        surface: '#fbf9f3',
        surfaceAlt: '#ece7da',
        text: '#33302a',
        textSecondary: '#8f897b',
        accent: '#9c6b4f',
        border: '#e2dcce',
        userBubble: '#ece5d6',
    },
    {
        // Graphite: cool neutral gray with crisp dark text.
        id: 'graphite',
        name: 'Graphite',
        background: '#eceef0',
        surface: '#ffffff',
        surfaceAlt: '#e0e3e7',
        text: '#23272b',
        textSecondary: '#79818a',
        accent: '#3a6ea5',
        border: '#d8dce0',
        userBubble: '#dde2e7',
    },
    {
        // Ocean: soft blue-tinted, cool and calm; blue-leaning accents.
        id: 'ocean',
        name: 'Ocean',
        background: '#eef4f7',
        surface: '#fbfdfe',
        surfaceAlt: '#dfeaf0',
        text: '#15303a',
        textSecondary: '#6f8a96',
        accent: '#0e7490',
        border: '#d3e2ea',
        userBubble: '#dcebf1',
        accents: { blue: '#0e7490', indigo: '#3b6fb0', green: '#2c9c8f', orange: '#c2843e', red: '#bf6b63', pink: '#b56d92' },
    },
    {
        // Rosé: warm blush; soft warm accents.
        id: 'rose',
        name: 'Rosé',
        background: '#faf1f0',
        surface: '#fef8f7',
        surfaceAlt: '#f1e0de',
        text: '#3a2a2a',
        textSecondary: '#9c8482',
        accent: '#b05a6a',
        border: '#ecd8d6',
        userBubble: '#f3e2e0',
        accents: { blue: '#7d7fb3', indigo: '#9b6fa8', green: '#7ba883', orange: '#cc8b5a', red: '#c4685f', pink: '#c76d8e' },
    },
];

// The original light theme expressed as a shell palette — used when copying
// the "Default" selection into the custom editor.
export const DEFAULT_SHELL: Palette = {
    background: lightTheme.colors.groupped.background as string,
    surface: lightTheme.colors.surface,
    surfaceAlt: lightTheme.colors.surfaceHigh,
    text: lightTheme.colors.text,
    textSecondary: lightTheme.colors.textSecondary as string,
    accent: lightTheme.colors.textLink,
    border: lightTheme.colors.divider as string,
    userBubble: lightTheme.colors.userMessageBackground,
};

// Seed for the custom editor when the user hasn't set one yet.
export const CUSTOM_PALETTE_DEFAULT: Palette = { ...PALETTES[0] };
const PALETTE_KEYS: (keyof Palette)[] = ['background', 'surface', 'surfaceAlt', 'text', 'textSecondary', 'accent', 'border', 'userBubble'];

// Labels for the custom editor fields.
export const PALETTE_FIELDS: { key: keyof Palette; label: string }[] = [
    { key: 'background', label: 'Background' },
    { key: 'surface', label: 'Surface (cards, header)' },
    { key: 'surfaceAlt', label: 'Raised surface / inputs' },
    { key: 'text', label: 'Text' },
    { key: 'textSecondary', label: 'Secondary text' },
    { key: 'accent', label: 'Accent (links, selection)' },
    { key: 'border', label: 'Divider' },
    { key: 'userBubble', label: 'Your message bubble' },
];

// Merge a stored partial (may be missing keys / not yet validated) onto the
// custom default so we always have a complete palette.
export function coerceCustomPalette(stored: Record<string, string> | null | undefined): Palette {
    const out = { ...CUSTOM_PALETTE_DEFAULT };
    if (stored) {
        for (const k of PALETTE_KEYS) {
            if (typeof stored[k] === 'string') out[k] = stored[k];
        }
    }
    return out;
}

// Resolve a selection (id + stored custom colors) to the palette to apply, or
// null for the original light theme.
export function resolvePalette(id: string, custom: Record<string, string> | null | undefined): Palette | null {
    if (id === DEFAULT_PALETTE_ID) return null;
    if (id === CUSTOM_PALETTE_ID) return coerceCustomPalette(custom);
    return PALETTES.find((p) => p.id === id) ?? null;
}

// Build a full light-theme object with the palette's colors patched in.
export function buildPaletteTheme(p: Palette): typeof lightTheme {
    const c = lightTheme.colors;
    return {
        ...lightTheme,
        colors: {
            ...c,
            text: p.text,
            textSecondary: p.textSecondary,
            textLink: p.accent,
            surface: p.surface,
            surfaceHigh: p.surfaceAlt,
            surfaceHighest: p.surfaceAlt,
            divider: p.border,
            groupped: { ...c.groupped, background: p.background },
            header: { ...c.header, background: p.surface },
            input: { ...c.input, background: p.surfaceAlt, text: p.text },
            radio: { ...c.radio, active: p.accent, dot: p.accent },
            status: { ...c.status, connecting: p.accent },
            // Interactive surfaces follow the accent (primary buttons + FAB are
            // black by default; on a palette they pick up its accent color).
            button: { ...c.button, primary: { ...c.button.primary, background: p.accent } },
            fab: { ...c.fab, background: p.accent, backgroundPressed: p.accent },
            userMessageBackground: p.userBubble,
            userMessageText: p.text,
            agentMessageText: p.text,
            agentEventText: p.textSecondary,
        },
    };
}

//
// Accents — named icon-tint colors, overridable independently of the shell.
//

export const ACCENT_FIELDS: { key: AccentKey; label: string }[] = [
    { key: 'blue', label: 'Blue' },
    { key: 'indigo', label: 'Indigo' },
    { key: 'green', label: 'Green' },
    { key: 'orange', label: 'Orange' },
    { key: 'red', label: 'Red' },
    { key: 'pink', label: 'Pink' },
];
const ACCENT_KEYS: AccentKey[] = ACCENT_FIELDS.map((f) => f.key);
const HEX_OK = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

// The shipped defaults (from the light theme) — the "default" shown per accent.
export const ACCENT_DEFAULTS: Record<AccentKey, string> = { ...lightTheme.colors.accents };

// Fill missing/invalid keys from the defaults so we always have a full set.
export function coerceAccentOverrides(stored: Record<string, string> | null | undefined): Record<AccentKey, string> {
    const out = { ...ACCENT_DEFAULTS };
    if (stored) {
        for (const k of ACCENT_KEYS) {
            if (typeof stored[k] === 'string') out[k] = stored[k];
        }
    }
    return out;
}

// Compose the live light theme: palette shell + accent overrides layered onto
// the theme's accent defaults. Only valid hex overrides are applied.
export function buildLiveTheme(palette: Palette | null, accents?: Record<string, string> | null): typeof lightTheme {
    const base = palette ? buildPaletteTheme(palette) : lightTheme;
    if (!accents) return base;
    const merged: Record<AccentKey, string> = { ...base.colors.accents };
    for (const k of ACCENT_KEYS) {
        const v = accents[k];
        if (typeof v === 'string' && HEX_OK.test(v.trim())) merged[k] = v.trim();
    }
    return { ...base, colors: { ...base.colors, accents: merged } };
}

// Apply the full appearance (palette shell + accents) to the live 'light'
// theme. Accents = the selected preset palette's own accents, overlaid with the
// global accent overrides from the dev Accents page. Rebuilt from the pristine
// lightTheme each time so nothing compounds.
export function applyAppearance(
    id: string,
    customShell: Record<string, string> | null | undefined,
    accentOverrides: Record<string, string> | null | undefined,
): void {
    const palette = resolvePalette(id, customShell);
    const presetAccents = PALETTES.find((p) => p.id === id)?.accents;
    const accents = { ...(presetAccents ?? {}), ...(accentOverrides ?? {}) };
    UnistylesRuntime.updateTheme('light', () => buildLiveTheme(palette, accents));
    if (UnistylesRuntime.themeName === 'light') {
        const bg = palette ? palette.background : lightTheme.colors.groupped.background;
        UnistylesRuntime.setRootViewBackgroundColor(bg);
    }
}
