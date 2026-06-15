// Interactive tmux pane for a joy-tmux session: live-ish view of the
// terminal (joy-pane poll) plus a text input that submits messages (typed +
// Enter) by default. A "Raw" toggle switches to bracketed key tokens
// (git commit<Enter>oops<C-c>), sent via the joy-send-keys machine RPC. This is
// the intervention surface for things the chat path can't reach: folder-trust
// prompts, TUI menus, a wedged claude.
//
// Token dialects are parsed server-side (joy-tmux keyTokens.ts):
// <Enter>/<CR>, <C-c>/<ctrl+c>/<^c>, <alt+x>/<meta-x>/<M-x>,
// <cmd+k>→Meta, <ctrl+shift+a>, <S-Tab>/<BTab>, <Esc>, <Up>, <F5>, <lt>…
// Unknown tokens pass through as literal text.
import * as React from 'react';
import { View, Text, TextInput, Pressable, ScrollView, ActivityIndicator, Platform } from 'react-native';
import { useLocalSearchParams, useFocusEffect, router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { apiSocket } from '@/sync/apiSocket';
import { Modal } from '@/modal';
import { AnsiText } from '@/components/AnsiText';

const POLL_MS = 1500;
// Pane font metrics — char width ≈ 0.6em for the mono fonts below; used to
// map the rendered pixel width to terminal columns for adaptive sizing.
const PANE_LINE_HEIGHT = 15; // must match styles.paneText.lineHeight
const CHAR_WIDTH = 11 * 0.6; // styles.paneText.fontSize (11) × mono advance ≈ 0.6em
const PANE_H_PADDING = 16; // styles.paneScroll paddingHorizontal (8) × 2

// One-tap keys for the most common interventions.
const QUICK_KEYS: { label: string; script: string }[] = [
    { label: 'Enter', script: '<Enter>' },
    { label: 'Esc', script: '<Esc>' },
    { label: '^C', script: '<C-c>' },
    { label: 'Del', script: '<Del>' },
    { label: 'Tab', script: '<Tab>' },
    { label: '↑', script: '<Up>' },
    { label: '↓', script: '<Down>' },
    { label: 'PgUp', script: '<PgUp>' },
    { label: 'PgDn', script: '<PgDn>' },
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
    // Raw OFF (default) = text mode: input is typed verbatim and submitted with a
    // real Enter. Raw ON = key-token mode: parse <Enter>, <C-c>… and send as keys.
    const [rawMode, setRawMode] = React.useState(false);
    const scrollRef = React.useRef<ScrollView>(null);
    const mountedRef = React.useRef(true);

    React.useEffect(() => {
        mountedRef.current = true;
        return () => { mountedRef.current = false; };
    }, []);

    const refresh = React.useCallback(async () => {
        try {
            const result = await Promise.race([
                apiSocket.machineRPC<{ ok?: boolean; text?: string; error?: string }, { id: string; color?: boolean }>(
                    machineId, 'joy-pane', { id: sessionId, color: true },
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

    // Adaptive width: tell the daemon to size the tmux window to our rendered
    // pane — "last connector drives the width". Only fires when the column
    // count actually changes (each resize reflows claude's TUI), and is
    // re-asserted on focus so re-opening on a different device re-claims.
    const lastColsRef = React.useRef(0);
    const drivePaneSize = React.useCallback((widthPx: number, heightPx: number) => {
        // floor (not round) of the padding-adjusted width, so the rendered line
        // never exceeds the content box — otherwise it wraps or (previously)
        // scrolled sideways.
        const cols = Math.max(20, Math.floor((widthPx - PANE_H_PADDING) / CHAR_WIDTH));
        const rows = Math.max(10, Math.round(heightPx / PANE_LINE_HEIGHT));
        if (cols === lastColsRef.current || !cols) return;
        lastColsRef.current = cols;
        void apiSocket.machineRPC(machineId, 'joy-resize', { id: sessionId, cols, rows })
            .then(() => setTimeout(() => void refresh(), 200))
            .catch(() => { /* best-effort */ });
    }, [machineId, sessionId, refresh]);

    // Poll while the screen is focused.
    useFocusEffect(React.useCallback(() => {
        // Re-claim the width on focus (the size may have drifted to another
        // viewer or a real terminal since we last looked).
        lastColsRef.current = 0;
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
        if (!input.trim()) return;
        const script = input;
        setInput('');
        if (rawMode) {
            // raw keys mode: parse <Enter>/<C-c>/… tokens and send as-is.
            void sendScript(script, false);
        } else {
            // text mode (default): type the message verbatim, then submit with a
            // real Enter key (in literal mode "<Enter>" would type as characters).
            void (async () => {
                await sendScript(script, true);
                await sendScript('<Enter>', false);
            })();
        }
    }, [input, sendScript, rawMode]);

    return (
        <View style={styles.container}>
            {/* Header is hidden for a full-height terminal — keep a back affordance
                on mobile (web navigates via the sidebar). */}
            {Platform.OS !== 'web' && (
                <Pressable
                    onPress={() => router.back()}
                    style={(p) => [styles.backButton, p.pressed && styles.quickKeyPressed]}
                    hitSlop={8}
                    accessibilityRole="button"
                    accessibilityLabel="Back"
                >
                    <Ionicons name="chevron-back" size={22} color="#d4d4d4" />
                </Pressable>
            )}
            {/* Pane view — vertical scroll only; the window is sized to fit this
                width (adaptive resize), so there's no horizontal scroll to drift. */}
            <ScrollView
                ref={scrollRef}
                style={styles.paneScroll}
                onLayout={(e) => drivePaneSize(e.nativeEvent.layout.width, e.nativeEvent.layout.height)}
                onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: false })}
            >
                {paneError
                    ? <Text style={styles.paneText} selectable>{`⚠ ${paneError}`}</Text>
                    : <AnsiText text={pane || '…'} style={styles.paneText} />}
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
                    onPress={() => setRawMode(v => !v)}
                    style={(p) => [styles.modeToggle, rawMode && styles.modeToggleActive, p.pressed && styles.quickKeyPressed]}
                    hitSlop={6}
                    accessibilityRole="switch"
                    accessibilityState={{ checked: rawMode }}
                    accessibilityLabel="Raw key mode"
                >
                    <Text style={[styles.modeToggleText, rawMode && styles.modeToggleTextActive]}>
                        {rawMode ? '⌨ Raw' : 'Raw'}
                    </Text>
                </Pressable>
                <TextInput
                    value={input}
                    onChangeText={setInput}
                    placeholder={rawMode ? 'git commit<Enter>oops<C-c>' : 'type a message…'}
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
                {rawMode
                    ? 'Raw is ON: <Enter> <Esc> <C-c> <ctrl+shift+a> <alt+x> <S-Tab> <Up> <F5> <lt> are parsed and sent as keystrokes. Tap “Raw” to turn it off and send plain text.'
                    : 'Your message is typed and submitted with Enter. Tap “Raw” to turn on key tokens like <Enter> or <C-c> instead.'}
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
        // Clear the status bar / notch now that there's no header above us.
        paddingTop: runtime.insets.top + 8,
    },
    backButton: {
        position: 'absolute',
        top: runtime.insets.top + 6,
        left: 10,
        width: 38,
        height: 38,
        borderRadius: 19,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'rgba(38,38,38,0.92)',
        borderWidth: 1,
        borderColor: '#3a3a3a',
        zIndex: 10,
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
        color: theme.colors.textSecondary,
        fontSize: 10,
        paddingHorizontal: 8,
        paddingBottom: 6,
        fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
    },
}));
