import { BASE_16 } from '@/utils/ansi';

// A terminal colour theme: the window background/foreground plus the 16-colour
// ANSI palette used to render `tmux capture-pane -e` output and bash results.
export interface TerminalTheme {
    id: string;
    name: string;
    background: string;
    foreground: string;
    // 16 ANSI colours: black,red,green,yellow,blue,magenta,cyan,white + 8 bright.
    ansi: string[];
}

// Standard Solarized ANSI palette — shared by the dark and light variants
// (Solarized differs only in background/foreground).
const SOLARIZED_ANSI = [
    '#073642', '#dc322f', '#859900', '#b58900', '#268bd2', '#d33682', '#2aa198', '#eee8d5',
    '#002b36', '#cb4b16', '#586e75', '#657b83', '#839496', '#6c71c4', '#93a1a1', '#fdf6e3',
];

export const TERMINAL_THEMES: TerminalTheme[] = [
    { id: 'default', name: 'Default (Dark)', background: '#0c0c0c', foreground: '#d4d4d4', ansi: BASE_16 },
    { id: 'solarized-dark', name: 'Solarized Dark', background: '#002b36', foreground: '#839496', ansi: SOLARIZED_ANSI },
    { id: 'solarized-light', name: 'Solarized Light', background: '#fdf6e3', foreground: '#657b83', ansi: SOLARIZED_ANSI },
    { id: 'github-dark', name: 'GitHub Dark', background: '#0d1117', foreground: '#c9d1d9', ansi: [
        '#484f58', '#ff7b72', '#3fb950', '#d29922', '#58a6ff', '#bc8cff', '#39c5cf', '#b1bac4',
        '#6e7681', '#ffa198', '#56d364', '#e3b341', '#79c0ff', '#d2a8ff', '#56d4dd', '#f0f6fc',
    ] },
];

export const DEFAULT_TERMINAL_THEME_ID = 'default';

export function resolveTerminalTheme(id?: string | null): TerminalTheme {
    return TERMINAL_THEMES.find((t) => t.id === id) ?? TERMINAL_THEMES[0];
}

// Semantic colours for the bash command view, derived from the ANSI palette.
export function terminalSemantics(t: TerminalTheme) {
    return {
        background: t.background,
        prompt: t.ansi[2],      // green
        command: t.foreground,
        stdout: t.foreground,
        stderr: t.ansi[3],      // yellow
        error: t.ansi[1],       // red
        emptyOutput: t.ansi[8], // bright black / muted
    };
}
