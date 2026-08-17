// Full-screen drawing pad (an attachment type): finger sketches for the
// composer. Strokes render as SVG paths smoothed with the midpoint-quadratic
// technique (each segment curves toward the midpoint of consecutive touch
// samples — the standard trick for making raw touch input feel ink-like).
// Export is PNG via view-shot: SVG would be the nicer editable format, but the
// attachment pipeline (previews, thumbhash, upload sizing) is raster-only, so
// shipping SVG through it would be fragile — per spec, PNG it is.
import * as React from 'react';
import { View, Text, Pressable, PanResponder, Platform, Image } from 'react-native';
import { useLocalSearchParams, router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import Svg, { Path } from 'react-native-svg';
import ViewShot from 'react-native-view-shot';
import * as Clipboard from 'expo-clipboard';
import * as ImagePicker from 'expo-image-picker';
import { StyleSheet } from 'react-native-unistyles';
import { Modal } from '@/modal';
import { t } from '@/text';
import { useDrawingResult } from '@/hooks/useDrawingResult';

const PEN_COLORS = ['#000000', '#FF3B30', '#007AFF', '#FFCC00', '#FFFFFF'] as const;
const THICKNESSES = [2, 4, 7, 12] as const; // medium (4) is the default
const DEFAULT_THICKNESS = 4;

interface Stroke {
    color: string;
    width: number;
    points: Array<{ x: number; y: number }>;
}

/** Midpoint-quadratic smoothing: M p0, then Q(p[i], mid(p[i], p[i+1])). */
function strokePath(points: Array<{ x: number; y: number }>): string {
    if (points.length === 0) return '';
    if (points.length < 3) {
        const p = points[0];
        // Dot: tiny line so the round cap paints a circle.
        return `M ${p.x} ${p.y} L ${p.x + 0.1} ${p.y + 0.1}`;
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

export default React.memo(function DrawScreen() {
    const params = useLocalSearchParams<{ id: string }>();
    const sessionId = String(params.id ?? '');

    const [strokes, setStrokes] = React.useState<Stroke[]>([]);
    const [current, setCurrent] = React.useState<Stroke | null>(null);
    const [penColor, setPenColor] = React.useState<string>('#000000');
    const [thickness, setThickness] = React.useState<number>(DEFAULT_THICKNESS);
    const [darkPaper, setDarkPaper] = React.useState(false);
    // Annotation background: pasted or picked image rendered UNDER the ink and
    // captured with it — "paste a screenshot, draw on top" is the core flow.
    const [bgImage, setBgImage] = React.useState<string | null>(null);
    const [saving, setSaving] = React.useState(false);
    const shotRef = React.useRef<ViewShot>(null);
    const sizeRef = React.useRef({ width: 0, height: 0 });

    // Refs mirror the state the responder callbacks need — PanResponder is
    // created once and would otherwise close over stale values.
    const currentRef = React.useRef<Stroke | null>(null);
    const penRef = React.useRef(penColor);
    const thickRef = React.useRef(thickness);
    penRef.current = penColor;
    thickRef.current = thickness;

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
            // Drop sub-pixel jitter; keeps paths small and smoothing stable.
            if (Math.abs(lastPt.x - locationX) < 1 && Math.abs(lastPt.y - locationY) < 1) return;
            s.points.push({ x: locationX, y: locationY });
            setCurrent({ ...s });
        },
        onPanResponderRelease: () => {
            const s = currentRef.current;
            currentRef.current = null;
            setCurrent(null);
            if (s) setStrokes(prev => [...prev, s]);
        },
        onPanResponderTerminate: () => {
            const s = currentRef.current;
            currentRef.current = null;
            setCurrent(null);
            if (s) setStrokes(prev => [...prev, s]);
        },
    }), []);

    const save = React.useCallback(async () => {
        if (saving || !shotRef.current?.capture) return;
        setSaving(true);
        try {
            const uri = await shotRef.current.capture();
            const { width, height } = sizeRef.current;
            useDrawingResult.getState().deposit(sessionId, {
                id: `draw-${Date.now()}`,
                uri,
                width: Math.round(width),
                height: Math.round(height),
                mimeType: 'image/png',
                size: 0,
                name: `drawing-${new Date().toISOString().replace(/[:.]/g, '-')}.png`,
            });
            router.back();
        } catch (e) {
            console.error('drawing capture failed', e);
            setSaving(false);
        }
    }, [saving, sessionId]);

    const pickBackground = React.useCallback(() => {
        const paste = async () => {
            try {
                const img = await Clipboard.getImageAsync({ format: 'png' });
                if (img?.data) setBgImage(img.data);
                else Modal.alert(t('imageUpload.pasteNoImageTitle'), t('imageUpload.pasteNoImageMessage'), [{ text: t('common.ok') }]);
            } catch (e) {
                Modal.alert(t('common.error'), String(e), [{ text: t('common.ok') }]);
            }
        };
        const library = async () => {
            try {
                const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 1 });
                if (!res.canceled && res.assets[0]?.uri) setBgImage(res.assets[0].uri);
            } catch (e) {
                Modal.alert(t('common.error'), String(e), [{ text: t('common.ok') }]);
            }
        };
        Modal.alert(t('imageUpload.attachTitle'), undefined, [
            { text: t('imageUpload.pasteImage'), onPress: () => { void paste(); } },
            ...(Platform.OS !== 'web' ? [{ text: t('imageUpload.photoLibrary'), onPress: () => { void library(); } }] : []),
            ...(bgImage ? [{ text: t('common.delete'), style: 'destructive' as const, onPress: () => setBgImage(null) }] : []),
            { text: t('common.cancel'), style: 'cancel' as const },
        ]);
    }, [bgImage]);

    const paper = darkPaper ? '#000000' : '#FFFFFF';
    const chromeOnPaper = darkPaper ? '#FFFFFF' : '#000000';
    const all = current ? [...strokes, current] : strokes;

    return (
        <View style={[styles.container, { backgroundColor: paper }]}>
            {/* Canvas fills the screen (terminal-view pattern: no header) */}
            <ViewShot
                ref={shotRef}
                style={styles.canvasWrap}
                options={{ format: 'png', quality: 1, result: Platform.OS === 'web' ? 'data-uri' : 'tmpfile' }}
            >
                <View
                    style={[styles.canvas, { backgroundColor: paper }]}
                    onLayout={(e) => { sizeRef.current = { width: e.nativeEvent.layout.width, height: e.nativeEvent.layout.height }; }}
                    {...responder.panHandlers}
                >
                    {bgImage && (
                        <Image
                            source={{ uri: bgImage }}
                            style={[StyleSheet.absoluteFill as any, { resizeMode: 'contain' }]}
                        />
                    )}
                    <Svg style={StyleSheet.absoluteFill as any} pointerEvents="none">
                        {all.map((s, i) => (
                            <Path
                                key={i}
                                d={strokePath(s.points)}
                                stroke={s.color}
                                strokeWidth={s.width}
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                fill="none"
                            />
                        ))}
                    </Svg>
                </View>
            </ViewShot>

            {/* Controls overlay */}
            <View style={styles.topBar}>
                <Pressable onPress={() => router.back()} hitSlop={10} style={styles.roundBtn}>
                    <Ionicons name="close" size={20} color={chromeOnPaper} />
                </Pressable>
                <View style={styles.topRight}>
                    <Pressable onPress={pickBackground} hitSlop={10} style={styles.roundBtn}>
                        <Ionicons name="image-outline" size={19} color={bgImage ? '#34C759' : chromeOnPaper} />
                    </Pressable>
                    <Pressable onPress={() => setStrokes(prev => prev.slice(0, -1))} hitSlop={10} style={styles.roundBtn} disabled={strokes.length === 0}>
                        <Ionicons name="arrow-undo-outline" size={19} color={strokes.length ? chromeOnPaper : '#88888880'} />
                    </Pressable>
                    <Pressable onPress={() => setStrokes([])} hitSlop={10} style={styles.roundBtn} disabled={strokes.length === 0}>
                        <Ionicons name="trash-outline" size={19} color={strokes.length ? chromeOnPaper : '#88888880'} />
                    </Pressable>
                    <Pressable onPress={() => setDarkPaper(v => !v)} hitSlop={10} style={styles.roundBtn}>
                        <Ionicons name={darkPaper ? 'sunny-outline' : 'moon-outline'} size={19} color={chromeOnPaper} />
                    </Pressable>
                    <Pressable onPress={() => void save()} hitSlop={10} style={[styles.roundBtn, styles.saveBtn]} disabled={saving || (all.length === 0 && !bgImage)}>
                        <Ionicons name="checkmark" size={20} color="#FFFFFF" />
                    </Pressable>
                </View>
            </View>

            <View style={styles.bottomBar}>
                <View style={styles.swatchRow}>
                    {PEN_COLORS.map(c => (
                        <Pressable
                            key={c}
                            onPress={() => setPenColor(c)}
                            style={[
                                styles.swatch,
                                { backgroundColor: c },
                                c === '#FFFFFF' && styles.swatchOutlined,
                                penColor === c && styles.swatchActive,
                            ]}
                        />
                    ))}
                </View>
                <View style={styles.swatchRow}>
                    {THICKNESSES.map(w => (
                        <Pressable key={w} onPress={() => setThickness(w)} style={[styles.thickBtn, thickness === w && styles.thickBtnActive]}>
                            <View style={{ width: w + 4, height: w + 4, borderRadius: (w + 4) / 2, backgroundColor: chromeOnPaper }} />
                        </Pressable>
                    ))}
                </View>
            </View>
            {saving && (
                <View style={styles.savingOverlay}>
                    <Text style={styles.savingText}>saving…</Text>
                </View>
            )}
        </View>
    );
});

const styles = StyleSheet.create((theme, runtime) => ({
    container: { flex: 1 },
    canvasWrap: { flex: 1 },
    canvas: { flex: 1 },
    topBar: {
        position: 'absolute',
        top: runtime.insets.top + 8,
        left: 12,
        right: 12,
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
    },
    topRight: { flexDirection: 'row', gap: 8 },
    roundBtn: {
        width: 38, height: 38, borderRadius: 19,
        alignItems: 'center', justifyContent: 'center',
        backgroundColor: 'rgba(128,128,128,0.18)',
    },
    saveBtn: { backgroundColor: '#34C759' },
    bottomBar: {
        position: 'absolute',
        bottom: runtime.insets.bottom + 12,
        left: 0, right: 0,
        alignItems: 'center',
        gap: 10,
    },
    swatchRow: {
        flexDirection: 'row',
        gap: 10,
        backgroundColor: 'rgba(128,128,128,0.18)',
        borderRadius: 22,
        paddingHorizontal: 12,
        paddingVertical: 8,
        alignItems: 'center',
    },
    swatch: { width: 26, height: 26, borderRadius: 13 },
    swatchOutlined: { borderWidth: 1, borderColor: '#00000030' },
    swatchActive: { transform: [{ scale: 1.25 }], borderWidth: 2, borderColor: '#34C759' },
    thickBtn: {
        width: 34, height: 34, borderRadius: 17,
        alignItems: 'center', justifyContent: 'center',
    },
    thickBtnActive: { backgroundColor: 'rgba(52,199,89,0.35)' },
    savingOverlay: {
        ...StyleSheet.absoluteFillObject as any,
        alignItems: 'center', justifyContent: 'center',
        backgroundColor: 'rgba(0,0,0,0.25)',
    },
    savingText: { color: '#FFFFFF', fontSize: 15 },
}));
