import * as React from 'react';
import { View, TextInput, Pressable } from 'react-native';
import { Text } from '@/components/StyledText';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { sync } from '@/sync/sync';
import { Typography } from '@/constants/Typography';
import { useDrafts, useDraftQueueStore, type QueuedDraft } from './draftQueue';

// Pinned at the bottom of the chat (above the input). Lists the on-device draft
// messages the user has queued up — each can be edited inline, deleted, or sent.
// Sending routes through the normal send path; nothing here reaches joy-tmux
// until the user hits send.
export const DraftQueueStrip = React.memo(function DraftQueueStrip({ sessionId }: { sessionId: string }) {
    const drafts = useDrafts(sessionId);
    if (drafts.length === 0) return null;
    return (
        <View style={styles.wrap}>
            <Text style={styles.header}>{`DRAFTS · ${drafts.length}`}</Text>
            {drafts.map((d) => (
                <DraftRow key={d.id} sessionId={sessionId} draft={d} />
            ))}
        </View>
    );
});

const DraftRow = React.memo(function DraftRow({ sessionId, draft }: { sessionId: string; draft: QueuedDraft }) {
    const { theme } = useUnistyles();
    const update = useDraftQueueStore((s) => s.update);
    const remove = useDraftQueueStore((s) => s.remove);

    const onSend = React.useCallback(() => {
        const text = draft.text.trim();
        if (text) sync.sendMessage(sessionId, draft.text, { source: 'chat' });
        remove(sessionId, draft.id);
    }, [sessionId, draft.id, draft.text, remove]);

    return (
        <View style={styles.row}>
            <TextInput
                value={draft.text}
                onChangeText={(t) => update(sessionId, draft.id, t)}
                multiline
                placeholder="Draft…"
                placeholderTextColor={theme.colors.textSecondary as string}
                style={[styles.input, { color: theme.colors.text, backgroundColor: theme.colors.input.background }]}
            />
            <Pressable
                onPress={() => remove(sessionId, draft.id)}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel="Delete draft"
                style={(p) => [styles.iconButton, { opacity: p.pressed ? 0.6 : 1 }]}
            >
                <Ionicons name="trash-outline" size={18} color={theme.colors.textSecondary} />
            </Pressable>
            <Pressable
                onPress={onSend}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel="Send draft"
                style={(p) => [styles.iconButton, styles.sendButton, { backgroundColor: theme.colors.button.primary.background, opacity: p.pressed ? 0.7 : 1 }]}
            >
                <Ionicons name="arrow-up" size={16} color={theme.colors.button.primary.tint} />
            </Pressable>
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    wrap: {
        marginHorizontal: 8,
        marginBottom: 8,
        gap: 6,
    },
    header: {
        fontSize: 11,
        color: theme.colors.textSecondary,
        marginLeft: 8,
        ...Typography.default('semiBold'),
    },
    row: {
        flexDirection: 'row',
        alignItems: 'flex-end',
        gap: 8,
    },
    input: {
        flex: 1,
        minHeight: 38,
        maxHeight: 120,
        borderRadius: 12,
        paddingHorizontal: 12,
        paddingVertical: 8,
        fontSize: 15,
        ...Typography.default(),
    },
    iconButton: {
        width: 32,
        height: 32,
        alignItems: 'center',
        justifyContent: 'center',
        marginBottom: 3,
    },
    sendButton: {
        borderRadius: 16,
    },
}));
