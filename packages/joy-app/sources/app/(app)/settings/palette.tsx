import * as React from 'react';
import { View, Text, Pressable, Appearance } from 'react-native';
import { StyleSheet, UnistylesRuntime } from 'react-native-unistyles';
import { useFocusEffect } from 'expo-router';
import * as SystemUI from 'expo-system-ui';
import { ItemList } from '@/components/ItemList';
import { PaletteControls } from '@/components/dev/PaletteControls';
import { storage } from '@/sync/storage';
import { lightTheme, darkTheme } from '@/theme';
import { applyAppearance, applyDarkAppearance } from '@/palettes';

const MODES = [
    { key: 'light', label: 'Light' },
    { key: 'dark', label: 'Dark' },
] as const;

// PREVIEW the whole app in a given scheme — re-theme the entire UI live so you
// can see how everything looks, WITHOUT persisting it. The real appearance mode
// (light / dark / adaptive) lives on the Appearance page and is restored when
// you leave this screen.
function applyPreview(mode: 'light' | 'dark') {
    UnistylesRuntime.setAdaptiveThemes(false);
    UnistylesRuntime.setTheme(mode);
    const color = mode === 'dark' ? darkTheme.colors.groupped.background : lightTheme.colors.groupped.background;
    SystemUI.setBackgroundColorAsync(color);
    const ls = storage.getState().localSettings;
    if (mode === 'dark') applyDarkAppearance(ls.themePaletteDark);
    else applyAppearance(ls.themePalette, ls.customPalette, ls.accentOverrides);
}

// Restore the user's real appearance preference (what they set on Appearance).
function restoreAppearance() {
    const ls = storage.getState().localSettings;
    const pref = ls.themePreference;
    if (pref === 'adaptive') {
        UnistylesRuntime.setAdaptiveThemes(true);
        const resolved = Appearance.getColorScheme() === 'dark' ? 'dark' : 'light';
        const color = resolved === 'dark' ? darkTheme.colors.groupped.background : lightTheme.colors.groupped.background;
        SystemUI.setBackgroundColorAsync(color);
        if (resolved === 'dark') applyDarkAppearance(ls.themePaletteDark);
        else applyAppearance(ls.themePalette, ls.customPalette, ls.accentOverrides);
    } else {
        UnistylesRuntime.setAdaptiveThemes(false);
        UnistylesRuntime.setTheme(pref);
        const color = pref === 'dark' ? darkTheme.colors.groupped.background : lightTheme.colors.groupped.background;
        SystemUI.setBackgroundColorAsync(color);
        if (pref === 'dark') applyDarkAppearance(ls.themePaletteDark);
        else applyAppearance(ls.themePalette, ls.customPalette, ls.accentOverrides);
    }
}

export default React.memo(function PaletteSettingsScreen() {
    // Which scheme we're previewing (the live app theme). Defaults to whatever
    // the app is currently showing. Held in a ref too so the focus effect can
    // re-apply it without re-subscribing.
    const [previewMode, setPreviewMode] = React.useState<'light' | 'dark'>(
        UnistylesRuntime.themeName === 'dark' ? 'dark' : 'light',
    );
    const previewModeRef = React.useRef(previewMode);

    // Apply the preview while focused; restore the real appearance on blur/unmount.
    useFocusEffect(React.useCallback(() => {
        applyPreview(previewModeRef.current);
        return () => restoreAppearance();
    }, []));

    const select = React.useCallback((mode: 'light' | 'dark') => {
        previewModeRef.current = mode;
        setPreviewMode(mode);
        applyPreview(mode);
    }, []);

    return (
        <ItemList style={{ paddingTop: 0 }}>
            <View style={styles.segmentRow}>
                {MODES.map(m => (
                    <Pressable
                        key={m.key}
                        onPress={() => select(m.key)}
                        style={[styles.segment, previewMode === m.key && styles.segmentActive]}
                    >
                        <Text style={[styles.segmentText, previewMode === m.key && styles.segmentTextActive]}>{m.label}</Text>
                    </Pressable>
                ))}
            </View>
            <PaletteControls mode={previewMode} />
        </ItemList>
    );
});

const styles = StyleSheet.create((theme) => ({
    segmentRow: {
        flexDirection: 'row',
        gap: 8,
        marginHorizontal: 16,
        marginTop: 16,
        marginBottom: 4,
    },
    segment: {
        flex: 1,
        alignItems: 'center',
        paddingVertical: 10,
        borderRadius: 10,
        backgroundColor: theme.colors.surfaceHigh,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
    },
    segmentActive: {
        backgroundColor: theme.colors.textLink,
        borderColor: theme.colors.textLink,
    },
    segmentText: {
        fontSize: 15,
        fontWeight: '600',
        color: theme.colors.text,
    },
    segmentTextActive: {
        color: '#ffffff',
    },
}));
