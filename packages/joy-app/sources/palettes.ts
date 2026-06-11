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

export interface NamedPalette extends Palette {
    id: string;
    name: string;
}

// Sentinel: restore the original light theme (no override).
export const DEFAULT_PALETTE_ID = 'default';
// Sentinel: use the user-entered custom colors.
export const CUSTOM_PALETTE_ID = 'custom';

export const PALETTES: NamedPalette[] = [
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
];

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
            userMessageBackground: p.userBubble,
            userMessageText: p.text,
            agentMessageText: p.text,
            agentEventText: p.textSecondary,
        },
    };
}

// Apply a palette to the live 'light' theme (or restore the original when
// null). Built from the pristine lightTheme each time so palettes never
// compound. Also updates the root view background when light is active.
export function applyPalette(p: Palette | null): void {
    UnistylesRuntime.updateTheme('light', () => (p ? buildPaletteTheme(p) : lightTheme));
    if (UnistylesRuntime.themeName === 'light') {
        const bg = p ? p.background : lightTheme.colors.groupped.background;
        UnistylesRuntime.setRootViewBackgroundColor(bg);
    }
}
