// Interactive tmux pane for a joy-tmux session: live-ish view of the
// terminal (joy-pane poll) plus a raw keyboard input that supports
// bracketed key tokens (git commit<Enter>oops<C-c>) via the joy-send-keys
// machine RPC. This is the intervention surface for things the chat path
// can't reach: folder-trust prompts, TUI menus, a wedged claude.
//
// Token dialects are parsed server-side (joy-tmux keyTokens.ts):
// <Enter>/<CR>, <C-c>/<ctrl+c>/<^c>, <alt+x>/<meta-x>/<M-x>,
// <cmd+k>→Meta, <ctrl+shift+a>, <S-Tab>/<BTab>, <Esc>, <Up>, <F5>, <lt>…
// Unknown tokens pass through as literal text.
import * as React from 'react';
import { View, Text, TextInput, Pressable, ScrollView, ActivityIndicator, Platform } from 'react-native';
import { useLocalSearchParams, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { apiSocket } from '@/sync/apiSocket';
import { Modal } from '@/modal';

const POLL_MS = 1500;

// One-tap keys for the most common interventions.
const QUICK_KEYS: { label: string; script: string }[] = [
    { label: 'Enter', script: '<Enter>' },
    { label: 'Esc', script: '<Esc>' },
    { label: '^C', script: '<C-c>' },
    { label: 'Tab', script: '<Tab>' },
    { label: '↑', script: '<Up>' },
    { label: '↓', script: '<Down>' },
    { label: '1', script: '1' },
    { label: '2', script: '2' },
];

export default React.memo(function JoyPaneScreen() {
    const { theme } = useUnistyles();
    const params = useLocalSearchParams<{ machine: string; id: string }>();
    const machineId = String(params.machine ?? '');
    const sessionId = String(params.id ?? '');

    const [pane, setPane] = React.useState<string>('');
    const [paneError, setPaneError] = React.useState<string | null>(null);
    const [input, setInput] = React.useState('');
    const [sending, setSending] = React.useState(false);
    // false = key-token mode (parse <Enter>, <C-c>…); true = plain text sent verbatim.
    const [literalMode, setLiteralMode] = React.useState(false);
    const scrollRef = React.useRef<ScrollView>(null);
    const mountedRef = React.useRef(true);

    React.useEffect(() => {
        mountedRef.current = true;
        return () => { mountedRef.current = false; };
    }, []);

    const refresh = React.useCallback(async () => {
        try {
            const result = await Promise.race([
                apiSocket.machineRPC<{ ok?: boolean; text?: string; error?: string }, { id: string }>(
                    machineId, 'joy-pane', { id: sessionId },
                ),
                new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
            ]);
            if (!mountedRef.current) return;
            if (result.error) {
                setPaneError(result.error);
            } else {
                setPane(result.text ?? '');
                setPaneError(null);
            }
        } catch (e) {
            if (mountedRef.current) setPaneError(e instanceof Error ? e.message : String(e));
        }
    }, [machineId, sessionId]);

    // Poll while the screen is focused.
    useFocusEffect(React.useCallback(() => {
        void refresh();
        const timer = setInterval(() => void refresh(), POLL_MS);
        return () => clearInterval(timer);
    }, [refresh]));

    const sendScript = React.useCallback(async (script: string, literal = false) => {
        if (!script) return;
        setSending(true);
        try {
            const result = await Promise.race([
                apiSocket.machineRPC<{ ok?: boolean; error?: string }, { id: string; script: string; literal?: boolean }>(
                    machineId, 'joy-send-keys', { id: sessionId, script, literal },
                ),
                new Promise<never>((_, reject) => setTimeout(() => reject(new Error('joy-tmux did not respond')), 10000)),
            ]);
            if (result.error) {
                Modal.alert('Error', result.error);
                return;
            }
            // Tight feedback loop: re-poll right after the keys land.
            setTimeout(() => void refresh(), 250);
        } catch (e) {
            Modal.alert('Error', e instanceof Error ? e.message : String(e));
        } finally {
            if (mountedRef.current) setSending(false);
        }
    }, [machineId, sessionId, refresh]);

    const handleSend = React.useCallback(() => {
        const script = input;
        if (!script.trim()) return;
        setInput('');
        // In plain-text mode the input is typed verbatim — <Enter>, <C-c> etc.
        // land as literal characters, not keys.
        void sendScript(script, literalMode);
    }, [input, sendScript, literalMode]);

    return (
        <View style={styles.container}>
            {/* Pane view */}
            <ScrollView
                ref={scrollRef}
                style={styles.paneScroll}
                onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: false })}
            >
                <ScrollView horizontal>
                    <Text style={styles.paneText} selectable>
                        {paneError ? `⚠ ${paneError}` : (pane || '…')}
                    </Text>
                </ScrollView>
            </ScrollView>

            {/* Quick keys */}
            <View style={styles.quickRow}>
                {QUICK_KEYS.map(k => (
                    <Pressable
                        key={k.label}
                        onPress={() => void sendScript(k.script)}
                        style={(p) => [styles.quickKey, p.pressed && styles.quickKeyPressed]}
                        disabled={sending}
                    >
                        <Text style={styles.quickKeyText}>{k.label}</Text>
                    </Pressable>
                ))}
            </View>

            {/* Raw input */}
            <View style={styles.inputRow}>
                <Pressable
                    onPress={() => setLiteralMode(v => !v)}
                    style={(p) => [styles.modeToggle, literalMode && styles.modeToggleActive, p.pressed && styles.quickKeyPressed]}
                    hitSlop={6}
                >
                    <Text style={[styles.modeToggleText, literalMode && styles.modeToggleTextActive]}>
                        {literalMode ? 'text' : 'keys'}
                    </Text>
                </Pressable>
                <TextInput
                    value={input}
                    onChangeText={setInput}
                    placeholder={literalMode ? 'plain text, sent verbatim' : 'git commit<Enter>oops<C-c>'}
                    placeholderTextColor="#666"
                    style={styles.input}
                    autoCapitalize="none"
                    autoCorrect={false}
                    spellCheck={false}
                    onSubmitEditing={handleSend}
                    blurOnSubmit={false}
                    returnKeyType="send"
                />
                <Pressable
                    onPress={handleSend}
                    disabled={sending || !input.trim()}
                    style={(p) => [styles.sendButton, (p.pressed || sending) && styles.quickKeyPressed]}
                >
                    {sending
                        ? <ActivityIndicator size="small" color={theme.colors.button.primary.tint} />
                        : <Ionicons name="arrow-forward" size={18} color={theme.colors.button.primary.tint} />}
                </Pressable>
            </View>
            <Text style={styles.hint}>
                {literalMode
                    ? 'text mode: typed verbatim — <Enter>, <C-c> land as literal characters. Tap “text” to switch back to keys.'
                    : 'keys mode: <Enter> <Esc> <C-c> <ctrl+shift+a> <alt+x> <S-Tab> <Up> <F5> <lt>. Tap “keys” for plain text.'}
            </Text>
        </View>
    );
});

const styles = StyleSheet.create((theme, runtime) => ({
    container: {
        flex: 1,
        backgroundColor: '#0c0c0c',
        paddingBottom: runtime.insets.bottom,
    },
    paneScroll: {
        flex: 1,
        paddingHorizontal: 8,
        paddingTop: 8,
    },
    paneText: {
        color: '#d4d4d4',
        fontSize: 11,
        lineHeight: 15,
        fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
    },
    quickRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 6,
        paddingHorizontal: 8,
        paddingVertical: 6,
    },
    quickKey: {
        paddingHorizontal: 12,
        paddingVertical: 6,
        borderRadius: 6,
        backgroundColor: '#262626',
        borderWidth: 1,
        borderColor: '#3a3a3a',
    },
    quickKeyPressed: {
        opacity: 0.5,
    },
    quickKeyText: {
        color: '#d4d4d4',
        fontSize: 13,
        fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
    },
    inputRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: 8,
        paddingBottom: 4,
    },
    modeToggle: {
        paddingHorizontal: 10,
        height: 34,
        borderRadius: 8,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: '#1e1e1e',
        borderWidth: 1,
        borderColor: '#333',
    },
    modeToggleActive: {
        backgroundColor: '#2d4a2d',
        borderColor: '#3a7a3a',
    },
    modeToggleText: {
        color: '#8a8a8a',
        fontSize: 12,
        fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
    },
    modeToggleTextActive: {
        color: '#7ee07e',
    },
    input: {
        flex: 1,
        color: '#d4d4d4',
        fontSize: 13,
        fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
        backgroundColor: '#1a1a1a',
        borderWidth: 1,
        borderColor: '#3a3a3a',
        borderRadius: 8,
        paddingHorizontal: 10,
        paddingVertical: 8,
        ...Platform.select({ web: { outlineStyle: 'none' } as any, default: {} }),
    },
    sendButton: {
        width: 36,
        height: 36,
        borderRadius: 18,
        backgroundColor: theme.colors.button.primary.background,
        alignItems: 'center',
        justifyContent: 'center',
    },
    hint: {
        color: '#666',
        fontSize: 10,
        paddingHorizontal: 8,
        paddingBottom: 6,
        fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
    },
}));
