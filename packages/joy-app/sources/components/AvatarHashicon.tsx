import * as React from 'react';
import Svg, { Polygon } from 'react-native-svg';
import { BLAKE2s } from '@stablelib/blake2s';
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
        const hue = processParam(p.hue, h[0]);
        const saturation = props.monochrome ? 0 : processParam(p.saturation, h[1]);
        const lightness = processParam(p.lightness, h[2]);
        const shift = processParam(p.shift, h[3]);
        const figureAlpha = processParam(p.figureAlpha, h[4]);
        const figure = StandardFigures[h[5] % StandardFigures.length];

        const out: { points: string; fill: string }[] = [];
        Sprites.forEach((line: any, i: number) => {
            if (line.hidden) return; // empty path — upstream's fills paint nothing
            const light = p.light.enabled ? (p.light as any)[line.light] : 1;
            const variation = p.variation.enabled
                ? processParam(p.variation, Math.round(h[6] / (i + 1)))
                : 0;
            const shape = Shapes[line.shape];
            const points = [
                `${shape.x1 + line.x},${shape.y1 + line.y}`,
                `${shape.x2 + line.x},${shape.y2 + line.y}`,
                `${shape.x3 + line.x},${shape.y3 + line.y}`,
            ].join(' ');
            out.push({ points, fill: `hsla(${hue + variation}, ${saturation}%, ${lightness + light}%, 1)` });
            if (figure[i] > 0) {
                const alpha = figure[i] * figureAlpha / 10;
                out.push({ points, fill: `hsla(${hue + shift + variation}, ${saturation}%, ${lightness + light}%, ${alpha})` });
            }
        });
        return out;
    }, [props.id, props.monochrome]);

    return (
        <Svg width={size} height={size} viewBox="0 0 1 1">
            {polygons.map((poly, i) => (
                <Polygon key={i} points={poly.points} fill={poly.fill} />
            ))}
        </Svg>
    );
});
