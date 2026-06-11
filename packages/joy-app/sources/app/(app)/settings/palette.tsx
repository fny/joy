import * as React from 'react';
import { View, Text, TextInput } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { useLocalSettingMutable } from '@/sync/storage';
import {
    PALETTES,
    PALETTE_FIELDS,
    DEFAULT_PALETTE_ID,
    CUSTOM_PALETTE_ID,
    coerceCustomPalette,
    resolvePalette,
    applyPalette,
    type Palette,
    type NamedPalette,
} from '@/palettes';

const HEX_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

// A row of color dots previewing a palette (background / surface / accent / text).
function Swatches({ p }: { p: Pick<Palette, 'background' | 'surface' | 'accent' | 'text'> }) {
    return (
        <View style={styles.swatchRow}>
            {[p.background, p.surface, p.accent, p.text].map((c, i) => (
                <View key={i} style={[styles.swatch, { backgroundColor: c }]} />
            ))}
        </View>
    );
}

export default React.memo(function PaletteSettingsScreen() {
    const [selectedId, setSelectedId] = useLocalSettingMutable('themePalette');
    const [storedCustom, setStoredCustom] = useLocalSettingMutable('customPalette');

    // Local editor state (raw text per field) so typing stays smooth; seeded
    // from the stored custom palette (or the custom default).
    const [draft, setDraft] = React.useState<Palette>(() => coerceCustomPalette(storedCustom));

    const select = React.useCallback((id: string) => {
        setSelectedId(id);
        applyPalette(id === CUSTOM_PALETTE_ID ? draft : resolvePalette(id, storedCustom));
    }, [draft, storedCustom, setSelectedId]);

    const editField = React.useCallback((key: keyof Palette, value: string) => {
        const next = { ...draft, [key]: value };
        setDraft(next);
        setStoredCustom(next as Record<string, string>);
        // Live-apply while the custom palette is the active one (only push valid
        // hex so a half-typed value doesn't blank the UI).
        if (selectedId === CUSTOM_PALETTE_ID && HEX_RE.test(value.trim())) {
            applyPalette(next);
        }
    }, [draft, selectedId, setStoredCustom]);

    return (
        <ItemList style={{ paddingTop: 0 }}>
            <ItemGroup title="Palette" footer="Re-skins the app's background, surfaces, text and accent. Applies to the light theme — switch Appearance to Light to see it.">
                <Item
                    title="Default"
                    subtitle="Original theme"
                    icon={<Ionicons name="color-palette-outline" size={29} color="#8E8E93" />}
                    selected={selectedId === DEFAULT_PALETTE_ID}
                    onPress={() => select(DEFAULT_PALETTE_ID)}
                />
                {PALETTES.map((p: NamedPalette) => (
                    <Item
                        key={p.id}
                        title={p.name}
                        rightElement={<Swatches p={p} />}
                        selected={selectedId === p.id}
                        onPress={() => select(p.id)}
                    />
                ))}
                <Item
                    title="Custom"
                    subtitle="Your colors (edit below)"
                    rightElement={<Swatches p={draft} />}
                    selected={selectedId === CUSTOM_PALETTE_ID}
                    onPress={() => select(CUSTOM_PALETTE_ID)}
                />
            </ItemGroup>

            <ItemGroup title="Custom colors" footer="Enter hex values like #fffdf8. Changes save as the Custom palette; select Custom above to apply them.">
                <View style={styles.editor}>
                    {PALETTE_FIELDS.map(({ key, label }) => {
                        const value = draft[key];
                        const valid = HEX_RE.test(value.trim());
                        return (
                            <View key={key} style={styles.fieldRow}>
                                <View style={[styles.fieldSwatch, { backgroundColor: valid ? value : 'transparent' }]} />
                                <Text style={styles.fieldLabel} numberOfLines={1}>{label}</Text>
                                <TextInput
                                    value={value}
                                    onChangeText={(t) => editField(key, t)}
                                    autoCapitalize="none"
                                    autoCorrect={false}
                                    spellCheck={false}
                                    placeholder="#000000"
                                    style={[styles.fieldInput, !valid && styles.fieldInputInvalid]}
                                />
                            </View>
                        );
                    })}
                </View>
            </ItemGroup>
        </ItemList>
    );
});

const styles = StyleSheet.create((theme) => ({
    swatchRow: {
        flexDirection: 'row',
        gap: 4,
    },
    swatch: {
        width: 16,
        height: 16,
        borderRadius: 4,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
    },
    editor: {
        paddingHorizontal: 16,
        paddingVertical: 8,
        gap: 10,
    },
    fieldRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
    },
    fieldSwatch: {
        width: 22,
        height: 22,
        borderRadius: 5,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
    },
    fieldLabel: {
        flex: 1,
        fontSize: 14,
        color: theme.colors.text,
    },
    fieldInput: {
        width: 110,
        fontSize: 14,
        fontFamily: 'monospace',
        color: theme.colors.text,
        backgroundColor: theme.colors.input.background,
        borderRadius: 8,
        paddingHorizontal: 10,
        paddingVertical: 6,
    },
    fieldInputInvalid: {
        color: theme.colors.textDestructive,
    },
}));
