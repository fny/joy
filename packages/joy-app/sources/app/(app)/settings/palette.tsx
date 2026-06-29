import * as React from 'react';
import { View, Text, Pressable } from 'react-native';
import { StyleSheet, UnistylesRuntime } from 'react-native-unistyles';
import { ItemList } from '@/components/ItemList';
import { PaletteControls } from '@/components/dev/PaletteControls';
import { useLocalSettingMutable, storage } from '@/sync/storage';
import { applyAppearance, applyDarkAppearance } from '@/palettes';

// Switch the live theme immediately (and disable adaptive so it sticks), mirroring
// Settings > Appearance. Crucially, RE-APPLY the selected palette for the target
// theme so the switch shows it (and uses the palette's background) — setTheme
// alone reverts to the stock theme without the palette override.
function applyMode(mode: 'light' | 'dark') {
    UnistylesRuntime.setAdaptiveThemes(false);
    UnistylesRuntime.setTheme(mode);
    const ls = storage.getState().localSettings;
    if (mode === 'dark') {
        applyDarkAppearance(ls.themePaletteDark);
    } else {
        applyAppearance(ls.themePalette, ls.customPalette, ls.accentOverrides);
    }
}

const MODES = [
    { key: 'light', label: 'Light' },
    { key: 'dark', label: 'Dark' },
] as const;

export default React.memo(function PaletteSettingsScreen() {
    const [themePreference, setThemePreference] = useLocalSettingMutable('themePreference');

    // Which segment reads as active: the explicit preference, or — when adaptive —
    // whatever theme is currently resolved.
    const active: 'light' | 'dark' = themePreference === 'light' || themePreference === 'dark'
        ? themePreference
        : (UnistylesRuntime.themeName === 'dark' ? 'dark' : 'light');

    const select = React.useCallback((mode: 'light' | 'dark') => {
        setThemePreference(mode);
        applyMode(mode);
    }, [setThemePreference]);

    return (
        <ItemList style={{ paddingTop: 0 }}>
            <View style={styles.segmentRow}>
                {MODES.map(m => (
                    <Pressable
                        key={m.key}
                        onPress={() => select(m.key)}
                        style={[styles.segment, active === m.key && styles.segmentActive]}
                    >
                        <Text style={[styles.segmentText, active === m.key && styles.segmentTextActive]}>{m.label}</Text>
                    </Pressable>
                ))}
            </View>
            <PaletteControls />
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
