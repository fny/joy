import * as React from 'react';
import { View, Text, TextInput, Pressable } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { ItemGroup } from '@/components/ItemGroup';
import { useLocalSettingMutable } from '@/sync/storage';
import {
    ACCENT_FIELDS,
    ACCENT_DEFAULTS,
    coerceAccentOverrides,
    applyAppearance,
    type AccentKey,
} from '@/palettes';
import { ColorBox } from './ColorBox';

const HEX_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

// Editor for the named accent tints. Each has a shipped default and an
// override; overrides apply on top of whatever palette is active so the icon
// colors can be coordinated with the theme.
export const AccentControls = React.memo(function AccentControls() {
    const [storedAccents, setStoredAccents] = useLocalSettingMutable('accentOverrides');
    const [themePalette] = useLocalSettingMutable('themePalette');
    const [customPalette] = useLocalSettingMutable('customPalette');

    const [draft, setDraft] = React.useState<Record<AccentKey, string>>(() => coerceAccentOverrides(storedAccents));

    const edit = React.useCallback((key: AccentKey, value: string) => {
        const next = { ...draft, [key]: value };
        setDraft(next);
        setStoredAccents(next);
        if (HEX_RE.test(value.trim())) {
            applyAppearance(themePalette, customPalette, next);
        }
    }, [draft, themePalette, customPalette, setStoredAccents]);

    return (
        <ItemGroup title="Accent colors" footer="Named icon tints with shipped defaults. Override to coordinate them with the palette. Applies to the light theme.">
            <View style={styles.editor}>
                {ACCENT_FIELDS.map(({ key, label }) => {
                    const value = draft[key];
                    const valid = HEX_RE.test(value.trim());
                    const overridden = value.toLowerCase() !== ACCENT_DEFAULTS[key].toLowerCase();
                    return (
                        <View key={key} style={styles.row}>
                            <ColorBox value={value} onChange={(hex) => edit(key, hex)} size={26} />
                            <Text style={styles.label} numberOfLines={1}>{label}</Text>
                            <TextInput
                                value={value}
                                onChangeText={(t) => edit(key, t)}
                                autoCapitalize="none"
                                autoCorrect={false}
                                spellCheck={false}
                                placeholder={ACCENT_DEFAULTS[key]}
                                style={[styles.input, !valid && styles.invalid]}
                            />
                            <Pressable hitSlop={8} onPress={() => edit(key, ACCENT_DEFAULTS[key])} disabled={!overridden} style={styles.reset}>
                                <Ionicons name="arrow-undo-outline" size={18} color={overridden ? styles.resetIcon.color : 'transparent'} />
                            </Pressable>
                        </View>
                    );
                })}
            </View>
        </ItemGroup>
    );
});

const styles = StyleSheet.create((theme) => ({
    editor: {
        paddingHorizontal: 16,
        paddingVertical: 8,
        gap: 10,
    },
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
    },
    label: {
        flex: 1,
        fontSize: 14,
        color: theme.colors.text,
    },
    input: {
        width: 100,
        fontSize: 14,
        fontFamily: 'monospace',
        color: theme.colors.text,
        backgroundColor: theme.colors.input.background,
        borderRadius: 8,
        paddingHorizontal: 10,
        paddingVertical: 6,
    },
    invalid: {
        color: theme.colors.textDestructive,
    },
    reset: {
        width: 22,
        alignItems: 'center',
    },
    resetIcon: {
        color: theme.colors.textSecondary,
    },
}));
