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
import Ionicons from '@expo/vector-icons/Ionicons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { apiSocket } from '@/sync/apiSocket';
import { Modal } from '@/modal';
import { AnsiText } from '@/components/AnsiText';
import { TerminalKeyBar } from '@/components/TerminalKeyBar';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { useActiveInterval } from '@/hooks/useActiveInterval';
import { useIsTablet } from '@/utils/responsive';
import { useRootGutter } from '@/hooks/useRootGutter';
import { sync } from '@/sync/sync';
import { machinePane, machineResize, machineSendKeys } from '@/sync/v2/machine';
import { paneSizeFor, paneSizeChanged, type PaneSize } from '@/utils/paneSize';
import { describePaneError } from '@/utils/paneError';

const POLL_MS = 1500;

// Simple mode: strip the claude TUI's status chrome from the capture — the
// permission/shortcut hint line, git-branch/subagent/artifact widgets — i.e.
// everything BELOW the input box's bottom border, plus the box borders
// themselves (the ❯ prompt line stays so typed text is visible). Fails OPEN:
// if the capture doesn't end in the prompt-box shape (a TUI dialog, a menu, a
// crashed claude), nothing is stripped — those are exactly the moments this
// screen exists for.
function simplifyPane(text: string): string {
    const lines = text.split('\n');
    let prompt = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
        if (/^\s*[❯>]($|\s)/.test(lines[i])) { prompt = i; break; }
    }
    if (prompt < 0) return text;
    const isDivider = (l: string) => /─{3,}/.test(l) && /^[\s─]*\S{0,12}[\s─]*$/.test(l.replace(/─+/g, '─'));
    let end = lines.length;
    for (let i = prompt + 1; i < lines.length; i++) {
        if (isDivider(lines[i])) { end = i; break; }
    }
    if (end === lines.length) return text; // no bottom border → not the idle box shape
    const kept = lines.slice(0, end).filter((l, i) => !(i === prompt - 1 && isDivider(l)));
    while (kept.length && !kept[kept.length - 1].trim()) kept.pop();
    return kept.join('\n');
}
export default React.memo(function JoyPaneScreen() {
    const { theme } = useUnistyles();
    const params = useLocalSearchParams<{ machine: string; id: string }>();
    const machineId = String(params.machine ?? '');
    const sessionId = String(params.id ?? '');

    const isTablet = useIsTablet();
    // Landscape gutters (root safe-area strips) melt into the terminal's dark
    // background while this screen is focused, instead of theme-colored bars.
    useFocusEffect(React.useCallback(() => {
        useRootGutter.getState().setColor('#0c0c0c');
        return () => useRootGutter.getState().setColor(null);
    }, []));
    const [pane, setPane] = React.useState<string>('');
    const [paneError, setPaneError] = React.useState<string | null>(null);
    const [input, setInput] = React.useState('');
    const [sending, setSending] = React.useState(false);
    // Raw OFF (default) = text mode: input is typed verbatim and submitted with a
    // real Enter. Raw ON = key-token mode: parse <Enter>, <C-c>… and send as keys.
    const [rawMode, setRawMode] = React.useState(false);
    // Simple ON by default: the status chrome matters only when intervening,
    // and the toggle is one tap away.
    const [simpleMode, setSimpleMode] = React.useState(true);
    const failure = React.useMemo(() => describePaneError(paneError), [paneError]);
    const scrollRef = React.useRef<ScrollView>(null);
    const mountedRef = React.useRef(true);

    React.useEffect(() => {
        mountedRef.current = true;
        return () => { mountedRef.current = false; };
    }, []);

    const refresh = React.useCallback(async () => {
        try {
            // v2: read the pane from the daemon over the sealed tunnel.
            const mctx = sync.machineCtxFor(machineId, sessionId);
            const result = await Promise.race([
                mctx
                    ? machinePane(mctx, true).then(r => (r.data ?? { error: 'no response' }) as { ok?: boolean; text?: string; error?: string })
                    : apiSocket.machineRPC<{ ok?: boolean; text?: string; error?: string }, { id: string; color?: boolean }>(
                        machineId, 'joy-pane', { id: sessionId, color: true },
                    ),
                new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 8000)),
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
    const lastSizeRef = React.useRef<PaneSize | null>(null);
    const drivePaneSize = React.useCallback((widthPx: number, heightPx: number) => {
        // Sizing rules (and the breakage behind them) live in @/utils/paneSize.
        const size = paneSizeFor(widthPx, heightPx);
        if (!size || !paneSizeChanged(size, lastSizeRef.current)) return;
        lastSizeRef.current = size;
        const { cols, rows } = size;
        const rctx = sync.machineCtxFor(machineId, sessionId);
        void (rctx ? machineResize(rctx, cols, rows) : apiSocket.machineRPC(machineId, 'joy-resize', { id: sessionId, cols, rows }))
            .then(() => setTimeout(() => void refresh(), 200))
            .catch(() => { /* best-effort */ });
    }, [machineId, sessionId, refresh]);

    // Re-claim the size on focus (it may have drifted to another viewer or a
    // real terminal since we last looked).
    useFocusEffect(React.useCallback(() => { lastSizeRef.current = null; }, []));
    // Poll only while focused AND foregrounded so a locked phone doesn't keep
    // mirroring the pane every 1.5s (battery — see useActiveInterval).
    useActiveInterval(() => void refresh(), POLL_MS);

    // Returns true only when the keys actually landed — callers that chain a
    // follow-up (text mode's submit Enter) must gate on it: an unconditional
    // Enter after a FAILED text send would submit whatever already sits in
    // Claude's input box, or answer a TUI prompt.
    const sendScript = React.useCallback(async (script: string, literal = false): Promise<boolean> => {
        if (!script) return false;
        setSending(true);
        try {
            const kctx = sync.machineCtxFor(machineId, sessionId);
            const result = await Promise.race([
                kctx
                    ? machineSendKeys(kctx, script, literal).then(r => (r.data ?? { error: 'no response' }) as { ok?: boolean; error?: string })
                    : apiSocket.machineRPC<{ ok?: boolean; error?: string }, { id: string; script: string; literal?: boolean }>(
                        machineId, 'joy-send-keys', { id: sessionId, script, literal },
                    ),
                new Promise<never>((_, reject) => setTimeout(() => reject(new Error('joy-tmux did not respond')), 10000)),
            ]);
            if (result.error) {
                Modal.alert('Error', result.error);
                return false;
            }
            // Tight feedback loop: re-poll right after the keys land.
            setTimeout(() => void refresh(), 250);
            return true;
        } catch (e) {
            Modal.alert('Error', e instanceof Error ? e.message : String(e));
            return false;
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
                if (await sendScript(script, true)) {
                    await sendScript('<Enter>', false);
                }
            })();
        }
    }, [input, sendScript, rawMode]);

    // The header is hidden (full-height terminal), so on iOS the keyboard would
    // overlay the quick-keys + input row. Lift the whole column above it with the
    // keyboard-controller's KeyboardAvoidingView (no-op wrapper on other platforms).
    const KeyboardWrapper = Platform.OS === 'ios' ? KeyboardAvoidingView : React.Fragment;
    const keyboardProps = Platform.OS === 'ios'
        ? { behavior: 'padding' as const, keyboardVerticalOffset: 0, style: styles.flex }
        : {};

    return (
        <KeyboardWrapper {...keyboardProps}>
        <View style={styles.container}>
            {/* Header is hidden for a full-height terminal — show a back affordance
                whenever the sidebar is collapsed (narrow width / phone), matching the
                chat view's `!isTablet` rule so web-narrow gets a way back too. */}
            {!isTablet && (
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
            {/* A failed poll (timeout, daemon blip) must NOT blank the terminal —
                keep the last capture visible + scrollable and show a small banner
                instead. The 1.5s poll keeps retrying, and a success clears the
                banner + refreshes the text. */}
            {failure?.kind === 'transient' && (
                <View style={styles.errorBanner}>
                    <Text style={styles.errorBannerText} numberOfLines={2}>
                        {`⚠ ${failure.message}`}
                    </Text>
                </View>
            )}
            <ScrollView
                ref={scrollRef}
                style={styles.paneScroll}
                onLayout={(e) => drivePaneSize(e.nativeEvent.layout.width, e.nativeEvent.layout.height)}
                onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: false })}
            >
                {failure?.kind === 'gone' && !pane ? (
                    <Text style={styles.paneGoneText}>{failure.message}</Text>
                ) : (
                    <AnsiText text={(simpleMode ? simplifyPane(pane) : pane) || '…'} style={styles.paneText} />
                )}
            </ScrollView>

            {/* Quick keys — horizontally scrollable */}
            <TerminalKeyBar onKey={(script, literal) => void sendScript(script, literal)} disabled={sending} />

            {/* Raw input */}
            <View style={styles.inputRow}>
                <Pressable
                    onPress={() => setSimpleMode(v => !v)}
                    style={(p) => [styles.modeToggle, !simpleMode && styles.modeToggleActive, p.pressed && styles.quickKeyPressed]}
                    hitSlop={6}
                    accessibilityRole="switch"
                    accessibilityState={{ checked: !simpleMode }}
                    accessibilityLabel="Show full terminal chrome"
                >
                    <Text style={[styles.modeToggleText, !simpleMode && styles.modeToggleTextActive]}>
                        Full
                    </Text>
                </Pressable>
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
                        : <Ionicons name="arrow-up" size={18} color={theme.colors.button.primary.tint} />}
                </Pressable>
            </View>
        </View>
        </KeyboardWrapper>
    );
});

const styles = StyleSheet.create((theme, runtime) => ({
    flex: {
        flex: 1,
    },
    container: {
        flex: 1,
        backgroundColor: '#0c0c0c',
        paddingBottom: runtime.insets.bottom,
    },
    errorBanner: {
        backgroundColor: 'rgba(255, 149, 0, 0.18)',
        borderBottomWidth: 1,
        borderBottomColor: 'rgba(255, 149, 0, 0.35)',
        paddingVertical: 5,
        paddingHorizontal: 12,
    },
    errorBannerText: {
        color: '#FFB340',
        fontSize: 12,
    },
    // A session that is gone is not an error flash — it replaces the pane, so
    // the view says what happened instead of showing an empty terminal.
    paneGoneText: {
        color: '#9a9a9a',
        fontSize: 13,
        lineHeight: 19,
        paddingVertical: 24,
        paddingHorizontal: 4,
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
    quickKeyPressed: {
        opacity: 0.5,
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
}));
