import * as React from 'react';
import { View, Pressable } from 'react-native';
import { Text } from '@/components/StyledText';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { ItemGroup } from '@/components/ItemGroup';
import { useLocalSettingMutable } from '@/sync/storage';
import {
    FONT_SETS,
    MONO_FONT_OPTIONS,
    FontFamilies,
    setDefaultFontFamily,
    setMonoFontFamily,
    type FontOption,
} from '@/constants/Typography';
import { applyAppearance } from '@/palettes';

// Appearance font switcher. Two parts:
//   • App font — pick a body/UI font set (sans / serif / mono) in one tap.
//   • Monospace — override the font used for code blocks + mono surfaces.
// Both apply live (a theme nudge reflows styles that bake the font in) and on
// reload (persisted to fontOverride / monoOverride).
export const FontSettings = React.memo(function FontSettings() {
    const { theme } = useUnistyles();
    const [fontOverride, setFontOverride] = useLocalSettingMutable('fontOverride');
    const [monoOverride, setMonoOverride] = useLocalSettingMutable('monoOverride');
    const [themePalette] = useLocalSettingMutable('themePalette');
    const [customPalette] = useLocalSettingMutable('customPalette');
    const [accentOverrides] = useLocalSettingMutable('accentOverrides');

    // Nudge a theme update so styles that bake in the font recompute.
    const reflow = React.useCallback(() => {
        applyAppearance(themePalette, customPalette, accentOverrides);
    }, [themePalette, customPalette, accentOverrides]);

    const selectBody = React.useCallback((family: string | null) => {
        setFontOverride(family);
        setDefaultFontFamily(family);
        reflow();
    }, [setFontOverride, reflow]);

    const selectMono = React.useCallback((family: string | null) => {
        setMonoOverride(family);
        setMonoFontFamily(family);
        reflow();
    }, [setMonoOverride, reflow]);

    return (
        <>
            {FONT_SETS.map((set, gi) => (
                <ItemGroup
                    key={set.category}
                    title={`App font · ${set.category}`}
                    footer={gi === FONT_SETS.length - 1 ? 'Switches the whole app’s text font. Some text only fully updates on reload.' : undefined}
                >
                    <View style={styles.list}>
                        {set.options.map((opt, i) => (
                            <FontRow
                                key={opt.id}
                                opt={opt}
                                first={i === 0}
                                selected={(fontOverride ?? null) === (opt.family ?? null)}
                                previewFamily={opt.family ?? FontFamilies.default.regular}
                                onPress={() => selectBody(opt.family)}
                                theme={theme}
                            />
                        ))}
                    </View>
                </ItemGroup>
            ))}

            <ItemGroup title="Monospace" footer="Font for code blocks and other mono text.">
                <View style={styles.list}>
                    {MONO_FONT_OPTIONS.map((opt, i) => (
                        <FontRow
                            key={opt.id}
                            opt={opt}
                            first={i === 0}
                            mono
                            selected={(monoOverride ?? null) === (opt.family ?? null)}
                            previewFamily={opt.family ?? FontFamilies.mono.regular}
                            onPress={() => selectMono(opt.family)}
                            theme={theme}
                        />
                    ))}
                </View>
            </ItemGroup>
        </>
    );
});

const FontRow = React.memo(function FontRow({
    opt, first, selected, previewFamily, onPress, theme, mono,
}: {
    opt: FontOption;
    first: boolean;
    selected: boolean;
    previewFamily: string;
    onPress: () => void;
    theme: any;
    mono?: boolean;
}) {
    return (
        <Pressable onPress={onPress} style={[styles.row, !first && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.colors.divider }]}>
            <View style={styles.texts}>
                <Text style={[styles.name, { color: theme.colors.text, fontFamily: previewFamily }]} numberOfLines={1}>{opt.label}</Text>
                <Text style={[styles.sample, { color: theme.colors.textSecondary, fontFamily: previewFamily }]} numberOfLines={1}>
                    {mono ? 'const x = 42;  // 0O Il1' : 'The quick brown fox jumps'}
                </Text>
            </View>
            {selected && <Ionicons name="checkmark" size={22} color={theme.colors.textLink} />}
        </Pressable>
    );
});

const styles = StyleSheet.create(() => ({
    list: {
        paddingHorizontal: 16,
    },
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        paddingVertical: 12,
    },
    texts: {
        flex: 1,
        gap: 2,
    },
    name: {
        fontSize: 16,
    },
    sample: {
        fontSize: 14,
    },
}));
