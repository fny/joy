import * as React from 'react';
import { Text, type TextStyle } from 'react-native';
import { getMonoFont } from '@/constants/Typography';

// ASCII-art "joy" wordmark in Unicode block elements, rendered as monospace
// text instead of the bitmap logotype. lineHeight is locked to fontSize so the
// half-block glyphs (▀ ▄) tile vertically into continuous shapes; any leading
// would split them apart.
const ART = [
    '                     ▄▄ ',
    '   ██ ▄████▄ ██  ██  ██ ',
    '   ██ ██  ██  ▀██▀   ██ ',
    '████▀ ▀████▀   ██    ▄▄ ',
    '                        ',
];

// Per-cell colors for the static multicolor wordmark (JoyLogoType). Keyed by
// [row][col]; only painted cells appear — spaces are absent. Lifted verbatim
// from the confetti render the colors were hand-picked from.
const STATIC: Record<number, Record<number, string>> = {
    0: { 21: '#00b3ff', 22: '#ff2d95' },
    1: { 3: '#00b3ff', 4: '#2dd4bf', 6: '#2dd4bf', 7: '#ffe600', 8: '#00b3ff', 9: '#8a2dff', 10: '#00e5a0', 11: '#2dd4bf', 13: '#ff2d95', 14: '#00b3ff', 17: '#ff2d95', 18: '#00e5a0', 21: '#00e5a0', 22: '#ff8a00' },
    2: { 3: '#00e5a0', 4: '#ff2d95', 6: '#00e5a0', 7: '#ff4040', 10: '#ffe600', 11: '#ff8a00', 14: '#ff4040', 15: '#ff8a00', 16: '#ff4040', 17: '#8a2dff', 21: '#8a2dff', 22: '#ff4040' },
    3: { 0: '#8a2dff', 1: '#00b3ff', 2: '#ff4040', 3: '#ff8a00', 4: '#8a2dff', 6: '#00e5a0', 7: '#ff4040', 8: '#2dd4bf', 9: '#ff8a00', 10: '#ff4040', 11: '#ff8a00', 15: '#ffe600', 16: '#00e5a0', 21: '#2dd4bf', 22: '#ff8a00' },
    4: {},
};

// Confetti palette + relative weights (share of cells per color, 0 removes it).
// Ported from the generator script so JoyLogoTypeDynamic matches its look.
const PALETTE: Record<string, string> = {
    magenta: '#ff2d95', orange: '#ff8a00', yellow: '#ffe600', cyan: '#00e5a0',
    blue: '#00b3ff', purple: '#8a2dff', red: '#ff4040', darkCyan: '#2dd4bf',
};
const WEIGHTS: Record<string, number> = {
    magenta: 3, orange: 2, yellow: 1, cyan: 3, blue: 4, purple: 3, red: 2, darkCyan: 4,
};
const WEIGHT_NAMES = Object.keys(WEIGHTS);
const WEIGHT_TOTAL = WEIGHT_NAMES.reduce((s, n) => s + WEIGHTS[n], 0);

// Small deterministic PRNG so a `seed` reproduces a render; null → Math.random.
function mulberry32(seed: number): () => number {
    let s = seed | 0;
    return function () {
        s = (s + 0x6d2b79f5) | 0;
        let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function pickWeighted(rng: () => number): string {
    let r = rng() * WEIGHT_TOTAL;
    let picked = WEIGHT_NAMES[WEIGHT_NAMES.length - 1];
    for (const n of WEIGHT_NAMES) {
        r -= WEIGHTS[n];
        if (r < 0) { picked = n; break; }
    }
    return PALETTE[picked];
}

type ColorAt = (row: number, col: number, ch: string) => string | undefined;

// Shared monospace renderer. Each painted cell becomes a nested <Text> with its
// own color; unpainted cells fall through to the parent color. Newlines live
// inside each row's <Text> so the grid stays exact.
const Grid = React.memo(({ lines, size, colorAt, color }: {
    lines: string[];
    size: number;
    colorAt: ColorAt;
    color?: string;
}) => {
    const style: TextStyle = {
        fontFamily: getMonoFont(),
        fontSize: size,
        lineHeight: size,
        color,
        includeFontPadding: false,
        textAlignVertical: 'center',
    };
    return (
        <Text style={style} allowFontScaling={false} selectable={false} accessibilityLabel="joy">
            {lines.map((line, r) => (
                <Text key={r}>
                    {[...line].map((ch, c) => {
                        const cell = colorAt(r, c, ch);
                        return cell
                            ? <Text key={c} style={{ color: cell }}>{ch}</Text>
                            : ch;
                    })}
                    {r < lines.length - 1 ? '\n' : null}
                </Text>
            ))}
        </Text>
    );
});

// Monochrome wordmark — tints to a single `color` (the former JoyLogotype).
export const JoyLogoTypeBlack = React.memo(({ size = 12, color }: { size?: number; color?: string }) => (
    <Grid lines={ART} size={size} color={color} colorAt={() => undefined} />
));

// Static multicolor wordmark — fixed, recognizable color assignment.
export const JoyLogoType = React.memo(({ size = 12 }: { size?: number }) => (
    <Grid lines={ART} size={size} colorAt={(r, c, ch) => (ch === ' ' ? undefined : STATIC[r]?.[c])} />
));

// Dynamic confetti wordmark — fresh weighted-random colors each mount (pass a
// `seed` to reproduce a particular render).
export const JoyLogoTypeDynamic = React.memo(({ size = 12, seed }: { size?: number; seed?: number }) => {
    // Roll once per mount (or when seed changes) so colors are stable across
    // re-renders/rotations rather than flickering on every paint.
    const grid = React.useMemo(() => {
        const rng = seed == null ? Math.random : mulberry32(seed);
        return ART.map((line) => [...line].map((ch) => (ch === ' ' ? undefined : pickWeighted(rng))));
    }, [seed]);
    return <Grid lines={ART} size={size} colorAt={(r, c) => grid[r]?.[c]} />;
});

// Just the leading "J" glyph (rows 1–3, cols 0–4), carrying its colors from the
// static wordmark — a compact, roughly-square mark for the app icon slot.
const J_LINES = ART.slice(1, 4).map((l) => l.slice(0, 5));
export const JoyLogoTypeJ = React.memo(({ size = 12 }: { size?: number }) => (
    <Grid lines={J_LINES} size={size} colorAt={(r, c, ch) => (ch === ' ' ? undefined : STATIC[r + 1]?.[c])} />
));

// Solid 4×3 confetti block — a compact, fully-filled app-icon mark.
const BLOCK_LINES = ['████', '████', '████'];
const BLOCK_COLORS: Record<number, Record<number, string>> = {
    0: { 0: '#00e5a0', 1: '#ffe600', 2: '#ff2d95', 3: '#8a2dff' },
    1: { 0: '#00b3ff', 1: '#2dd4bf', 2: '#00e5a0', 3: '#00b3ff' },
    2: { 0: '#8a2dff', 1: '#ff4040', 2: '#ff8a00', 3: '#ffe600' },
};
export const BlockLogo = React.memo(({ size = 12 }: { size?: number }) => (
    <Grid lines={BLOCK_LINES} size={size} colorAt={(r, c) => BLOCK_COLORS[r]?.[c]} />
));
