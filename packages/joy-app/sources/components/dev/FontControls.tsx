import * as React from 'react';
import { View, Text, Pressable } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { ItemGroup } from '@/components/ItemGroup';
import { useLocalSettingMutable } from '@/sync/storage';
import { FONT_OPTIONS, FontFamilies, setDefaultFontFamily } from '@/constants/Typography';
import { applyAppearance } from '@/palettes';
import { useAppearanceHistory, captureAppearance } from './appearanceHistory';

// Dev font picker — overrides the default (body/UI) font family. Each option is
// previewed in its own font (label + a sample line). Mono and logo fonts are
// left alone. Applies live (with a theme nudge to reflow styles) and on reload.
export const FontControls = React.memo(function FontControls() {
    const { theme } = useUnistyles();
    const [fontOverride, setFontOverride] = useLocalSettingMutable('fontOverride');
    const [themePalette] = useLocalSettingMutable('themePalette');
    const [customPalette] = useLocalSettingMutable('customPalette');
    const [accentOverrides] = useLocalSettingMutable('accentOverrides');

    const select = React.useCallback((family: string | null) => {
        useAppearanceHistory.getState().commit(captureAppearance());
        setFontOverride(family);
        setDefaultFontFamily(family);
        // Nudge a reflow so styles that bake in the default font recompute.
        applyAppearance(themePalette, customPalette, accentOverrides);
    }, [themePalette, customPalette, accentOverrides, setFontOverride]);

    return (
        <ItemGroup title="Font" footer="Overrides the default UI font. Code/mono text is unchanged. Some text only fully updates on reload.">
            <View style={styles.list}>
                {FONT_OPTIONS.map((opt, i) => {
                    const selected = (fontOverride ?? null) === (opt.family ?? null);
                    // Preview "Default" in IBM Plex Sans, not the current override.
                    const previewFamily = opt.family ?? FontFamilies.default.regular;
                    return (
                        <Pressable
                            key={opt.id}
                            onPress={() => select(opt.family)}
                            style={[styles.row, i > 0 && styles.rowBorder]}
                        >
                            <View style={styles.texts}>
                                <Text style={[styles.name, { fontFamily: previewFamily }]} numberOfLines={1}>{opt.label}</Text>
                                <Text style={[styles.sample, { fontFamily: previewFamily }]} numberOfLines={1}>The quick brown fox jumps</Text>
                            </View>
                            {selected && <Ionicons name="checkmark" size={22} color={theme.colors.textLink} />}
                        </Pressable>
                    );
                })}
            </View>
        </ItemGroup>
    );
});

const styles = StyleSheet.create((theme) => ({
    list: {
        paddingHorizontal: 16,
    },
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        paddingVertical: 12,
    },
    rowBorder: {
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.colors.divider,
    },
    texts: {
        flex: 1,
        gap: 2,
    },
    name: {
        fontSize: 16,
        color: theme.colors.text,
    },
    sample: {
        fontSize: 14,
        color: theme.colors.textSecondary,
    },
}));
