import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { useLocalSettingMutable } from '@/sync/storage';
import { TERMINAL_THEMES, type TerminalTheme } from '@/constants/terminalThemes';

// A mini preview of a terminal theme: its window background with a few ANSI
// colour dots + the foreground.
function TerminalSwatch({ t }: { t: TerminalTheme }) {
    return (
        <View style={[styles.swatch, { backgroundColor: t.background }]}>
            {[t.ansi[1], t.ansi[2], t.ansi[4], t.foreground].map((c, i) => (
                <View key={i} style={[styles.dot, { backgroundColor: c }]} />
            ))}
        </View>
    );
}

// Terminal colour theme picker — applies to the pane and bash command output.
export const TerminalControls = React.memo(function TerminalControls() {
    const [selected, setSelected] = useLocalSettingMutable('terminalTheme');
    return (
        <ItemGroup title="Terminal theme" footer="Colours for the terminal pane and bash command output.">
            {TERMINAL_THEMES.map((t) => (
                <Item
                    key={t.id}
                    title={t.name}
                    selected={selected === t.id}
                    rightElement={<TerminalSwatch t={t} />}
                    onPress={() => setSelected(t.id)}
                />
            ))}
        </ItemGroup>
    );
});

const styles = StyleSheet.create((theme) => ({
    swatch: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        paddingHorizontal: 8,
        paddingVertical: 6,
        borderRadius: 5,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
    },
    dot: {
        width: 9,
        height: 9,
        borderRadius: 5,
    },
}));
