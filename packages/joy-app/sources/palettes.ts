import { UnistylesRuntime } from 'react-native-unistyles';
import { lightTheme, darkTheme } from './theme';

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
    button?: string;        // primary button + FAB bg (defaults to accent)
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
    { id: 'solarized-light', name: 'Solarized Light', background: '#fdf6e3', surface: '#eee8d5', surfaceAlt: '#e8e1cb', text: '#657b83', textSecondary: '#93a1a1', accent: '#268bd2', border: '#d8d2bf', userBubble: '#eee8d5', accents: { blue: '#268bd2', indigo: '#6c71c4', green: '#859900', orange: '#cb4b16', red: '#dc322f', pink: '#d33682' } },
    { id: 'github-light', name: 'GitHub Light', background: '#ffffff', surface: '#f6f8fa', surfaceAlt: '#eaeef2', text: '#1f2328', textSecondary: '#656d76', accent: '#0969da', border: '#d0d7de', userBubble: '#f6f8fa', accents: { blue: '#0969da', indigo: '#8250df', green: '#1a7f37', orange: '#bc4c00', red: '#cf222e', pink: '#bf3989' } },
    { id: 'ayu-light', name: 'Ayu Light', background: '#fcfcfc', surface: '#f8f9fa', surfaceAlt: '#ffffff', text: '#5c6166', textSecondary: '#787b80', accent: '#ffaa33', border: '#eaecef', userBubble: '#f0f2f4', accents: { blue: '#399ee6', indigo: '#a37acc', green: '#86b300', orange: '#fa8d3e', red: '#f07171', pink: '#ed9366' } },
    { id: 'material-light', name: 'Material Light', background: '#fafafa', surface: '#ffffff', surfaceAlt: '#eeeeee', text: '#546e7a', textSecondary: '#90a4ae', accent: '#80cbc4', border: '#dbdbdb', userBubble: '#eceff1', accents: { blue: '#6182b8', indigo: '#9c3eda', green: '#91b859', orange: '#f76d47', red: '#e53935', pink: '#ff5370' } },
    { id: 'one-light', name: 'One Light', background: '#fafafa', surface: '#eaeaeb', surfaceAlt: '#dbdbdc', text: '#383a42', textSecondary: '#a0a1a7', accent: '#526fff', border: '#dbdbdc', userBubble: '#e5e5e6', accents: { blue: '#0184bc', indigo: '#a626a4', green: '#50a14f', orange: '#986801', red: '#e45649', pink: '#ca1243' } },
    { id: 'tokyo-night-day', name: 'Tokyo Night Day', background: '#e6e7ed', surface: '#d6d8df', surfaceAlt: '#c1c2c7', text: '#343b59', textSecondary: '#888b94', accent: '#2959aa', border: '#c1c2c7', userBubble: '#d6d8df', accents: { blue: '#2959aa', indigo: '#65359d', green: '#385f0d', orange: '#965027', red: '#942f2f', pink: '#8c4351' } },
    { id: 'nord-light', name: 'Nord Light', background: '#eceff4', surface: '#e5e9f0', surfaceAlt: '#d8dee9', text: '#2e3440', textSecondary: '#4c566a', accent: '#5e81ac', border: '#d8dee9', userBubble: '#e5e9f0', accents: { blue: '#5e81ac', indigo: '#b48ead', green: '#a3be8c', orange: '#d08770', red: '#bf616a', pink: '#b48ead' } },
    { id: 'gruvbox-light', name: 'Gruvbox Light', background: '#fbf1c7', surface: '#f2e5bc', surfaceAlt: '#ebdbb2', text: '#3c3836', textSecondary: '#7c6f64', accent: '#458588', border: '#ebdbb2', userBubble: '#f2e5bc', accents: { blue: '#458588', indigo: '#b16286', green: '#98971a', orange: '#d65d0e', red: '#cc241d', pink: '#d3869b' } },
    { id: 'kanagawa-lotus', name: 'Kanagawa Lotus', background: '#f2ecbc', surface: '#e5ddb0', surfaceAlt: '#e7dba0', text: '#545464', textSecondary: '#8a8980', accent: '#4d699b', border: '#d5cea3', userBubble: '#dcd5ac', accents: { blue: '#4d699b', indigo: '#624c83', green: '#6f894e', orange: '#cc6d00', red: '#c84053', pink: '#b35b79' } },
    { id: 'light-owl', name: 'Light Owl', background: '#fbfbfb', surface: '#f0f0f0', surfaceAlt: '#e8e8e8', text: '#403f53', textSecondary: '#989fb1', accent: '#4876d6', border: '#d9d9d9', userBubble: '#f0f0f0', accents: { blue: '#4876d6', indigo: '#994cc3', green: '#08916a', orange: '#aa0982', red: '#e64d49', pink: '#ff2c83' } },
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
// The editable shell colours (excludes the optional `button`).
export type PaletteShellKey = 'background' | 'surface' | 'surfaceAlt' | 'text' | 'textSecondary' | 'accent' | 'border' | 'userBubble';
const PALETTE_KEYS: PaletteShellKey[] = ['background', 'surface', 'surfaceAlt', 'text', 'textSecondary', 'accent', 'border', 'userBubble'];

// Labels for the custom editor fields.
export const PALETTE_FIELDS: { key: PaletteShellKey; label: string }[] = [
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

// Scale each RGB channel by `factor` (<1 darkens, >1 lightens). Used to derive
// a second elevation level from one palette surface. Falls back on bad input.
function shade(hex: string, factor: number): string {
    const m = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(hex.trim());
    if (!m) return hex;
    const h = m[1].length === 3 ? m[1].split('').map((c) => c + c).join('') : m[1];
    const ch = (i: number) => Math.round(Math.min(255, Math.max(0, parseInt(h.slice(i, i + 2), 16) * factor)));
    const to2 = (n: number) => n.toString(16).padStart(2, '0');
    return `#${to2(ch(0))}${to2(ch(2))}${to2(ch(4))}`;
}

// Build a full theme object with the palette's colors patched in. `base` is the
// theme being re-skinned — lightTheme for light palettes, darkTheme for dark.
export function buildPaletteTheme(p: Palette, base: typeof lightTheme = lightTheme): typeof lightTheme {
    const c = base.colors;
    return {
        ...base,
        colors: {
            ...c,
            text: p.text,
            textSecondary: p.textSecondary,
            textLink: p.accent,
            surface: p.surface,
            // Two elevation levels — keep them distinct (cards vs. raised
            // headers) so tool/markdown cards don't go flat under a palette.
            surfaceHigh: p.surfaceAlt,
            surfaceHighest: shade(p.surfaceAlt, 0.94),
            // Interaction-state surfaces (pressed/selected rows) derived from the
            // palette so e.g. the selected session row tints with the theme.
            surfacePressed: shade(p.surfaceAlt, 0.96),
            surfaceSelected: shade(p.surfaceAlt, 0.9),
            divider: p.border,
            groupped: { ...c.groupped, background: p.background },
            header: { ...c.header, background: p.surface },
            input: { ...c.input, background: p.surfaceAlt, text: p.text },
            radio: { ...c.radio, active: p.accent, dot: p.accent },
            // Status colours stay semantic (connected/connecting/error keep
            // their meaning) — they must NOT follow the palette accent.
            // Primary buttons + FAB default to the accent; a palette can override
            // with an explicit `button` colour (e.g. Original keeps it black).
            button: { ...c.button, primary: { ...c.button.primary, background: p.button ?? p.accent } },
            fab: { ...c.fab, background: p.button ?? p.accent, backgroundPressed: p.button ?? p.accent },
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
export function buildLiveTheme(palette: Palette | null, accents?: Record<string, string> | null, baseTheme: typeof lightTheme = lightTheme): typeof lightTheme {
    const base = palette ? buildPaletteTheme(palette, baseTheme) : baseTheme;
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

//
// Dark palettes — the same shell idea, but re-skinning the DARK theme. Selected
// independently of the light palette (setting `themePaletteDark`) and shown when
// Appearance is Dark (or system-dark). Presets only — no custom dark editor.
//

export const DARK_PALETTES: NamedPalette[] = [
    { id: 'solarized-dark', name: 'Solarized Dark', background: '#002b36', surface: '#073642', surfaceAlt: '#0a3f4d', text: '#839496', textSecondary: '#586e75', accent: '#268bd2', border: '#0d4250', userBubble: '#073642', accents: { blue: '#268bd2', indigo: '#6c71c4', green: '#859900', orange: '#cb4b16', red: '#dc322f', pink: '#d33682' } },
    { id: 'github-dark', name: 'GitHub Dark', background: '#0d1117', surface: '#161b22', surfaceAlt: '#21262d', text: '#e6edf3', textSecondary: '#7d8590', accent: '#2f81f7', border: '#30363d', userBubble: '#161b22', accents: { blue: '#79c0ff', indigo: '#d2a8ff', green: '#56d364', orange: '#ffa657', red: '#ffa198', pink: '#ff9bce' } },
    { id: 'ayu-dark', name: 'Ayu Dark', background: '#0d1017', surface: '#10141c', surfaceAlt: '#161a24', text: '#bfbdb6', textSecondary: '#565b66', accent: '#e6b450', border: '#1b1f29', userBubble: '#141821', accents: { blue: '#59c2ff', indigo: '#d2a6ff', green: '#aad94c', orange: '#ff8f40', red: '#f07178', pink: '#f29668' } },
    { id: 'material-ocean', name: 'Material Ocean Dark', background: '#0f111a', surface: '#181a24', surfaceAlt: '#1a1c25', text: '#babed8', textSecondary: '#464b5d', accent: '#82aaff', border: '#232631', userBubble: '#1a1c25', accents: { blue: '#82aaff', indigo: '#c792ea', green: '#c3e88d', orange: '#f78c6c', red: '#f07178', pink: '#ff9cac' } },
    { id: 'one-dark', name: 'One Dark', background: '#282c34', surface: '#21252b', surfaceAlt: '#2c313a', text: '#abb2bf', textSecondary: '#5c6370', accent: '#528bff', border: '#181a1f', userBubble: '#3e4451', accents: { blue: '#61afef', indigo: '#c678dd', green: '#98c379', orange: '#d19a66', red: '#e06c75', pink: '#e06c75' } },
    { id: 'tokyo-night', name: 'Tokyo Night', background: '#1a1b26', surface: '#16161e', surfaceAlt: '#14141b', text: '#a9b1d6', textSecondary: '#51597d', accent: '#7aa2f7', border: '#101014', userBubble: '#2a2e42', accents: { blue: '#7aa2f7', indigo: '#bb9af7', green: '#9ece6a', orange: '#ff9e64', red: '#f7768e', pink: '#bb9af7' } },
    { id: 'nord-dark', name: 'Nord Dark', background: '#2e3440', surface: '#3b4252', surfaceAlt: '#434c5e', text: '#eceff4', textSecondary: '#d8dee9', accent: '#88c0d0', border: '#434c5e', userBubble: '#3b4252', accents: { blue: '#81a1c1', indigo: '#b48ead', green: '#a3be8c', orange: '#d08770', red: '#bf616a', pink: '#b48ead' } },
    { id: 'gruvbox-dark', name: 'Gruvbox Dark', background: '#282828', surface: '#3c3836', surfaceAlt: '#504945', text: '#ebdbb2', textSecondary: '#a89984', accent: '#83a598', border: '#504945', userBubble: '#3c3836', accents: { blue: '#83a598', indigo: '#d3869b', green: '#b8bb26', orange: '#fe8019', red: '#fb4934', pink: '#d3869b' } },
    { id: 'kanagawa-dragon', name: 'Kanagawa Dragon', background: '#181616', surface: '#1d1c19', surfaceAlt: '#282727', text: '#c5c9c5', textSecondary: '#737c73', accent: '#7e9cd8', border: '#393836', userBubble: '#282727', accents: { blue: '#7e9cd8', indigo: '#957fb8', green: '#87a987', orange: '#b6927b', red: '#c4746e', pink: '#d27e99' } },
    { id: 'night-owl', name: 'Night Owl', background: '#011627', surface: '#0b2942', surfaceAlt: '#0b253a', text: '#d6deeb', textSecondary: '#637777', accent: '#82aaff', border: '#122d42', userBubble: '#0b253a', accents: { blue: '#82aaff', indigo: '#c792ea', green: '#c5e478', orange: '#f78c6c', red: '#ef5350', pink: '#ff5874' } },
];

// Resolve a dark selection to the palette to apply, or null for the stock dark
// theme (DEFAULT_PALETTE_ID). Presets only.
export function resolveDarkPalette(id: string): Palette | null {
    if (id === DEFAULT_PALETTE_ID) return null;
    return DARK_PALETTES.find((p) => p.id === id) ?? null;
}

// Apply a dark palette selection to the live 'dark' theme. Rebuilt from the
// pristine darkTheme each time so nothing compounds.
export function applyDarkAppearance(id: string): void {
    const palette = resolveDarkPalette(id);
    const presetAccents = DARK_PALETTES.find((p) => p.id === id)?.accents;
    UnistylesRuntime.updateTheme('dark', () => buildLiveTheme(palette, presetAccents, darkTheme));
    if (UnistylesRuntime.themeName === 'dark') {
        const bg = palette ? palette.background : (darkTheme.colors.groupped.background as string);
        UnistylesRuntime.setRootViewBackgroundColor(bg);
    }
}
