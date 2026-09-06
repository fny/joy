/**
 * Pure geometry and input rules shared by the drawing pads
 * (DrawingSurface.tsx for native SVG, DrawingSurface.web.tsx for canvas),
 * kept free of React and the DOM so they can be tested directly.
 */

export interface Point { x: number; y: number }

export interface Stroke {
    color: string;
    width: number;
    points: Point[];
}

/** A tap: a hairline segment that a round cap paints as a dot. */
const DOT_NUDGE = 0.1;

/**
 * SVG path for a stroke. One point is a dot; TWO points are the line between
 * them — they used to fall into the dot branch as well, so a quick flick
 * (grant + one move) vanished from the pad and its export (#210); three or
 * more use midpoint-quadratic smoothing: M p0, then Q(p[i], mid(p[i], p[i+1])).
 */
export function strokePath(points: Point[]): string {
    if (points.length === 0) return '';
    if (points.length === 1) {
        const p = points[0];
        return `M ${p.x} ${p.y} L ${p.x + DOT_NUDGE} ${p.y + DOT_NUDGE}`;
    }
    if (points.length === 2) {
        return `M ${points[0].x} ${points[0].y} L ${points[1].x} ${points[1].y}`;
    }
    let d = `M ${points[0].x} ${points[0].y}`;
    for (let i = 1; i < points.length - 1; i++) {
        const midX = (points[i].x + points[i + 1].x) / 2;
        const midY = (points[i].y + points[i + 1].y) / 2;
        d += ` Q ${points[i].x} ${points[i].y} ${midX} ${midY}`;
    }
    const last = points[points.length - 1];
    d += ` L ${last.x} ${last.y}`;
    return d;
}

/** The subset of CanvasRenderingContext2D path building traceStroke needs. */
export interface PathSink {
    moveTo(x: number, y: number): void;
    lineTo(x: number, y: number): void;
    quadraticCurveTo(cpx: number, cpy: number, x: number, y: number): void;
}

/** The same geometry as strokePath, issued as canvas path commands. */
export function traceStroke(ctx: PathSink, points: Point[]): void {
    if (points.length === 0) return;
    ctx.moveTo(points[0].x, points[0].y);
    if (points.length === 1) {
        ctx.lineTo(points[0].x + DOT_NUDGE, points[0].y + DOT_NUDGE);
        return;
    }
    if (points.length === 2) {
        ctx.lineTo(points[1].x, points[1].y);
        return;
    }
    for (let i = 1; i < points.length - 1; i++) {
        ctx.quadraticCurveTo(points[i].x, points[i].y, (points[i].x + points[i + 1].x) / 2, (points[i].y + points[i + 1].y) / 2);
    }
    ctx.lineTo(points[points.length - 1].x, points[points.length - 1].y);
}

export interface Fit { scale: number; ox: number; oy: number }

/**
 * Contain-fit a `docW`×`docH` drawing into a `width`×`height` viewport:
 * uniform scale, centered. The pad keeps ONE fixed drawing coordinate
 * system (the size it had when the first stroke began) and maps the whole
 * composite — background image and ink together — through this fit, so a
 * resize or rotation moves the screenshot and its annotations as one (#213).
 */
export function containFit(docW: number, docH: number, width: number, height: number): Fit {
    if (docW <= 0 || docH <= 0 || width <= 0 || height <= 0) return { scale: 1, ox: 0, oy: 0 };
    const scale = Math.min(width / docW, height / docH);
    return { scale, ox: (width - docW * scale) / 2, oy: (height - docH * scale) / 2 };
}

/** Viewport (pointer) coordinates → drawing coordinates under `fit`. */
export function toDoc(fit: Fit, p: Point): Point {
    return { x: (p.x - fit.ox) / fit.scale, y: (p.y - fit.oy) / fit.scale };
}

/** Drawing coordinates → viewport coordinates under `fit`. */
export function toView(fit: Fit, p: Point): Point {
    return { x: p.x * fit.scale + fit.ox, y: p.y * fit.scale + fit.oy };
}

/**
 * One pointer owns the stroke in progress. A second pointer touching the pad
 * while the first is down used to REPLACE the stroke: the first pointer's
 * unfinished ink was lost, both pointers' moves fed the new stroke (a line
 * between unrelated touch positions), and either release committed it and
 * ended drawing for the other (#212). Now a `begin` from another pointer is
 * ignored, and only the owning pointer's moves and release count.
 */
export class InkPointers {
    private activeId: number | null = null;
    private stroke: Stroke | null = null;

    /** Start a stroke for `pointerId`; false when another pointer owns one. */
    begin(pointerId: number, point: Point, style: { color: string; width: number }): boolean {
        if (this.activeId !== null) return false;
        this.activeId = pointerId;
        this.stroke = { color: style.color, width: style.width, points: [point] };
        return true;
    }

    /** Extend the owning pointer's stroke; false (and no change) for any other pointer or a sub-pixel move. */
    extend(pointerId: number, point: Point): boolean {
        const s = this.stroke;
        if (s === null || pointerId !== this.activeId) return false;
        const last = s.points[s.points.length - 1];
        if (Math.abs(last.x - point.x) < 1 && Math.abs(last.y - point.y) < 1) return false;
        s.points.push(point);
        return true;
    }

    /** Finish the owning pointer's stroke and hand it back; null for any other pointer. */
    end(pointerId: number): Stroke | null {
        if (pointerId !== this.activeId) return null;
        const s = this.stroke;
        this.activeId = null;
        this.stroke = null;
        return s;
    }

    current(): Stroke | null {
        return this.stroke;
    }
}
