import * as React from "react";
import { Text, type TextStyle } from "react-native";
import { getMonoFont } from "@/constants/Typography";

// ASCII-art "joy" wordmark in Unicode block elements, rendered as monospace
// text instead of the bitmap logotype. lineHeight is locked to fontSize so the
// half-block glyphs (▀ ▄) tile vertically into continuous shapes; any leading
// would split them apart.
const ART = [
  "                     ▄▄ ",
  "   ██ ▄████▄ ██  ██  ██ ",
  "   ██ ██  ██  ▀██▀   ██ ",
  "████▀ ▀████▀   ██    ▄▄ ",
  "                        ",
];

// Canonical color palette — the single place hex values live. STATIC,
// BLOCK_COLORS, and the confetti picker all reference PALETTE.<name>.
const PALETTE: Record<string, string> = {
  magenta: "#ff2d95",
  orange: "#ff8a00",
  yellow: "#ffe600",
  cyan: "#00e5a0",
  blue: "#00b3ff",
  purple: "#8a2dff",
  red: "#ff4040",
  darkCyan: "#2dd4bf",
};

// Per-cell colors for the static multicolor wordmark (JoyLogoType). Keyed by
// [row][col]; only painted cells appear — spaces are absent. Lifted verbatim
// from the confetti render the colors were hand-picked from.
const STATIC: Record<number, Record<number, string>> = {
  0: { 21: PALETTE.blue, 22: PALETTE.magenta },
  1: {
    3: PALETTE.blue,
    4: PALETTE.darkCyan,
    6: PALETTE.darkCyan,
    7: PALETTE.yellow,
    8: PALETTE.blue,
    9: PALETTE.purple,
    10: PALETTE.cyan,
    11: PALETTE.darkCyan,
    13: PALETTE.magenta,
    14: PALETTE.blue,
    17: PALETTE.magenta,
    18: PALETTE.cyan,
    21: PALETTE.cyan,
    22: PALETTE.orange,
  },
  2: {
    3: PALETTE.cyan,
    4: PALETTE.magenta,
    6: PALETTE.cyan,
    7: PALETTE.red,
    10: PALETTE.yellow,
    11: PALETTE.orange,
    14: PALETTE.red,
    15: PALETTE.orange,
    16: PALETTE.red,
    17: PALETTE.purple,
    21: PALETTE.purple,
    22: PALETTE.red,
  },
  3: {
    0: PALETTE.purple,
    1: PALETTE.blue,
    2: PALETTE.red,
    3: PALETTE.orange,
    4: PALETTE.purple,
    6: PALETTE.cyan,
    7: PALETTE.red,
    8: PALETTE.darkCyan,
    9: PALETTE.orange,
    10: PALETTE.red,
    11: PALETTE.orange,
    15: PALETTE.yellow,
    16: PALETTE.cyan,
    21: PALETTE.darkCyan,
    22: PALETTE.orange,
  },
  4: {},
};

function lightenColor(hex: string, amount: number, gray: number): string {
  let r = parseInt(hex.slice(1, 3), 16);
  let g = parseInt(hex.slice(3, 5), 16);
  let b = parseInt(hex.slice(5, 7), 16);
  // lerp each channel toward `gray` rather than toward 255
  r = Math.round(r + (gray - r) * amount);
  g = Math.round(g + (gray - g) * amount);
  b = Math.round(b + (gray - b) * amount);
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
}

// Lightened version of every palette color (the drop-shadow tint), derived from
// PALETTE via the same lightening used in the shadow — keyed by the original hex
// so a cell color maps straight to its shadow color. Computed once at module load.
const PALLETE_LIGHTENED: Record<string, string> = Object.fromEntries(
  Object.values(PALETTE).map((hex) => [hex, lightenColor(hex, 0.7, 250)]),
);

const WEIGHTS: Record<string, number> = {
  magenta: 3,
  orange: 2,
  yellow: 1,
  cyan: 3,
  blue: 4,
  purple: 3,
  red: 2,
  darkCyan: 4,
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
    if (r < 0) {
      picked = n;
      break;
    }
  }
  return PALETTE[picked];
}

type ColorAt = (row: number, col: number, ch: string) => string | undefined;

// Shared monospace renderer. Each painted cell becomes a nested <Text> with its
// own color; unpainted cells fall through to the parent color. Newlines live
// inside each row's <Text> so the grid stays exact.
const Grid = React.memo(
  ({
    lines,
    size,
    colorAt,
    color,
    shadow = 5,
  }: {
    lines: string[];
    size: number;
    colorAt: ColorAt;
    color?: string;
    /** hard drop-shadow offset in px (no blur). Defaults to the wordmark's 5. */
    shadow?: number;
  }) => {
    const style: TextStyle = {
      fontFamily: getMonoFont(),
      fontSize: size,
      lineHeight: size,
      color,
      includeFontPadding: false,
      textAlignVertical: "center",
    };
    return (
      <Text
        style={style}
        allowFontScaling={false}
        selectable={false}
        accessibilityLabel="joy"
      >
        {lines.map((line, r) => (
          <Text key={r}>
            {[...line].map((ch, c) => {
              const cell = colorAt(r, c, ch);
              return cell ? (
                <Text
                  key={c}
                  style={{
                    color: cell,
                    textShadowColor: PALLETE_LIGHTENED[cell],
                    textShadowOffset: { width: shadow, height: shadow },
                    textShadowRadius: 0,
                  }}
                >
                  {ch}
                </Text>
              ) : (
                ch
              );
            })}
            {r < lines.length - 1 ? "\n" : null}
          </Text>
        ))}
      </Text>
    );
  },
);

// Monochrome wordmark — tints to a single `color` (the former JoyLogotype).
export const JoyLogoTypeBlack = React.memo(
  ({ size = 12, color }: { size?: number; color?: string }) => (
    <Grid lines={ART} size={size} color={color} colorAt={() => undefined} />
  ),
);

// Static multicolor wordmark — fixed, recognizable color assignment.
export const JoyLogoType = React.memo(({ size = 12 }: { size?: number }) => (
  <Grid
    lines={ART}
    size={size}
    colorAt={(r, c, ch) => (ch === " " ? undefined : STATIC[r]?.[c])}
  />
));

// Dynamic confetti wordmark — fresh weighted-random colors each mount (pass a
// `seed` to reproduce a particular render).
export const JoyLogoTypeDynamic = React.memo(
  ({ size = 12, seed }: { size?: number; seed?: number }) => {
    // Roll once per mount (or when seed changes) so colors are stable across
    // re-renders/rotations rather than flickering on every paint.
    const grid = React.useMemo(() => {
      const rng = seed == null ? Math.random : mulberry32(seed);
      return ART.map((line) =>
        [...line].map((ch) => (ch === " " ? undefined : pickWeighted(rng))),
      );
    }, [seed]);
    return <Grid lines={ART} size={size} colorAt={(r, c) => grid[r]?.[c]} />;
  },
);

// Just the leading "J" glyph (rows 1–3, cols 0–4), carrying its colors from the
// static wordmark — a compact, roughly-square mark for the app icon slot.
const J_LINES = ART.slice(1, 4).map((l) => l.slice(0, 5));
export const JoyLogoTypeJ = React.memo(({ size = 12 }: { size?: number }) => (
  <Grid
    lines={J_LINES}
    size={size}
    colorAt={(r, c, ch) => (ch === " " ? undefined : STATIC[r + 1]?.[c])}
  />
));

// ANSI-Shadow "J" — block fill only. Confetti colors are rolled weighted-random
// per `seed` (seed 1 reproduces the exported PNG), with the same hard
// drop-shadow as the wordmark. Replaces the old solid 4×3 block mark.
const ANSI_J_LINES = ["     ██", "     ██", "     ██", "██   ██", " █████ "];
export const BlockLogo = React.memo(({ size = 12, seed = 1 }: { size?: number; seed?: number }) => {
  // Roll once per seed so colors stay stable across re-renders.
  const grid = React.useMemo(() => {
    const rng = mulberry32(seed);
    return ANSI_J_LINES.map((line) =>
      [...line].map((ch) => (ch === " " ? undefined : pickWeighted(rng))),
    );
  }, [seed]);
  // Scale the hard shadow with size so it stays subtle at small header sizes
  // (a fixed 5px offset overwhelms an 8px glyph).
  const shadow = Math.max(2, Math.round(size * 0.55));
  return <Grid lines={ANSI_J_LINES} size={size} colorAt={(r, c) => grid[r]?.[c]} shadow={shadow} />;
});
