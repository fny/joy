// Full-screen drawing pad (an attachment type): finger/mouse sketches for the
// composer. The actual ink surface is platform-split (DrawingSurface):
// native = SVG paths + PanResponder + view-shot; web = a real <canvas> with
// pointer events (PanResponder mouse coords + view-shot are unreliable in
// browsers — the pad was dead on desktop before the split). Export is PNG.
import * as React from 'react';
import { View, Text, Pressable, Platform } from 'react-native';
import { useLocalSearchParams, router } from 'expo-router';
import Ionicons from '@expo/vector-icons/Ionicons';
import * as Clipboard from 'expo-clipboard';
import * as ImagePicker from 'expo-image-picker';
import { StyleSheet } from 'react-native-unistyles';
import { Modal } from '@/modal';
import { t } from '@/text';
import { useDrawingResult } from '@/hooks/useDrawingResult';
import { DrawingSurface, type DrawingSurfaceHandle } from '@/components/DrawingSurface';
import { canSaveDrawing } from '@/utils/drawingSave';

const PEN_COLORS = ['#000000', '#FF3B30', '#007AFF', '#FFCC00', '#FFFFFF'] as const;
const THICKNESSES = [2, 4, 7, 12] as const; // medium (4) is the default
const DEFAULT_THICKNESS = 4;

export default React.memo(function DrawScreen() {
    const params = useLocalSearchParams<{ id: string }>();
    const sessionId = String(params.id ?? '');

    const surfaceRef = React.useRef<DrawingSurfaceHandle>(null);
    const [strokeCount, setStrokeCount] = React.useState(0);
    const [penColor, setPenColor] = React.useState<string>('#000000');
    const [thickness, setThickness] = React.useState<number>(DEFAULT_THICKNESS);
    const [darkPaper, setDarkPaper] = React.useState(false);
    // Annotation background: pasted or picked image rendered UNDER the ink and
    // captured with it — "paste a screenshot, draw on top" is the core flow.
    const [bgImage, setBgImage] = React.useState<string | null>(null);
    // The surface loads the background asynchronously; capture paints only
    // what has loaded. Save is enabled once the surface reports THIS source
    // loaded, so a fast Save after pasting a large screenshot cannot export a
    // blank or previous background (#161). A failed load clears the choice.
    const [loadedBgImage, setLoadedBgImage] = React.useState<string | null>(null);
    const onBackgroundLoad = React.useCallback((uri: string, ok: boolean) => {
        if (ok) { setLoadedBgImage(uri); return; }
        setBgImage((current) => (current === uri ? null : current));
        Modal.alert(t('common.error'), t('imageUpload.pasteNoImageMessage'), [{ text: t('common.ok') }]);
    }, []);
    const [saving, setSaving] = React.useState(false);

    const save = React.useCallback(async () => {
        if (saving || !surfaceRef.current) return;
        if (!canSaveDrawing({ strokeCount, bgImage, loadedBgImage, saving })) return;
        setSaving(true);
        try {
            const shot = await surfaceRef.current.capture();
            useDrawingResult.getState().deposit(sessionId, {
                id: `draw-${Date.now()}`,
                uri: shot.uri,
                width: shot.width,
                height: shot.height,
                mimeType: 'image/png',
                size: 0,
                name: `drawing-${new Date().toISOString().replace(/[:.]/g, '-')}.png`,
            });
            router.back();
        } catch (e) {
            console.error('drawing capture failed', e);
            setSaving(false);
        }
    }, [saving, sessionId, strokeCount, bgImage, loadedBgImage]);

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
    const canSave = canSaveDrawing({ strokeCount, bgImage, loadedBgImage, saving });

    return (
        <View style={[styles.container, { backgroundColor: paper }]}>
            {/* Canvas fills the screen (terminal-view pattern: no header) */}
            <DrawingSurface
                ref={surfaceRef}
                penColor={penColor}
                thickness={thickness}
                paper={paper}
                bgImage={bgImage}
                onBackgroundLoad={onBackgroundLoad}
                onStrokesChange={setStrokeCount}
            />

            {/* Controls overlay */}
            <View style={styles.topBar}>
                <Pressable onPress={() => router.back()} hitSlop={10} style={styles.roundBtn}>
                    <Ionicons name="close" size={20} color={chromeOnPaper} />
                </Pressable>
                <View style={styles.topRight}>
                    <Pressable onPress={pickBackground} hitSlop={10} style={styles.roundBtn}>
                        <Ionicons name="image-outline" size={19} color={bgImage ? '#34C759' : chromeOnPaper} />
                    </Pressable>
                    <Pressable onPress={() => surfaceRef.current?.undo()} hitSlop={10} style={styles.roundBtn} disabled={strokeCount === 0}>
                        <Ionicons name="arrow-undo-outline" size={19} color={strokeCount ? chromeOnPaper : '#88888880'} />
                    </Pressable>
                    <Pressable onPress={() => surfaceRef.current?.clear()} hitSlop={10} style={styles.roundBtn} disabled={strokeCount === 0}>
                        <Ionicons name="trash-outline" size={19} color={strokeCount ? chromeOnPaper : '#88888880'} />
                    </Pressable>
                    <Pressable onPress={() => setDarkPaper(v => !v)} hitSlop={10} style={styles.roundBtn}>
                        <Ionicons name={darkPaper ? 'sunny-outline' : 'moon-outline'} size={19} color={chromeOnPaper} />
                    </Pressable>
                    <Pressable onPress={() => void save()} hitSlop={10} style={[styles.roundBtn, styles.saveBtn]} disabled={saving || !canSave}>
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
