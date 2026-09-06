// NATIVE drawing surface: SVG paths + PanResponder + view-shot capture.
// The web build swaps this for DrawingSurface.web.tsx (a real <canvas> —
// PanResponder's mouse coordinates and view-shot are both unreliable in
// browsers/WKWebView, which made the pad dead on desktop).
import * as React from 'react';
import { View, PanResponder, Image, Platform, StyleSheet as RNStyleSheet } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import ViewShot from 'react-native-view-shot';
import { strokePath, type Stroke } from './drawingModel';

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
    /** Fires whenever stroke count changes (enables/disables undo & save). */
    onStrokesChange?: (count: number) => void;
    /** The background source finished loading (ok) or failed — Save waits for it (#161). */
    onBackgroundLoad?: (uri: string, ok: boolean) => void;
}

// Path geometry lives in drawingModel.ts (shared with the web pad, tested
// there): a two-point flick is a line, not a dot (#210).
export { strokePath };

export const DrawingSurface = React.forwardRef<DrawingSurfaceHandle, DrawingSurfaceProps>((props, ref) => {
    const [strokes, setStrokes] = React.useState<Stroke[]>([]);
    const [current, setCurrent] = React.useState<Stroke | null>(null);
    const shotRef = React.useRef<ViewShot>(null);
    const sizeRef = React.useRef({ width: 0, height: 0 });
    const currentRef = React.useRef<Stroke | null>(null);
    const penRef = React.useRef(props.penColor);
    const thickRef = React.useRef(props.thickness);
    penRef.current = props.penColor;
    thickRef.current = props.thickness;
    const notify = props.onStrokesChange;

    const responder = React.useMemo(() => PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: (evt) => {
            const { locationX, locationY } = evt.nativeEvent;
            const stroke: Stroke = { color: penRef.current, width: thickRef.current, points: [{ x: locationX, y: locationY }] };
            currentRef.current = stroke;
            setCurrent(stroke);
        },
        onPanResponderMove: (evt) => {
            const s = currentRef.current;
            if (!s) return;
            const { locationX, locationY } = evt.nativeEvent;
            const lastPt = s.points[s.points.length - 1];
            if (Math.abs(lastPt.x - locationX) < 1 && Math.abs(lastPt.y - locationY) < 1) return;
            s.points.push({ x: locationX, y: locationY });
            setCurrent({ ...s });
        },
        onPanResponderRelease: () => {
            const s = currentRef.current;
            currentRef.current = null;
            setCurrent(null);
            if (s) setStrokes(prev => { const next = [...prev, s]; notify?.(next.length); return next; });
        },
        onPanResponderTerminate: () => {
            const s = currentRef.current;
            currentRef.current = null;
            setCurrent(null);
            if (s) setStrokes(prev => { const next = [...prev, s]; notify?.(next.length); return next; });
        },
    }), [notify]);

    React.useImperativeHandle(ref, () => ({
        undo: () => setStrokes(prev => { const next = prev.slice(0, -1); notify?.(next.length); return next; }),
        clear: () => { setStrokes([]); notify?.(0); },
        isEmpty: () => strokes.length === 0 && !current,
        capture: async () => {
            if (!shotRef.current?.capture) throw new Error('capture unavailable');
            const uri = await shotRef.current.capture();
            return { uri, width: Math.round(sizeRef.current.width), height: Math.round(sizeRef.current.height) };
        },
    }), [strokes.length, current, notify]);

    const all = current ? [...strokes, current] : strokes;

    return (
        <ViewShot
            ref={shotRef}
            style={{ flex: 1 }}
            options={{ format: 'png', quality: 1, result: Platform.OS === 'web' ? 'data-uri' : 'tmpfile' }}
        >
            <View
                style={{ flex: 1, backgroundColor: props.paper }}
                onLayout={(e) => { sizeRef.current = { width: e.nativeEvent.layout.width, height: e.nativeEvent.layout.height }; }}
                {...responder.panHandlers}
            >
                {props.bgImage && (
                    <Image
                        key={props.bgImage}
                        source={{ uri: props.bgImage }}
                        style={[RNStyleSheet.absoluteFill, { resizeMode: 'contain' }]}
                        onLoad={() => props.onBackgroundLoad?.(props.bgImage!, true)}
                        onError={() => props.onBackgroundLoad?.(props.bgImage!, false)}
                    />
                )}
                <Svg style={RNStyleSheet.absoluteFill} pointerEvents="none">
                    {all.map((s, i) => (
                        <Path key={i} d={strokePath(s.points)} stroke={s.color} strokeWidth={s.width} strokeLinecap="round" strokeLinejoin="round" fill="none" />
                    ))}
                </Svg>
            </View>
        </ViewShot>
    );
});
