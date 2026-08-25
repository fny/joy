// Dev screen (no i18n): one session driven end-to-end over /joy/v2 —
// event feed, streaming (ephemeral lane), queue with edit/move/delete/retry,
// cancellation with turn precondition, attachment round-trip.
import * as React from 'react';
import { View, Text, TextInput, ScrollView, Pressable } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { StyleSheet } from 'react-native-unistyles';
import { Modal } from '@/modal';
import { v2, V2ApiError, decodeContent, encodeContent, type V2Message } from '@/sync/v2/api';
import { useV2Session, describeEvent } from '@/sync/v2/useV2';

function fail(e: unknown) {
    Modal.alert('v2 error', e instanceof V2ApiError ? `${e.status} ${e.code}` : String(e));
}

export default React.memo(function V2SessionScreen() {
    const { id } = useLocalSearchParams<{ id: string }>();
    const router = useRouter();
    const sessionId = String(id);
    const { state, messages, events, streaming, sseLive, error, refresh } = useV2Session(sessionId);
    const [draft, setDraft] = React.useState('');
    const [busy, setBusy] = React.useState(false);
    const scrollRef = React.useRef<ScrollView>(null);

    const act = (fn: () => Promise<unknown>) => {
        if (busy) return;
        setBusy(true);
        fn().catch(fail).finally(() => { setBusy(false); void refresh(); });
    };

    const send = () => {
        const text = draft.trim();
        if (!text) return;
        setDraft('');
        act(() => v2.sendMessage(sessionId, text));
    };

    const sendWithAttachment = () => act(async () => {
        const text = draft.trim() || 'attachment test';
        setDraft('');
        // Round-trip proof: upload envelope bytes, then cite the id.
        const bytes = new TextEncoder().encode(encodeContent(`attachment for: ${text}`));
        const { attachmentId } = await v2.uploadAttachment(sessionId, bytes);
        await v2.sendMessage(sessionId, text, [attachmentId]);
    });

    const editMessage = (m: V2Message) => {
        void (async () => {
            const next = await Modal.prompt('Edit queued message', undefined, { defaultValue: decodeContent(m.ciphertext) ?? '' });
            if (next !== null && next !== '') act(() => v2.editMessage(sessionId, m.id, next));
        })();
    };

    const cancelActive = () => {
        const turnId = state?.execution.turnId;
        if (!turnId) return;
        act(() => v2.cancelTurn(sessionId, turnId));
    };

    const purge = () => {
        void Modal.confirm('Delete session?', 'Purges events, turns and attachments on the relay').then(okay => {
            if (!okay) return;
            v2.deleteSession(sessionId).then(() => router.back()).catch(fail);
        });
    };

    React.useEffect(() => {
        setTimeout(() => scrollRef.current?.scrollToEnd({ animated: false }), 50);
    }, [events.length, Object.keys(streaming).length]);

    const pending = messages.filter(m => m.status === 'queued' || m.status === 'delivering' || m.status === 'failed');
    const exec = state?.execution;

    return (
        <View style={styles.root}>
            {/* ── status bar ── */}
            <View style={styles.statusBar}>
                <Text style={styles.statusText}>
                    {state
                        ? `${state.sessionState} · daemon ${state.daemon.status} · exec ${exec?.state}${exec?.cancelRequested ? ' (cancelling)' : ''} · ${sseLive ? 'SSE live' : 'polling'}`
                        : 'loading state…'}
                </Text>
                <View style={styles.statusActions}>
                    {exec && exec.state !== 'idle' && exec.turnId ? (
                        <Pressable onPress={cancelActive} style={styles.smallBtn}><Text style={styles.smallBtnText}>Cancel turn</Text></Pressable>
                    ) : null}
                    <Pressable onPress={purge} style={styles.smallBtn}><Text style={styles.smallBtnText}>Delete</Text></Pressable>
                </View>
            </View>
            {error ? <Text style={styles.errorLine}>{error}</Text> : null}

            {/* ── event feed ── */}
            <ScrollView ref={scrollRef} style={styles.feed} contentContainerStyle={styles.feedContent}>
                {events.map(e => {
                    const d = describeEvent(e);
                    return (
                        <View key={e.id} style={[styles.bubble, d.who === 'user' ? styles.bubbleUser : d.who === 'agent' ? styles.bubbleAgent : styles.bubbleSystem]}>
                            <Text style={d.who === 'system' ? styles.systemText : styles.bubbleText}>{d.text}</Text>
                            <Text style={styles.meta}>{`#${e.seq} ${e.kind}`}</Text>
                        </View>
                    );
                })}
                {Object.entries(streaming).map(([turnId, text]) => (
                    <View key={`s-${turnId}`} style={[styles.bubble, styles.bubbleAgent, styles.bubbleStreaming]}>
                        <Text style={styles.bubbleText}>{text}</Text>
                        <Text style={styles.meta}>streaming (ephemeral)…</Text>
                    </View>
                ))}
                {events.length === 0 ? <Text style={styles.systemText}>No events yet.</Text> : null}
            </ScrollView>

            {/* ── delivery queue ── */}
            {pending.length > 0 ? (
                <View style={styles.queueBox}>
                    <Text style={styles.queueTitle}>{`Queue (${pending.length})`}</Text>
                    {pending.map((m, i) => (
                        <View key={m.id} style={styles.queueRow}>
                            <Text style={styles.queueText} numberOfLines={1}>
                                {`${m.status}${m.failure ? ` · ${m.failure.reason}${m.failure.mayHaveDelivered ? ' (may have delivered)' : ''}` : ''} · ${decodeContent(m.ciphertext) ?? ''}`}
                            </Text>
                            <View style={styles.queueActions}>
                                {m.status === 'queued' ? (
                                    <>
                                        <Pressable onPress={() => editMessage(m)} style={styles.smallBtn}><Text style={styles.smallBtnText}>Edit</Text></Pressable>
                                        {i > 0 ? <Pressable onPress={() => act(() => v2.moveMessage(sessionId, m.id, 0))} style={styles.smallBtn}><Text style={styles.smallBtnText}>Top</Text></Pressable> : null}
                                        <Pressable onPress={() => act(() => v2.deleteMessage(sessionId, m.id))} style={styles.smallBtn}><Text style={styles.smallBtnText}>Delete</Text></Pressable>
                                    </>
                                ) : null}
                                {m.status === 'failed' && m.failure?.retryable ? (
                                    <Pressable onPress={() => act(() => v2.retryMessage(sessionId, m.id))} style={styles.smallBtn}><Text style={styles.smallBtnText}>Retry</Text></Pressable>
                                ) : null}
                            </View>
                        </View>
                    ))}
                </View>
            ) : null}

            {/* ── composer ── */}
            <View style={styles.composer}>
                <TextInput
                    style={styles.input}
                    value={draft}
                    onChangeText={setDraft}
                    placeholder="Message via /joy/v2…"
                    multiline
                    onSubmitEditing={send}
                />
                <Pressable onPress={send} disabled={busy} style={styles.sendBtn}><Text style={styles.sendBtnText}>Send</Text></Pressable>
                <Pressable onPress={sendWithAttachment} disabled={busy} style={styles.smallBtn}><Text style={styles.smallBtnText}>+file</Text></Pressable>
            </View>
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    root: { flex: 1, backgroundColor: theme.colors.surface },
    statusBar: {
        flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
        paddingHorizontal: 12, paddingVertical: 8,
        borderBottomWidth: 1, borderBottomColor: theme.colors.divider,
    },
    statusText: { flex: 1, fontSize: 12, color: theme.colors.textSecondary },
    statusActions: { flexDirection: 'row', gap: 6 },
    errorLine: { color: '#c0392b', fontSize: 11, paddingHorizontal: 12, paddingVertical: 4 },
    feed: { flex: 1 },
    feedContent: { padding: 12, gap: 8 },
    bubble: { maxWidth: '85%', borderRadius: 10, paddingHorizontal: 10, paddingVertical: 6 },
    bubbleUser: { alignSelf: 'flex-end', backgroundColor: theme.colors.input.background },
    bubbleAgent: { alignSelf: 'flex-start', backgroundColor: theme.colors.surfaceHigh },
    bubbleSystem: { alignSelf: 'center', backgroundColor: 'transparent' },
    bubbleStreaming: { opacity: 0.8 },
    bubbleText: { color: theme.colors.text, fontSize: 14 },
    systemText: { color: theme.colors.textSecondary, fontSize: 12, fontStyle: 'italic' },
    meta: { color: theme.colors.textSecondary, fontSize: 9, marginTop: 2 },
    queueBox: { borderTopWidth: 1, borderTopColor: theme.colors.divider, padding: 8, gap: 4 },
    queueTitle: { fontSize: 11, fontWeight: '600', color: theme.colors.textSecondary },
    queueRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
    queueText: { flex: 1, fontSize: 12, color: theme.colors.text },
    queueActions: { flexDirection: 'row', gap: 4 },
    composer: {
        flexDirection: 'row', alignItems: 'flex-end', gap: 6,
        padding: 8, borderTopWidth: 1, borderTopColor: theme.colors.divider,
    },
    input: {
        flex: 1, minHeight: 38, maxHeight: 120, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8,
        backgroundColor: theme.colors.input.background, color: theme.colors.input.text, fontSize: 14,
    },
    sendBtn: { backgroundColor: theme.colors.button.primary.background, borderRadius: 8, paddingHorizontal: 14, paddingVertical: 9 },
    sendBtnText: { color: theme.colors.button.primary.tint, fontWeight: '600', fontSize: 13 },
    smallBtn: { backgroundColor: theme.colors.input.background, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 5 },
    smallBtnText: { color: theme.colors.text, fontSize: 11 },
}));
