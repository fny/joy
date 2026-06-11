import * as React from 'react';
import { Animated, PanResponder, Pressable, ScrollView, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { useLocalSetting } from '@/sync/storage';
import { PaletteControls } from './PaletteControls';

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
    const SHEET_MIN = 220;
    const initialSheetH = Math.min(Math.max(height * 0.6, SHEET_MIN), height * 0.92);
    const sheetH = React.useRef(new Animated.Value(initialSheetH)).current;
    const sheetHStart = React.useRef(initialSheetH);
    const resizeResponder = React.useMemo(() => {
        const clampH = (h: number) => Math.max(SHEET_MIN, Math.min(h, height * 0.92));
        return PanResponder.create({
            onStartShouldSetPanResponder: () => true,
            onMoveShouldSetPanResponder: () => true,
            // Drag up grows the sheet, drag down shrinks it.
            onPanResponderMove: (_e, g) => sheetH.setValue(clampH(sheetHStart.current - g.dy)),
            onPanResponderRelease: (_e, g) => { sheetHStart.current = clampH(sheetHStart.current - g.dy); },
        });
    }, [sheetH, height]);

    if (!devMode) return null;

    return (
        <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
            {open && (
                <>
                    <Pressable style={styles.backdrop} onPress={() => setOpen(false)} />
                    <Animated.View style={[styles.sheet, { height: sheetH, paddingBottom: insets.bottom + 12 }]}>
                        <View style={styles.grabberArea} {...resizeResponder.panHandlers}>
                            <View style={styles.grabber} />
                        </View>
                        <View style={styles.sheetHeader}>
                            <Ionicons name="construct-outline" size={18} color={theme.colors.textSecondary} />
                            <Text style={styles.sheetTitle}>Dev tweaks</Text>
                            <Pressable hitSlop={12} onPress={() => setOpen(false)}>
                                <Ionicons name="close" size={22} color={theme.colors.textSecondary} />
                            </Pressable>
                        </View>
                        <ScrollView style={styles.sheetScroll} keyboardShouldPersistTaps="handled" contentContainerStyle={styles.sheetContent}>
                            <PaletteControls />
                        </ScrollView>
                    </Animated.View>
                </>
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
    backdrop: {
        ...StyleSheet.absoluteFillObject,
        backgroundColor: 'rgba(0,0,0,0.35)',
        zIndex: 999,
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
        paddingTop: 8,
        paddingBottom: 4,
    },
    grabber: {
        width: 40,
        height: 5,
        borderRadius: 3,
        backgroundColor: theme.colors.divider,
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
