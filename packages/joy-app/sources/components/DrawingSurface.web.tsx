// WEB drawing surface: a real <canvas> with pointer events. RNW's
// PanResponder doesn't deliver usable mouse coordinates in browsers/WKWebView
// and view-shot capture is unreliable there — this made the draw pad dead on
// desktop. Canvas gives smooth pointer-captured ink and a trivially correct
// export (toDataURL), no extra deps.
//
// Coordinates: ink is stored in ONE fixed drawing space — the pad's size when
// the first stroke began — and the whole composite (paper, contain-fit
// background image, strokes) is mapped into the current viewport with the
// same contain transform (drawingModel.containFit). Before, the image was
// re-fit to every new size while the strokes kept their pixel positions, so
// rotating or resizing the pad slid a screenshot away from its annotations
// and capture exported the mismatch (#213).
import * as React from 'react';
import { isLatest, nextGen, useLatestKey } from '@/utils/latest';
import { InkPointers, containFit, toDoc, traceStroke, type Fit, type Point, type Stroke } from './drawingModel';

export interface DrawingSurfaceHandle {
    undo(): void;
    clear(): void;
    isEmpty(): boolean;
    capture(): Promise<{ uri: string; width: number; height: number }>;
}

export interface DrawingSurfaceProps {
    penColor: string;
    thickness: number;
    paper: string;
    bgImage: string | null;
    onStrokesChange?: (count: number) => void;
    /** The background source finished loading (ok) or failed — Save waits for it (#161). */
    onBackgroundLoad?: (uri: string, ok: boolean) => void;
}

function drawStroke(ctx: CanvasRenderingContext2D, s: Stroke): void {
    if (s.points.length === 0) return;
    ctx.strokeStyle = s.color;
    ctx.lineWidth = s.width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    traceStroke(ctx, s.points);
    ctx.stroke();
}

export const DrawingSurface = React.forwardRef<DrawingSurfaceHandle, DrawingSurfaceProps>((props, ref) => {
    const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
    const wrapRef = React.useRef<HTMLDivElement | null>(null);
    const strokesRef = React.useRef<Stroke[]>([]);
    const inkRef = React.useRef(new InkPointers());
    const bgImgRef = React.useRef<HTMLImageElement | null>(null);
    const sizeRef = React.useRef({ width: 0, height: 0 });
    // The drawing space: fixed by the first stroke, released when the pad is
    // empty again so a blank pad simply follows its container.
    const docRef = React.useRef<{ width: number; height: number } | null>(null);
    const propsRef = React.useRef(props);
    propsRef.current = props;

    const fit = (): Fit => {
        const { width, height } = sizeRef.current;
        const doc = docRef.current;
        return doc ? containFit(doc.width, doc.height, width, height) : { scale: 1, ox: 0, oy: 0 };
    };

    const redraw = React.useCallback(() => {
        const canvas = canvasRef.current;
        const ctx = canvas?.getContext('2d');
        if (!canvas || !ctx) return;
        const { width, height } = sizeRef.current;
        const dpr = window.devicePixelRatio || 1;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.fillStyle = propsRef.current.paper;
        ctx.fillRect(0, 0, width, height);
        // Everything below is in drawing coordinates: one transform for the
        // image AND the ink, so they scale and move together (#213).
        const f = fit();
        const doc = docRef.current ?? { width, height };
        ctx.setTransform(dpr * f.scale, 0, 0, dpr * f.scale, dpr * f.ox, dpr * f.oy);
        const img = bgImgRef.current;
        if (img && img.complete && img.naturalWidth > 0) {
            // contain-fit, centered — within the DRAWING space
            const scale = Math.min(doc.width / img.naturalWidth, doc.height / img.naturalHeight);
            const w = img.naturalWidth * scale, h = img.naturalHeight * scale;
            ctx.drawImage(img, (doc.width - w) / 2, (doc.height - h) / 2, w, h);
        }
        for (const s of strokesRef.current) drawStroke(ctx, s);
        const current = inkRef.current.current();
        if (current) drawStroke(ctx, current);
    }, []);

    // Size the backing store to the container × devicePixelRatio.
    React.useEffect(() => {
        const wrap = wrapRef.current;
        const canvas = canvasRef.current;
        if (!wrap || !canvas) return;
        const resize = () => {
            const r = wrap.getBoundingClientRect();
            sizeRef.current = { width: r.width, height: r.height };
            const dpr = window.devicePixelRatio || 1;
            canvas.width = Math.max(1, Math.round(r.width * dpr));
            canvas.height = Math.max(1, Math.round(r.height * dpr));
            canvas.style.width = `${r.width}px`;
            canvas.style.height = `${r.height}px`;
            redraw();
        };
        resize();
        const obs = new ResizeObserver(resize);
        obs.observe(wrap);
        return () => obs.disconnect();
    }, [redraw]);

    // Background image element (data: or blob/file uri). Each source change
    // is a generation: a slower earlier image whose onload fires after the
    // current one (or after the background was removed) must not paint (#211).
    const bgKey = useLatestKey('drawing-bg');
    React.useEffect(() => {
        const gen = nextGen(bgKey);
        bgImgRef.current = null; // the previous image never lingers under a new source
        redraw();
        if (!props.bgImage) return;
        const img = new Image();
        const src = props.bgImage;
        img.onload = () => {
            if (!isLatest(bgKey, gen)) return;
            bgImgRef.current = img;
            redraw();
            propsRef.current.onBackgroundLoad?.(src, true);
        };
        img.onerror = () => {
            if (!isLatest(bgKey, gen)) return;
            propsRef.current.onBackgroundLoad?.(src, false);
        };
        img.src = src;
    }, [props.bgImage, redraw, bgKey]);

    // Paper change repaints.
    React.useEffect(() => { redraw(); }, [props.paper, redraw]);

    /** Pointer position in DRAWING coordinates. */
    const pos = (e: React.PointerEvent): Point => {
        const r = canvasRef.current!.getBoundingClientRect();
        return toDoc(fit(), { x: e.clientX - r.left, y: e.clientY - r.top });
    };

    const onPointerDown = (e: React.PointerEvent) => {
        if (e.button !== 0 && e.pointerType === 'mouse') return;
        // The first stroke pins the drawing space to the pad's current size.
        if (!docRef.current) docRef.current = { ...sizeRef.current };
        // A second pointer while one is drawing is ignored — it must not
        // replace, feed, or end the active stroke (#212).
        if (!inkRef.current.begin(e.pointerId, pos(e), { color: propsRef.current.penColor, width: propsRef.current.thickness })) return;
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        redraw();
    };
    const onPointerMove = (e: React.PointerEvent) => {
        if (inkRef.current.extend(e.pointerId, pos(e))) redraw();
    };
    const endStroke = (e: React.PointerEvent) => {
        const s = inkRef.current.end(e.pointerId);
        if (!s) return;
        strokesRef.current = [...strokesRef.current, s];
        propsRef.current.onStrokesChange?.(strokesRef.current.length);
        redraw();
    };

    const setStrokes = (next: Stroke[]) => {
        strokesRef.current = next;
        if (next.length === 0 && !inkRef.current.current()) docRef.current = null;
        propsRef.current.onStrokesChange?.(next.length);
        redraw();
    };

    React.useImperativeHandle(ref, () => ({
        undo: () => setStrokes(strokesRef.current.slice(0, -1)),
        clear: () => setStrokes([]),
        isEmpty: () => strokesRef.current.length === 0 && !inkRef.current.current(),
        capture: async () => {
            const canvas = canvasRef.current;
            if (!canvas) throw new Error('capture unavailable');
            redraw();
            return {
                uri: canvas.toDataURL('image/png'),
                width: Math.round(sizeRef.current.width),
                height: Math.round(sizeRef.current.height),
            };
        },
    }), [redraw]);

    return (
        <div ref={wrapRef} style={{ flex: 1, position: 'relative', overflow: 'hidden', backgroundColor: props.paper }}>
            <canvas
                ref={canvasRef}
                style={{ position: 'absolute', inset: 0, touchAction: 'none', cursor: 'crosshair' }}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={endStroke}
                onPointerCancel={endStroke}
            />
        </div>
    );
});
