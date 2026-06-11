// Minimal ANSI SGR parser for rendering `tmux capture-pane -e` output in the
// joy pane. Handles the escape sequences Claude's TUI actually emits: reset,
// bold/dim/italic/underline/reverse, the 16 base colors (30-37/90-97 fg,
// 40-47/100-107 bg), 256-color (38;5;n / 48;5;n) and truecolor
// (38;2;r;g;b / 48;2;…). Non-SGR escape sequences (cursor moves etc.) are
// stripped. Output is per-line arrays of styled spans.

// Remove ANSI/terminal escape sequences (and stray control chars, keeping
// tab + newline) so terminal output never renders as garbage in the chat.
// The pane uses parseAnsiLines instead — it WANTS the color codes.
// eslint-disable-next-line no-control-regex
const ANSI_STRIP_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]|[\x00-\x08\x0b-\x1f\x7f]/g;
export function stripAnsi(s: string): string {
    return s.replace(ANSI_STRIP_RE, '');
}

export interface AnsiSpan {
    text: string;
    fg?: string;        // hex
    bg?: string;        // hex
    bold?: boolean;
    dim?: boolean;
    italic?: boolean;
    underline?: boolean;
    reverse?: boolean;
}

interface SgrState {
    fg?: string;
    bg?: string;
    bold: boolean;
    dim: boolean;
    italic: boolean;
    underline: boolean;
    reverse: boolean;
}

const BASE_16 = [
    '#000000', '#cd3131', '#0dbc79', '#e5e510', '#2472c8', '#bc3fbc', '#11a8cd', '#e5e5e5', // 0-7
    '#666666', '#f14c4c', '#23d18b', '#f5f543', '#3b8eea', '#d670d6', '#29b8db', '#ffffff', // 8-15 (bright)
];

// xterm 256-color palette: 16 base + 6×6×6 cube (16-231) + 24 grayscale (232-255).
function xterm256(n: number): string {
    if (n < 16) return BASE_16[n];
    if (n < 232) {
        const i = n - 16;
        const r = Math.floor(i / 36);
        const g = Math.floor((i % 36) / 6);
        const b = i % 6;
        const v = (c: number) => (c === 0 ? 0 : 55 + c * 40);
        return rgbHex(v(r), v(g), v(b));
    }
    const level = 8 + (n - 232) * 10;
    return rgbHex(level, level, level);
}

function rgbHex(r: number, g: number, b: number): string {
    const h = (c: number) => Math.max(0, Math.min(255, c)).toString(16).padStart(2, '0');
    return `#${h(r)}${h(g)}${h(b)}`;
}

function freshState(): SgrState {
    // fg/bg explicitly undefined so Object.assign(state, freshState()) on a
    // reset (SGR 0) actually clears them — an omitted key wouldn't overwrite.
    return { fg: undefined, bg: undefined, bold: false, dim: false, italic: false, underline: false, reverse: false };
}

// Apply one SGR sequence's numeric codes to the running state.
function applySgr(state: SgrState, codes: number[]): void {
    for (let i = 0; i < codes.length; i++) {
        const c = codes[i];
        switch (true) {
            case c === 0: Object.assign(state, freshState()); break;
            case c === 1: state.bold = true; break;
            case c === 2: state.dim = true; break;
            case c === 3: state.italic = true; break;
            case c === 4: state.underline = true; break;
            case c === 7: state.reverse = true; break;
            case c === 22: state.bold = false; state.dim = false; break;
            case c === 23: state.italic = false; break;
            case c === 24: state.underline = false; break;
            case c === 27: state.reverse = false; break;
            case c >= 30 && c <= 37: state.fg = BASE_16[c - 30]; break;
            case c === 38: {
                if (codes[i + 1] === 5) { state.fg = xterm256(codes[i + 2]); i += 2; }
                else if (codes[i + 1] === 2) { state.fg = rgbHex(codes[i + 2], codes[i + 3], codes[i + 4]); i += 4; }
                break;
            }
            case c === 39: state.fg = undefined; break;
            case c >= 40 && c <= 47: state.bg = BASE_16[c - 40]; break;
            case c === 48: {
                if (codes[i + 1] === 5) { state.bg = xterm256(codes[i + 2]); i += 2; }
                else if (codes[i + 1] === 2) { state.bg = rgbHex(codes[i + 2], codes[i + 3], codes[i + 4]); i += 4; }
                break;
            }
            case c === 49: state.bg = undefined; break;
            case c >= 90 && c <= 97: state.fg = BASE_16[8 + (c - 90)]; break;
            case c >= 100 && c <= 107: state.bg = BASE_16[8 + (c - 100)]; break;
        }
    }
}

function spanFrom(text: string, s: SgrState): AnsiSpan {
    return {
        text,
        fg: s.fg,
        bg: s.bg,
        bold: s.bold || undefined,
        dim: s.dim || undefined,
        italic: s.italic || undefined,
        underline: s.underline || undefined,
        reverse: s.reverse || undefined,
    };
}

// eslint-disable-next-line no-control-regex
const ESC = /\x1b\[([0-9;]*)m|\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

/**
 * Parse ANSI text into an array of lines, each a list of styled spans.
 * SGR state carries across lines (tmux can leave attributes open at EOL).
 */
export function parseAnsiLines(input: string): AnsiSpan[][] {
    const state = freshState();
    const lines: AnsiSpan[][] = [];

    for (const rawLine of input.split('\n')) {
        const spans: AnsiSpan[] = [];
        let last = 0;
        ESC.lastIndex = 0;
        let m: RegExpExecArray | null;
        const pushText = (text: string) => {
            if (text) spans.push(spanFrom(text, state));
        };
        while ((m = ESC.exec(rawLine)) !== null) {
            pushText(rawLine.slice(last, m.index));
            last = ESC.lastIndex;
            // Only SGR (…m) sequences carry style; m[1] is its numeric body.
            if (m[1] !== undefined) {
                const codes = m[1] === '' ? [0] : m[1].split(';').map(n => parseInt(n, 10) || 0);
                applySgr(state, codes);
            }
        }
        pushText(rawLine.slice(last));
        lines.push(spans.length ? spans : [spanFrom('', state)]);
    }
    return lines;
}
