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
    // ⌫ = Backspace (erase left) — what a terminal user means by "delete".
    // The old 'Del' button sent <Del> (tmux DC, FORWARD-delete), which no-ops
    // at end-of-line, i.e. almost always — "why doesn't del send backspace?".
    { label: '⌫', script: '<BS>' },
    { label: 'Tab', script: '<Tab>' },
    { label: '↑', script: '<Up>' },
    { label: '↓', script: '<Down>' },
    // Word-wise editing/motion (readline/emacs bindings, which claude's box
    // and most TUIs honor): ⌫W kills the word left, ⌦W the word right;
    // ←W/→W move by word. Home/End jump line edges; ^U kills to line start,
    // ^D forward-deletes (or EOFs an empty shell line — the classic).
    { label: '⌫W', script: '<C-w>' },
    { label: '⌦W', script: '<M-d>' },
    { label: '←W', script: '<M-b>' },
    { label: '→W', script: '<M-f>' },
    { label: 'Home', script: '<Home>' },
    { label: 'End', script: '<End>' },
    { label: '^U', script: '<C-u>' },
    { label: '^D', script: '<C-d>' },
    { label: 'PgUp', script: '<PgUp>' },
    { label: 'PgDn', script: '<PgDn>' },
    { label: '⇧Tab', script: '<S-Tab>' },
    { label: 'Del', script: '<Del>' },
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
