import * as React from 'react';
import { Animated, PanResponder, Pressable, ScrollView, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { useLocalSetting } from '@/sync/storage';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { PaletteControls } from './PaletteControls';
import { AccentControls } from './AccentControls';
import { FontControls } from './FontControls';

type DevPage = 'home' | 'palette' | 'accents' | 'fonts';
const PAGE_TITLE: Record<DevPage, string> = { home: 'Dev tweaks', palette: 'Color Palette', accents: 'Accent Colors', fonts: 'Font' };

const FAB_SIZE = 52;
const MARGIN = 16;
const TAP_SLOP = 6; // movement under this counts as a tap, not a drag

// Dev-only floating button. Drag it anywhere; tap to open a panel for quickly
// trying appearance tweaks (color palette now; fonts etc. later). Gated behind
// the `devModeEnabled` local setting so it never ships to normal users.
export const DevFab = React.memo(function DevFab() {
    // Auto-on in dev builds; in prod only when the dev-mode setting is enabled.
    const devMode = __DEV__ || useLocalSetting('devModeEnabled');
    const { theme } = useUnistyles();
    const { width, height } = useWindowDimensions();
    const insets = useSafeAreaInsets();
    const [open, setOpen] = React.useState(false);
    const [page, setPage] = React.useState<DevPage>('home');
    const close = React.useCallback(() => { setOpen(false); setPage('home'); }, []);

    // Initial bottom-right position (absolute top-left coords; the view is
    // translated there). Computed once; the user drags from here.
    const pos = React.useRef({
        x: width - FAB_SIZE - MARGIN,
        y: height - FAB_SIZE - MARGIN - insets.bottom - 8,
    });
    const pan = React.useRef(new Animated.ValueXY(pos.current)).current;

    const clamp = React.useCallback((x: number, y: number) => ({
        x: Math.max(MARGIN, Math.min(x, width - FAB_SIZE - MARGIN)),
        y: Math.max(insets.top + MARGIN, Math.min(y, height - FAB_SIZE - MARGIN - insets.bottom)),
    }), [width, height, insets.top, insets.bottom]);

    const panResponder = React.useMemo(() => PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: (_e, g) => Math.abs(g.dx) > 3 || Math.abs(g.dy) > 3,
        onPanResponderGrant: () => {
            pan.setOffset({ x: pos.current.x, y: pos.current.y });
            pan.setValue({ x: 0, y: 0 });
        },
        onPanResponderMove: Animated.event([null, { dx: pan.x, dy: pan.y }], { useNativeDriver: false }),
        onPanResponderRelease: (_e, g) => {
            pan.flattenOffset();
            const moved = Math.hypot(g.dx, g.dy);
            const next = clamp(pos.current.x + g.dx, pos.current.y + g.dy);
            pos.current = next;
            pan.setValue(next);
            if (moved < TAP_SLOP) setOpen((o) => !o);
        },
    }), [pan, clamp]);

    // Resizable sheet height — dragged via the grabber at the top of the panel.
    // State-based (not an Animated value committed on release) so a missed
    // pointerup on web can't leave a stale start height — the cause of resizing
    // getting "stuck". The start height is captured fresh at each gesture grant.
    const SHEET_MIN = 220;
    const [sheetHeight, setSheetHeight] = React.useState(() => Math.min(Math.max(height * 0.6, SHEET_MIN), height * 0.92));
    const heightRef = React.useRef(sheetHeight);
    heightRef.current = sheetHeight;
    const resizeResponder = React.useMemo(() => {
        const clampH = (h: number) => Math.max(SHEET_MIN, Math.min(h, height * 0.92));
        let start = 0;
        return PanResponder.create({
            onStartShouldSetPanResponder: () => true,
            onStartShouldSetPanResponderCapture: () => true,
            onMoveShouldSetPanResponder: () => true,
            onMoveShouldSetPanResponderCapture: () => true,
            onPanResponderTerminationRequest: () => false,
            onPanResponderGrant: () => { start = heightRef.current; },
            // Drag up grows the sheet, drag down shrinks it.
            onPanResponderMove: (_e, g) => setSheetHeight(clampH(start - g.dy)),
        });
    }, [height]);

    if (!devMode) return null;

    return (
        <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
            {open && (
                // No backdrop — the main screen stays visible and interactive so
                // appearance changes can be watched live while tweaking.
                <View style={[styles.sheet, { height: sheetHeight, paddingBottom: insets.bottom + 12 }]}>
                    <View style={styles.grabberArea} {...resizeResponder.panHandlers}>
                        <View style={styles.grabber} />
                    </View>
                    <View style={styles.sheetHeader}>
                        {page === 'home' ? (
                            <Ionicons name="construct-outline" size={18} color={theme.colors.textSecondary} />
                        ) : (
                            <Pressable hitSlop={12} onPress={() => setPage('home')}>
                                <Ionicons name="chevron-back" size={20} color={theme.colors.textSecondary} />
                            </Pressable>
                        )}
                        <Text style={styles.sheetTitle}>{PAGE_TITLE[page]}</Text>
                        <Pressable hitSlop={12} onPress={close}>
                            <Ionicons name="close" size={22} color={theme.colors.textSecondary} />
                        </Pressable>
                    </View>
                    <ScrollView style={styles.sheetScroll} keyboardShouldPersistTaps="handled" contentContainerStyle={styles.sheetContent}>
                        {page === 'home' && (
                            <ItemGroup title="Appearance" footer="Quick, dev-only theme tweaks.">
                                <Item
                                    title="Color Palette"
                                    subtitle="Background, surfaces, text, accent"
                                    icon={<Ionicons name="color-palette-outline" size={29} color={theme.colors.accents.indigo} />}
                                    onPress={() => setPage('palette')}
                                />
                                <Item
                                    title="Accent Colors"
                                    subtitle="Named icon tints + overrides"
                                    icon={<Ionicons name="brush-outline" size={29} color={theme.colors.accents.pink} />}
                                    onPress={() => setPage('accents')}
                                />
                                <Item
                                    title="Font"
                                    subtitle="Default UI font family"
                                    icon={<Ionicons name="text-outline" size={29} color={theme.colors.accents.green} />}
                                    onPress={() => setPage('fonts')}
                                />
                            </ItemGroup>
                        )}
                        {page === 'palette' && <PaletteControls />}
                        {page === 'accents' && <AccentControls />}
                        {page === 'fonts' && <FontControls />}
                    </ScrollView>
                </View>
            )}
            <Animated.View
                {...panResponder.panHandlers}
                style={[styles.fab, { backgroundColor: theme.colors.textLink, transform: pan.getTranslateTransform() }]}
            >
                <Ionicons name={open ? 'close' : 'color-palette'} size={24} color="#ffffff" />
            </Animated.View>
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    fab: {
        position: 'absolute',
        top: 0,
        left: 0,
        width: FAB_SIZE,
        height: FAB_SIZE,
        borderRadius: FAB_SIZE / 2,
        alignItems: 'center',
        justifyContent: 'center',
        shadowColor: '#000',
        shadowOpacity: 0.25,
        shadowRadius: 6,
        shadowOffset: { width: 0, height: 3 },
        elevation: 6,
        zIndex: 1000,
    },
    sheet: {
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: theme.colors.groupped.background,
        borderTopLeftRadius: 16,
        borderTopRightRadius: 16,
        zIndex: 1001,
    },
    grabberArea: {
        alignItems: 'center',
        justifyContent: 'center',
        // Taller hit area so the resize drag is easy to grab.
        height: 28,
    },
    grabber: {
        width: 48,
        height: 6,
        borderRadius: 3,
        backgroundColor: theme.colors.textSecondary,
        opacity: 0.5,
    },
    sheetScroll: {
        flex: 1,
    },
    sheetHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: 16,
        paddingTop: 4,
        paddingBottom: 8,
    },
    sheetTitle: {
        flex: 1,
        fontSize: 16,
        fontWeight: '600',
        color: theme.colors.text,
    },
    sheetContent: {
        paddingBottom: 16,
    },
}));
