// Horizontally-scrollable row of quick keys for the joy-tmux terminal pane.
// Most entries are key-token scripts (parsed server-side by joy-tmux's
// keyTokens); WUp/WDn send raw SGR (1006) mouse-wheel sequences verbatim
// (literal mode) so a mouse-aware TUI (claude) scrolls.
import * as React from 'react';
import { Pressable, ScrollView, Text, Platform } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

// SGR mouse-wheel: Cb 64 = wheel up, 65 = wheel down; coords are 1-based col;row.

type TerminalKey = { label: string; script: string; literal?: boolean };

const KEYS: TerminalKey[] = [
    { label: 'Enter', script: '<Enter>' },
    { label: 'Esc', script: '<Esc>' },
    { label: '^C', script: '<C-c>' },
    { label: '⌫', script: '<BS>' },
    { label: '←', script: '<Left>' },
    { label: '→', script: '<Right>' },
    { label: '↑', script: '<Up>' },
    { label: '↓', script: '<Down>' },
    // Word-wise motion (readline M-b/M-f, honored by claude's box + most TUIs).
    { label: '←W', script: '<M-b>' },
    { label: '→W', script: '<M-f>' },
    { label: 'Tab', script: '<Tab>' },
    { label: 'Home', script: '<Home>' },
    { label: 'End', script: '<End>' },
    { label: '^U', script: '<C-u>' },
    { label: '^D', script: '<C-d>' },
    { label: 'PgUp', script: '<PgUp>' },
    { label: 'PgDn', script: '<PgDn>' },
    { label: '⇧Tab', script: '<S-Tab>' },
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
            style={styles.bar}
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
    // Bound the bar's height and keep it from growing into the column —
    // otherwise the horizontal ScrollView balloons on web and the keys
    // stretch to full height (default cross-axis is `stretch`).
    bar: {
        flexGrow: 0,
        flexShrink: 0,
        maxHeight: 46,
    },
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingHorizontal: 8,
        paddingVertical: 6,
    },
    key: {
        height: 32,
        justifyContent: 'center',
        paddingHorizontal: 12,
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
