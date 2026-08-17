import * as React from 'react';
import { View } from 'react-native';
import Svg, { Rect } from 'react-native-svg';
import { BLAKE2s } from '@stablelib/blake2s';
import { useLocalSetting } from '@/sync/storage';

/**
 * Joy identicons: a deterministic confetti grid keyed by a blake2s hash of the
 * id, drawn with react-native-svg so ONE implementation covers iOS, Android and
 * web. Two variants — circles (default) and squares — differ only in the clip.
 */

// Keyed deliberately with the old hashicon string: the key seeds every grid, so
// changing it would reshuffle the confetti of every existing avatar. It is a
// salt, not a reference to the retired variant.
const HASH_KEY = new TextEncoder().encode('emerald/hashicon');

function hashValues(id: string): Uint16Array {
    const hasher = new BLAKE2s(16, { key: HASH_KEY });
    hasher.update(new TextEncoder().encode(id));
    return new Uint16Array(hasher.digest());
}

// The joy logotype palette (JoyLogotype.tsx) — identicon colors come from
// EXACTLY this set, plus deterministic darken/lighten steps, so every avatar
// reads as family with the logo and the joy text confetti.
export const JOY_PALETTE = [
    '#ff2d95', // magenta
    '#ff8a00', // orange
    '#ffe600', // yellow
    '#00e5a0', // cyan
    '#00b3ff', // blue
    '#8a2dff', // purple
    '#ff4040', // red
    '#2dd4bf', // darkCyan
] as const;

/** Blend a palette hex toward white (t>0) or black (t<0). t ∈ [-1, 1]. */
export function shade(hex: string, t: number): string {
    const n = parseInt(hex.slice(1), 16);
    const ch = (v: number) => {
        const target = t >= 0 ? 255 : 0;
        const f = Math.abs(t);
        return Math.round(v + (target - v) * f);
    };
    const r = ch((n >> 16) & 255), g = ch((n >> 8) & 255), b = ch(n & 255);
    return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}

// Shade steps used by all variants: two darkened, base, two lightened.
const SHADES = [-0.35, -0.18, 0, 0.18, 0.35];

/** Tiny deterministic PRNG (xorshift32) seeded from the id hash — the grid
 *  variants need more values than the 16 hash bytes provide. */
function prngFrom(h: Uint16Array): () => number {
    let s = ((h[0] << 24) ^ (h[1] << 16) ^ (h[2] << 8) ^ h[3]) >>> 0 || 0x9e3779b9;
    return () => {
        s ^= s << 13; s >>>= 0;
        s ^= s >> 17;
        s ^= s << 5; s >>>= 0;
        return s / 0xffffffff;
    };
}

interface Props {
    id: string;
    size?: number;
    square?: boolean;
    monochrome?: boolean;
    title?: boolean;
}

// ── grid variants: circles / squares of confetti squares ─────────────────────
// The joy logotype is a pixel grid of palette-colored cells; these identicons
// are the same material — a 6×6 confetti of palette+shade squares, keyed by
// the id hash. No shadows. 'squares' keeps the outer square (soft corners),
// 'circles' clips the same grid to a circle.

const GRID = 6;

function gridCells(id: string): { fill: string }[] {
    const h = hashValues(id);
    const rand = prngFrom(h);
    // A dominant color anchors the icon (like a wordmark letter), the rest is
    // confetti — pure uniform confetti made every avatar look the same.
    const dominant = h[0] % JOY_PALETTE.length;
    const cells: { fill: string }[] = [];
    for (let i = 0; i < GRID * GRID; i++) {
        const useDominant = rand() < 0.45;
        const color = JOY_PALETTE[useDominant ? dominant : Math.floor(rand() * JOY_PALETTE.length)];
        const s = SHADES[Math.floor(rand() * SHADES.length)];
        cells.push({ fill: shade(color, s) });
    }
    return cells;
}

function GridSvg(props: { id: string; size: number }) {
    const cells = React.useMemo(() => gridCells(props.id), [props.id]);
    const cell = props.size / GRID;
    return (
        <Svg width={props.size} height={props.size}>
            {cells.map((c, i) => (
                <Rect
                    key={i}
                    x={(i % GRID) * cell}
                    y={Math.floor(i / GRID) * cell}
                    width={cell + 0.5}
                    height={cell + 0.5}
                    fill={c.fill}
                />
            ))}
        </Svg>
    );
}

export const AvatarSquares = React.memo((props: Props) => {
    const size = props.size ?? 48;
    return (
        <View style={{ width: size, height: size, borderRadius: Math.round(size * 0.14), overflow: 'hidden' }}>
            <GridSvg id={props.id} size={size} />
        </View>
    );
});

export const AvatarCircles = React.memo((props: Props) => {
    const size = props.size ?? 48;
    return (
        <View style={{ width: size, height: size, borderRadius: size / 2, overflow: 'hidden' }}>
            <GridSvg id={props.id} size={size} />
        </View>
    );
});

export type AvatarVariant = 'circles' | 'squares';

/** The variant the user picked in Appearance → Identicons (circles default). */
export const AvatarIdenticon = React.memo((props: Props) => {
    const variant = useLocalSetting('avatarVariant');
    if (variant === 'squares') return <AvatarSquares {...props} />;
    return <AvatarCircles {...props} />;
});
