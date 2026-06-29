import * as React from 'react';
import { View, Text, Pressable } from 'react-native';
import { StyleSheet, UnistylesRuntime } from 'react-native-unistyles';
import { ItemList } from '@/components/ItemList';
import { PaletteControls } from '@/components/dev/PaletteControls';
import { useLocalSettingMutable } from '@/sync/storage';
import {
    resolvePalette,
    resolveDarkPalette,
    DEFAULT_SHELL,
    DARK_SHELL,
    type Palette,
    type NamedPalette,
} from '@/palettes';

const MODES = [
    { key: 'light', label: 'Light' },
    { key: 'dark', label: 'Dark' },
] as const;

const ACCENT_KEYS = ['blue', 'indigo', 'green', 'orange', 'red', 'pink'] as const;

// A self-contained mockup rendered with a palette's *literal* colors, so it
// previews the light OR dark scheme regardless of the app's current theme. The
// real appearance mode is chosen on the Appearance page — toggling the segment
// here only changes what this preview (and the list below) shows.
const PalettePreview = React.memo(function PalettePreview({ palette }: { palette: Palette }) {
    const accents = (palette as NamedPalette).accents;
    return (
        <View style={[pv.frame, { backgroundColor: palette.background, borderColor: palette.border }]}>
            <View style={[pv.header, { backgroundColor: palette.surface, borderBottomColor: palette.border }]}>
                <View style={[pv.headerDot, { backgroundColor: palette.accent }]} />
                <Text style={[pv.headerText, { color: palette.text }]}>Preview</Text>
            </View>
            <View style={pv.body}>
                <View style={[pv.card, { backgroundColor: palette.surface, borderColor: palette.border }]}>
                    <Text style={[pv.title, { color: palette.text }]}>The quick brown fox</Text>
                    <Text style={[pv.sub, { color: palette.textSecondary }]}>jumps over the lazy dog</Text>
                    <View style={[pv.button, { backgroundColor: palette.accent }]}>
                        <Text style={pv.buttonText}>Button</Text>
                    </View>
                </View>
                <View style={pv.bubbleRow}>
                    <View style={[pv.bubble, { backgroundColor: palette.userBubble }]}>
                        <Text style={[pv.bubbleText, { color: palette.text }]}>Your message</Text>
                    </View>
                </View>
                {accents && (
                    <View style={pv.accentRow}>
                        {ACCENT_KEYS.map((k) => accents[k] ? (
                            <View key={k} style={[pv.accentDot, { backgroundColor: accents[k]!, borderColor: palette.border }]} />
                        ) : null)}
                    </View>
                )}
            </View>
        </View>
    );
});

export default React.memo(function PaletteSettingsScreen() {
    // Preview mode is local to this page (default: whatever theme the app is in).
    // It deliberately does NOT touch UnistylesRuntime / themePreference.
    const [previewMode, setPreviewMode] = React.useState<'light' | 'dark'>(
        UnistylesRuntime.themeName === 'dark' ? 'dark' : 'light',
    );

    // Read the current selections so the preview tracks the picked palette live.
    const [themePalette] = useLocalSettingMutable('themePalette');
    const [customPalette] = useLocalSettingMutable('customPalette');
    const [themePaletteDark] = useLocalSettingMutable('themePaletteDark');

    const previewPalette: Palette = previewMode === 'dark'
        ? (resolveDarkPalette(themePaletteDark) ?? DARK_SHELL)
        : (resolvePalette(themePalette, customPalette) ?? DEFAULT_SHELL);

    return (
        <ItemList style={{ paddingTop: 0 }}>
            <View style={styles.segmentRow}>
                {MODES.map(m => (
                    <Pressable
                        key={m.key}
                        onPress={() => setPreviewMode(m.key)}
                        style={[styles.segment, previewMode === m.key && styles.segmentActive]}
                    >
                        <Text style={[styles.segmentText, previewMode === m.key && styles.segmentTextActive]}>{m.label}</Text>
                    </Pressable>
                ))}
            </View>
            <PalettePreview palette={previewPalette} />
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

// Preview mockup — all colors come from the palette (inline), never the theme.
const pv = StyleSheet.create(() => ({
    frame: {
        marginHorizontal: 16,
        marginTop: 12,
        marginBottom: 8,
        borderRadius: 14,
        borderWidth: StyleSheet.hairlineWidth,
        overflow: 'hidden',
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: 14,
        paddingVertical: 10,
        borderBottomWidth: StyleSheet.hairlineWidth,
    },
    headerDot: {
        width: 10,
        height: 10,
        borderRadius: 5,
    },
    headerText: {
        fontSize: 14,
        fontWeight: '600',
    },
    body: {
        padding: 14,
        gap: 12,
    },
    card: {
        borderRadius: 10,
        borderWidth: StyleSheet.hairlineWidth,
        padding: 12,
        gap: 6,
    },
    title: {
        fontSize: 15,
        fontWeight: '600',
    },
    sub: {
        fontSize: 13,
    },
    button: {
        alignSelf: 'flex-start',
        marginTop: 4,
        paddingHorizontal: 14,
        paddingVertical: 7,
        borderRadius: 8,
    },
    buttonText: {
        color: '#ffffff',
        fontSize: 13,
        fontWeight: '600',
    },
    bubbleRow: {
        alignItems: 'flex-end',
    },
    bubble: {
        maxWidth: '80%',
        paddingHorizontal: 12,
        paddingVertical: 8,
        borderRadius: 14,
    },
    bubbleText: {
        fontSize: 13,
    },
    accentRow: {
        flexDirection: 'row',
        gap: 8,
        paddingTop: 2,
    },
    accentDot: {
        width: 18,
        height: 18,
        borderRadius: 9,
        borderWidth: StyleSheet.hairlineWidth,
    },
}));
