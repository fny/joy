// WEB drawing surface: a real <canvas> with pointer events. RNW's
// PanResponder doesn't deliver usable mouse coordinates in browsers/WKWebView
// and view-shot capture is unreliable there — this made the draw pad dead on
// desktop. Canvas gives smooth pointer-captured ink and a trivially correct
// export (toDataURL), no extra deps.
import * as React from 'react';
import { isLatest, nextGen, useLatestKey } from '@/utils/latest';

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

interface Stroke {
    color: string;
    width: number;
    points: Array<{ x: number; y: number }>;
}

function drawStroke(ctx: CanvasRenderingContext2D, s: Stroke): void {
    if (s.points.length === 0) return;
    ctx.strokeStyle = s.color;
    ctx.lineWidth = s.width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    const pts = s.points;
    if (pts.length < 3) {
        // Dot: round cap paints a circle over a hairline segment.
        ctx.moveTo(pts[0].x, pts[0].y);
        ctx.lineTo(pts[0].x + 0.1, pts[0].y + 0.1);
    } else {
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length - 1; i++) {
            ctx.quadraticCurveTo(pts[i].x, pts[i].y, (pts[i].x + pts[i + 1].x) / 2, (pts[i].y + pts[i + 1].y) / 2);
        }
        ctx.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
    }
    ctx.stroke();
}

export const DrawingSurface = React.forwardRef<DrawingSurfaceHandle, DrawingSurfaceProps>((props, ref) => {
    const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
    const wrapRef = React.useRef<HTMLDivElement | null>(null);
    const strokesRef = React.useRef<Stroke[]>([]);
    const currentRef = React.useRef<Stroke | null>(null);
    const bgImgRef = React.useRef<HTMLImageElement | null>(null);
    const sizeRef = React.useRef({ width: 0, height: 0 });
    const propsRef = React.useRef(props);
    propsRef.current = props;

    const redraw = React.useCallback(() => {
        const canvas = canvasRef.current;
        const ctx = canvas?.getContext('2d');
        if (!canvas || !ctx) return;
        const { width, height } = sizeRef.current;
        const dpr = window.devicePixelRatio || 1;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.fillStyle = propsRef.current.paper;
        ctx.fillRect(0, 0, width, height);
        const img = bgImgRef.current;
        if (img && img.complete && img.naturalWidth > 0) {
            // contain-fit, centered
            const scale = Math.min(width / img.naturalWidth, height / img.naturalHeight);
            const w = img.naturalWidth * scale, h = img.naturalHeight * scale;
            ctx.drawImage(img, (width - w) / 2, (height - h) / 2, w, h);
        }
        for (const s of strokesRef.current) drawStroke(ctx, s);
        if (currentRef.current) drawStroke(ctx, currentRef.current);
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

    const pos = (e: React.PointerEvent): { x: number; y: number } => {
        const r = canvasRef.current!.getBoundingClientRect();
        return { x: e.clientX - r.left, y: e.clientY - r.top };
    };

    const onPointerDown = (e: React.PointerEvent) => {
        if (e.button !== 0 && e.pointerType === 'mouse') return;
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        currentRef.current = { color: propsRef.current.penColor, width: propsRef.current.thickness, points: [pos(e)] };
        redraw();
    };
    const onPointerMove = (e: React.PointerEvent) => {
        const s = currentRef.current;
        if (!s) return;
        const p = pos(e);
        const last = s.points[s.points.length - 1];
        if (Math.abs(last.x - p.x) < 1 && Math.abs(last.y - p.y) < 1) return;
        s.points.push(p);
        redraw();
    };
    const endStroke = () => {
        const s = currentRef.current;
        currentRef.current = null;
        if (s) {
            strokesRef.current = [...strokesRef.current, s];
            propsRef.current.onStrokesChange?.(strokesRef.current.length);
        }
        redraw();
    };

    React.useImperativeHandle(ref, () => ({
        undo: () => {
            strokesRef.current = strokesRef.current.slice(0, -1);
            propsRef.current.onStrokesChange?.(strokesRef.current.length);
            redraw();
        },
        clear: () => {
            strokesRef.current = [];
            propsRef.current.onStrokesChange?.(0);
            redraw();
        },
        isEmpty: () => strokesRef.current.length === 0 && !currentRef.current,
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
