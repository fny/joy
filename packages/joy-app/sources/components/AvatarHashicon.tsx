import * as React from 'react';
import { View } from 'react-native';
import Svg, { Polygon, Rect } from 'react-native-svg';
import { BLAKE2s } from '@stablelib/blake2s';
import { useLocalSetting } from '@/sync/storage';
// hashicon's data tables are plain JS/JSON — safe to import on every platform.
import { DefaultParams } from '@emeraldpay/hashicon/lib/params';
import { StandardFigures } from '@emeraldpay/hashicon/lib/figures';
import { Shapes } from '@emeraldpay/hashicon/lib/shapes';
import { Sprites } from '@emeraldpay/hashicon/lib/sprite';

/**
 * Hashicon identicon (github.com/emeraldpay/hashicon), rendered with
 * react-native-svg instead of the library's <canvas> renderer so ONE
 * implementation covers iOS, Android, and web. This is a 1:1 port of
 * lib/renderer.js: same blake2s-16 keyed hash, same param mapping, same 28
 * sprite triangles with a base fill + optional figure-overlay fill — the
 * output matches the upstream canvas pixel-for-pixel (modulo antialiasing).
 */

const HASH_KEY = new TextEncoder().encode('emerald/hashicon');

function hashValues(id: string): Uint16Array {
    const hasher = new BLAKE2s(16, { key: HASH_KEY });
    hasher.update(new TextEncoder().encode(id));
    // Matches upstream: new Uint16Array(Uint8Array) widens each BYTE to a
    // uint16 element (16 values, 0–255) — it does not reinterpret pairs.
    return new Uint16Array(hasher.digest());
}

function processParam(param: { min: number; max: number }, value: number): number {
    return param.min + (value % (param.max - param.min));
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

export const AvatarHashicon = React.memo((props: Props) => {
    const size = props.size ?? 48;
    const polygons = React.useMemo(() => {
        // hashicon's Params type marks every field optional; DefaultParams
        // populates them all — assert the concrete shape once here.
        const p = DefaultParams as {
            hue: { min: number; max: number };
            saturation: { min: number; max: number };
            lightness: { min: number; max: number };
            shift: { min: number; max: number };
            figureAlpha: { min: number; max: number };
            variation: { min: number; max: number; enabled: boolean };
            light: { top: number; right: number; left: number; enabled: boolean };
        };
        const h = hashValues(props.id);
        // Colors come STRAIGHT from the joy palette (+shade steps) instead of
        // free HSL: base color from the hash, per-triangle facet = shade step
        // driven by the sprite's light direction + hash variation; the figure
        // overlay uses a shifted palette color at hash alpha.
        const baseIdx = h[0] % JOY_PALETTE.length;
        const shiftSteps = 1 + (h[3] % (JOY_PALETTE.length - 1));
        const figureAlpha = processParam(p.figureAlpha, h[4]);
        const figure = StandardFigures[h[5] % StandardFigures.length];
        const lightShade: Record<string, number> = { top: 1, right: -1, left: 0 };
        const base = props.monochrome ? shade('#888888', 0) : JOY_PALETTE[baseIdx];
        const overlayColor = props.monochrome ? '#444444' : JOY_PALETTE[(baseIdx + shiftSteps) % JOY_PALETTE.length];

        const out: { points: string; fill: string; alpha?: number }[] = [];
        Sprites.forEach((line: any, i: number) => {
            if (line.hidden) return; // empty path — upstream's fills paint nothing
            const variation = p.variation.enabled ? (Math.round(h[6] / (i + 1)) % 2) : 0;
            // Facet shading: light direction picks the neighborhood, variation
            // nudges within it — always one of the fixed SHADES steps.
            const stepIdx = Math.max(0, Math.min(SHADES.length - 1, 2 + (lightShade[line.light] ?? 0) + (variation ? 1 : 0) - 1));
            const shape = Shapes[line.shape];
            const points = [
                `${shape.x1 + line.x},${shape.y1 + line.y}`,
                `${shape.x2 + line.x},${shape.y2 + line.y}`,
                `${shape.x3 + line.x},${shape.y3 + line.y}`,
            ].join(' ');
            out.push({ points, fill: shade(base, SHADES[stepIdx]) });
            if (figure[i] > 0) {
                const alpha = figure[i] * figureAlpha / 1000;
                out.push({ points, fill: shade(overlayColor, SHADES[stepIdx]), alpha: Math.min(0.85, alpha) });
            }
        });
        return out;
    }, [props.id, props.monochrome]);

    return (
        <Svg width={size} height={size} viewBox="0 0 1 1">
            {polygons.map((poly, i) => (
                <Polygon key={i} points={poly.points} fill={poly.fill} fillOpacity={poly.alpha ?? 1} />
            ))}
        </Svg>
    );
});

// ── grid variants: squares / circles of confetti squares ─────────────────────
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

export type AvatarVariant = 'hashicon' | 'squares' | 'circles';

/** The variant the user picked in Appearance → Identicons. */
export const AvatarIdenticon = React.memo((props: Props) => {
    const variant = useLocalSetting('avatarVariant');
    if (variant === 'squares') return <AvatarSquares {...props} />;
    if (variant === 'circles') return <AvatarCircles {...props} />;
    return <AvatarHashicon {...props} />;
});
