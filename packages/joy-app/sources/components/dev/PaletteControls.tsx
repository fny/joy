import * as React from 'react';
import { View, Text, TextInput } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { useLocalSettingMutable } from '@/sync/storage';
import { ColorBox } from './ColorBox';
import { useAppearanceHistory, captureAppearance } from './appearanceHistory';
import {
    PALETTES,
    DARK_PALETTES,
    PALETTE_FIELDS,
    type PaletteShellKey,
    DEFAULT_PALETTE_ID,
    CUSTOM_PALETTE_ID,
    DEFAULT_SHELL,
    coerceCustomPalette,
    applyAppearance,
    applyDarkAppearance,
    type Palette,
    type NamedPalette,
} from '@/palettes';

const HEX_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

// A row of color dots previewing a palette (background / surface / accent / text).
// When `selected`, the row gets an accent ring + a checkmark so the last-chosen
// palette is unmistakable.
function Swatches({ p, selected }: { p: Pick<Palette, 'background' | 'surface' | 'accent' | 'text'>; selected?: boolean }) {
    const { theme } = useUnistyles();
    return (
        <View style={styles.swatchWrap}>
            {selected && (
                <Ionicons name="checkmark-circle" size={18} color={theme.colors.textLink} style={{ marginRight: 6 }} />
            )}
            <View style={[styles.swatchRow, selected && { borderColor: theme.colors.textLink }]}>
                {[p.background, p.surface, p.accent, p.text].map((c, i) => (
                    <View key={i} style={[styles.swatch, { backgroundColor: c }]} />
                ))}
            </View>
        </View>
    );
}

// Palette selector + custom hex editor. Self-contained (renders ItemGroups);
// wrap it in an ItemList (settings) or a ScrollView (dev FAB panel).
//
// `mode` scopes which list shows: 'light' → light palettes + custom editor,
// 'dark' → dark palettes only. Omitted (dev FAB) → everything. Picking a palette
// applies to that theme and persists; it does NOT change the app's appearance
// mode — that's chosen on the Appearance page. The settings page renders a live
// preview above this, so toggling the mode here is a preview, not a switch.
export const PaletteControls = React.memo(function PaletteControls({ mode }: { mode?: 'light' | 'dark' }) {
    const showLight = mode === 'light' || mode === undefined;
    const showDark = mode === 'dark' || mode === undefined;
    const [selectedId, setSelectedId] = useLocalSettingMutable('themePalette');
    const [darkId, setDarkId] = useLocalSettingMutable('themePaletteDark');
    const [storedCustom, setStoredCustom] = useLocalSettingMutable('customPalette');
    const [accentOverrides, setStoredAccents] = useLocalSettingMutable('accentOverrides');

    // Dark palette selection is independent of the light one and applies to the
    // 'dark' theme. Presets only (no custom-dark editor).
    const selectDark = React.useCallback((id: string) => {
        setDarkId(id);
        applyDarkAppearance(id);
    }, [setDarkId]);

    // Local editor state (raw text per field) so typing stays smooth; seeded
    // from the stored custom palette (or the custom default).
    const [draft, setDraft] = React.useState<Palette>(() => coerceCustomPalette(storedCustom));
    // Keep the editor in sync when the stored palette changes externally (undo).
    React.useEffect(() => { setDraft(coerceCustomPalette(storedCustom)); }, [storedCustom]);

    const select = React.useCallback((id: string) => {
        useAppearanceHistory.getState().commit(captureAppearance());
        setSelectedId(id);
        // `draft` is persisted to `storedCustom` on every edit, so storedCustom
        // is the current custom palette.
        applyAppearance(id, storedCustom, accentOverrides);
    }, [storedCustom, accentOverrides, setSelectedId]);

    const editField = React.useCallback((key: PaletteShellKey, value: string) => {
        useAppearanceHistory.getState().record(`shell:${key}`, captureAppearance());
        const next = { ...draft, [key]: value };
        setDraft(next);
        setStoredCustom(next as Record<string, string>);
        // Live-apply while the custom palette is the active one (only push valid
        // hex so a half-typed value doesn't blank the UI).
        if (selectedId === CUSTOM_PALETTE_ID && HEX_RE.test(value.trim())) {
            applyAppearance(CUSTOM_PALETTE_ID, next as Record<string, string>, accentOverrides);
        }
    }, [draft, selectedId, accentOverrides, setStoredCustom]);

    // Copy the currently-selected palette into the Custom slot and switch to it,
    // so its colors (and any accents it ships) become editable.
    const copyToCustom = React.useCallback(() => {
        useAppearanceHistory.getState().commit(captureAppearance());
        const preset = PALETTES.find((p) => p.id === selectedId);
        const src: Palette = selectedId === CUSTOM_PALETTE_ID ? draft : (preset ?? DEFAULT_SHELL);
        const shell: Palette = {
            background: src.background, surface: src.surface, surfaceAlt: src.surfaceAlt,
            text: src.text, textSecondary: src.textSecondary, accent: src.accent,
            border: src.border, userBubble: src.userBubble,
        };
        const shellRec: Record<string, string> = Object.fromEntries(Object.entries(shell));
        setDraft(shell);
        setStoredCustom(shellRec);
        const nextAccents = preset?.accents
            ? ({ ...(accentOverrides ?? {}), ...preset.accents } as Record<string, string>)
            : accentOverrides;
        if (preset?.accents) setStoredAccents(nextAccents);
        setSelectedId(CUSTOM_PALETTE_ID);
        applyAppearance(CUSTOM_PALETTE_ID, shellRec, nextAccents);
    }, [selectedId, draft, accentOverrides, setStoredCustom, setStoredAccents, setSelectedId]);

    return (
        <>
            {showLight && (
            <ItemGroup title="Light palettes" footer="Re-skins background, surfaces, text and accent for the light theme.">
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
                        rightElement={<Swatches p={p} selected={selectedId === p.id} />}
                        selected={selectedId === p.id}
                        onPress={() => select(p.id)}
                    />
                ))}
                <Item
                    title="Custom"
                    subtitle="Your colors (edit below)"
                    rightElement={<Swatches p={draft} selected={selectedId === CUSTOM_PALETTE_ID} />}
                    selected={selectedId === CUSTOM_PALETTE_ID}
                    onPress={() => select(CUSTOM_PALETTE_ID)}
                />
                <Item
                    title="Copy selected → Custom"
                    subtitle="Edit a copy of the selected palette"
                    icon={<Ionicons name="copy-outline" size={29} color="#8E8E93" />}
                    onPress={copyToCustom}
                />
            </ItemGroup>
            )}

            {showDark && (
            <ItemGroup title="Dark palettes" footer="Re-skins the dark theme. Presets only.">
                <Item
                    title="Default"
                    subtitle="Stock dark theme"
                    icon={<Ionicons name="moon-outline" size={29} color="#8E8E93" />}
                    selected={darkId === DEFAULT_PALETTE_ID}
                    onPress={() => selectDark(DEFAULT_PALETTE_ID)}
                />
                {DARK_PALETTES.map((p: NamedPalette) => (
                    <Item
                        key={p.id}
                        title={p.name}
                        rightElement={<Swatches p={p} selected={darkId === p.id} />}
                        selected={darkId === p.id}
                        onPress={() => selectDark(p.id)}
                    />
                ))}
            </ItemGroup>
            )}

            {showLight && (
            <ItemGroup title="Custom colors" footer="Enter hex like #fffdf8. Saves as the Custom palette; select Custom above to apply.">
                <View style={styles.editor}>
                    {PALETTE_FIELDS.map(({ key, label }) => {
                        const value = draft[key];
                        const valid = HEX_RE.test(value.trim());
                        return (
                            <View key={key} style={styles.fieldRow}>
                                <ColorBox value={value} onChange={(hex) => editField(key, hex)} size={22} />
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
            )}
        </>
    );
});

const styles = StyleSheet.create((theme) => ({
    swatchWrap: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    swatchRow: {
        flexDirection: 'row',
        gap: 4,
        // Border reserved (transparent) so selecting doesn't shift row height;
        // the selected swatch row turns it accent-coloured.
        borderWidth: 2,
        borderColor: 'transparent',
        borderRadius: 8,
        padding: 3,
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
