// Horizontally-scrollable row of quick keys for the joy-tmux terminal pane.
// Most entries are key-token scripts (parsed server-side by joy-tmux's
// keyTokens); WUp/WDn send raw SGR (1006) mouse-wheel sequences verbatim
// (literal mode) so a mouse-aware TUI (claude) scrolls.
import * as React from 'react';
import { Pressable, ScrollView, Text, Platform } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

// SGR mouse-wheel: Cb 64 = wheel up, 65 = wheel down; coords are 1-based col;row.
const WHEEL_UP = '\x1b[<64;1;1M';
const WHEEL_DOWN = '\x1b[<65;1;1M';

type TerminalKey = { label: string; script: string; literal?: boolean };

const KEYS: TerminalKey[] = [
    { label: 'Enter', script: '<Enter>' },
    { label: 'Esc', script: '<Esc>' },
    { label: '^C', script: '<C-c>' },
    { label: 'Del', script: '<Del>' },
    { label: 'Tab', script: '<Tab>' },
    { label: '↑', script: '<Up>' },
    { label: '↓', script: '<Down>' },
    { label: 'PgUp', script: '<PgUp>' },
    { label: 'PgDn', script: '<PgDn>' },
    { label: 'WUp', script: WHEEL_UP, literal: true },
    { label: 'WDn', script: WHEEL_DOWN, literal: true },
    { label: '⇧Tab', script: '<S-Tab>' },
    { label: '1', script: '1' },
    { label: '2', script: '2' },
    { label: '3', script: '3' },
    { label: '4', script: '4' },
];

export const TerminalKeyBar = React.memo(({ onKey, disabled }: {
    onKey: (script: string, literal?: boolean) => void;
    disabled?: boolean;
}) => {
    return (
        <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            keyboardShouldPersistTaps="always"
            contentContainerStyle={styles.row}
        >
            {KEYS.map(k => (
                <Pressable
                    key={k.label}
                    onPress={() => onKey(k.script, k.literal)}
                    style={(p) => [styles.key, p.pressed && styles.keyPressed]}
                    disabled={disabled}
                >
                    <Text style={styles.keyText}>{k.label}</Text>
                </Pressable>
            ))}
        </ScrollView>
    );
});

const styles = StyleSheet.create(() => ({
    row: {
        flexDirection: 'row',
        gap: 6,
        paddingHorizontal: 8,
        paddingVertical: 6,
    },
    key: {
        paddingHorizontal: 12,
        paddingVertical: 6,
        borderRadius: 6,
        backgroundColor: '#262626',
        borderWidth: 1,
        borderColor: '#3a3a3a',
    },
    keyPressed: {
        opacity: 0.5,
    },
    keyText: {
        color: '#d4d4d4',
        fontSize: 13,
        fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
    },
}));
