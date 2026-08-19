// Icon browser: every glyph in the icon families this app ships, with its name.
// Names come from each set's own `glyphMap` at runtime (react-native-vector-icons
// exposes it on the component), so this can never drift from the installed
// fonts the way a hand-maintained list would.
//
// Tap an icon to copy its name — that's the actual job of this screen: find the
// glyph, get the string you paste into `<Ionicons name="…" />`.
import * as React from 'react';
import { View, Text, Pressable, TextInput, ScrollView, Platform } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import Ionicons from '@expo/vector-icons/Ionicons';
import Octicons from '@expo/vector-icons/Octicons';
import * as Clipboard from 'expo-clipboard';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';

type IconSet = React.ComponentType<{ name: any; size: number; color: string }> & { glyphMap: Record<string, unknown> };

// The app ships exactly two icon fonts: Ionicons is the house style, Octicons
// carries the git/tool surfaces. Do NOT add families here casually — referencing
// a set is what pulls its .ttf into the bundle, which is why MaterialIcons,
// MaterialCommunityIcons, Feather and FontAwesome were removed (2026-08-19).
const FAMILIES: { key: string; label: string; Set: IconSet }[] = [
    { key: 'ionicons', label: 'Ionicons', Set: Ionicons as unknown as IconSet },
    { key: 'octicons', label: 'Octicons', Set: Octicons as unknown as IconSet },
];

const COLUMNS = 3;
const CELL_HEIGHT = 92;

function IconCell({ name, Set, onCopy, copied }: {
    name: string;
    Set: IconSet;
    onCopy: (name: string) => void;
    copied: boolean;
}) {
    const { theme } = useUnistyles();
    return (
        <Pressable
            onPress={() => onCopy(name)}
            style={(p) => [styles.cell, { opacity: p.pressed ? 0.5 : 1 }]}
            accessibilityRole="button"
            accessibilityLabel={`Copy icon name ${name}`}
        >
            <Set name={name} size={26} color={theme.colors.text} />
            <Text style={styles.cellName} numberOfLines={2} ellipsizeMode="middle">
                {copied ? 'copied!' : name}
            </Text>
        </Pressable>
    );
}

export default React.memo(function IconsScreen() {
    const { theme } = useUnistyles();
    const [familyKey, setFamilyKey] = React.useState(FAMILIES[0].key);
    const [query, setQuery] = React.useState('');
    const [copied, setCopied] = React.useState<string | null>(null);

    const family = FAMILIES.find((f) => f.key === familyKey) ?? FAMILIES[0];

    // glyphMap keys ARE the icon names. Sorted so the outline/sharp variants of
    // a glyph sit next to their base name.
    const allNames = React.useMemo(
        () => Object.keys(family.Set.glyphMap).sort(),
        [family],
    );

    const names = React.useMemo(() => {
        const q = query.trim().toLowerCase();
        if (!q) return allNames;
        return allNames.filter((n) => n.includes(q));
    }, [allNames, query]);

    const copyTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    React.useEffect(() => () => { if (copyTimer.current) clearTimeout(copyTimer.current); }, []);

    const onCopy = React.useCallback((name: string) => {
        void Clipboard.setStringAsync(name);
        setCopied(name);
        if (copyTimer.current) clearTimeout(copyTimer.current);
        copyTimer.current = setTimeout(() => setCopied(null), 1200);
    }, []);

    return (
        <View style={styles.container}>
            {/* Family picker */}
            <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                style={styles.familyRow}
                contentContainerStyle={styles.familyRowContent}
            >
                {FAMILIES.map((item) => {
                    const active = item.key === familyKey;
                    return (
                        <Pressable
                            key={item.key}
                            onPress={() => { setFamilyKey(item.key); setQuery(''); }}
                            style={[styles.familyChip, active && styles.familyChipActive]}
                        >
                            <Text style={[styles.familyChipText, active && styles.familyChipTextActive]}>
                                {item.label}
                            </Text>
                        </Pressable>
                    );
                })}
            </ScrollView>

            {/* Search */}
            <View style={styles.searchRow}>
                <Ionicons name="search-outline" size={16} color={theme.colors.textSecondary} />
                <TextInput
                    style={styles.searchInput}
                    value={query}
                    onChangeText={setQuery}
                    placeholder={`Filter ${allNames.length} icons…`}
                    placeholderTextColor={theme.colors.textSecondary}
                    autoCapitalize="none"
                    autoCorrect={false}
                    spellCheck={false}
                    returnKeyType="search"
                />
                {query.length > 0 && (
                    <Pressable onPress={() => setQuery('')} hitSlop={8}>
                        <Ionicons name="close-circle" size={16} color={theme.colors.textSecondary} />
                    </Pressable>
                )}
            </View>

            <Text style={styles.count}>
                {names.length === allNames.length
                    ? `${allNames.length} icons`
                    : `${names.length} of ${allNames.length} icons`}
            </Text>

            {names.length === 0 ? (
                <View style={styles.empty}>
                    <Text style={styles.emptyText}>No icon matches “{query}”</Text>
                </View>
            ) : (
                <FlashList
                    // Keyed by family so switching sets resets scroll + recycling
                    // instead of showing the previous set's glyphs mid-scroll.
                    key={familyKey}
                    data={names}
                    numColumns={COLUMNS}
                    keyExtractor={(n) => n}
                    keyboardShouldPersistTaps="handled"
                    renderItem={({ item }) => (
                        <IconCell name={item} Set={family.Set} onCopy={onCopy} copied={copied === item} />
                    )}
                    contentContainerStyle={{ paddingBottom: 24 }}
                />
            )}
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.groupped.background,
    },
    familyRow: {
        flexGrow: 0,
        paddingTop: 8,
    },
    familyRowContent: {
        paddingHorizontal: 8,
        alignItems: 'center',
    },
    familyChip: {
        paddingHorizontal: 12,
        paddingVertical: 6,
        borderRadius: 16,
        marginHorizontal: 4,
        backgroundColor: theme.colors.surface,
        justifyContent: 'center',
    },
    familyChipActive: {
        backgroundColor: theme.colors.textLink,
    },
    familyChipText: {
        fontSize: 13,
        color: theme.colors.text,
        ...Typography.default(),
    },
    familyChipTextActive: {
        color: '#FFFFFF',
        ...Typography.default('semiBold'),
    },
    searchRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        marginHorizontal: 12,
        marginTop: 10,
        paddingHorizontal: 10,
        height: 36,
        borderRadius: 10,
        backgroundColor: theme.colors.surface,
    },
    searchInput: {
        flex: 1,
        fontSize: 15,
        color: theme.colors.text,
        padding: 0,
        ...Typography.default(),
        ...(Platform.OS === 'web' ? { outlineStyle: 'none' as any } : {}),
    },
    count: {
        fontSize: 11,
        color: theme.colors.textSecondary,
        marginHorizontal: 16,
        marginTop: 8,
        marginBottom: 4,
        ...Typography.default(),
    },
    cell: {
        flex: 1,
        height: CELL_HEIGHT,
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        paddingHorizontal: 6,
    },
    cellName: {
        fontSize: 10,
        lineHeight: 13,
        textAlign: 'center',
        color: theme.colors.textSecondary,
        ...Typography.mono(),
    },
    empty: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
    },
    emptyText: {
        fontSize: 14,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
}));
