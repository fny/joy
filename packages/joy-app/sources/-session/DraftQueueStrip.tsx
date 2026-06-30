import * as React from 'react';
import { View, TextInput, Pressable, Platform } from 'react-native';
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
    const { theme } = useUnistyles();
    const drafts = useDrafts(sessionId);
    const [collapsed, setCollapsed] = React.useState(false);
    if (drafts.length === 0) return null;
    return (
        <View style={styles.wrap}>
            <Pressable
                onPress={() => setCollapsed((c) => !c)}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel={collapsed ? 'Expand drafts' : 'Collapse drafts'}
                style={(p) => [styles.headerRow, { opacity: p.pressed ? 0.6 : 1 }]}
            >
                <Text style={styles.header}>{`DRAFTS · ${drafts.length}`}</Text>
                <Ionicons
                    name={collapsed ? 'chevron-up' : 'chevron-down'}
                    size={14}
                    color={theme.colors.textSecondary}
                />
            </Pressable>
            {!collapsed && drafts.map((d) => (
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
                style={[
                    styles.input,
                    { color: theme.colors.text, backgroundColor: theme.colors.input.background },
                    // Kill the browser focus ring on web (no border on active).
                    Platform.OS === 'web' ? ({ outlineStyle: 'none' } as any) : null,
                ]}
            />
            {/* Delete (×) and send (↑) sit inside the input box, bottom-right. */}
            <View style={styles.actions}>
                <Pressable
                    onPress={() => remove(sessionId, draft.id)}
                    hitSlop={8}
                    accessibilityRole="button"
                    accessibilityLabel="Delete draft"
                    style={(p) => [styles.iconButton, { opacity: p.pressed ? 0.6 : 1 }]}
                >
                    <Ionicons name="close" size={20} color={theme.colors.textSecondary} />
                </Pressable>
                <Pressable
                    onPress={onSend}
                    hitSlop={8}
                    accessibilityRole="button"
                    accessibilityLabel="Send draft"
                    style={(p) => [styles.iconButton, { opacity: p.pressed ? 0.5 : 1 }]}
                >
                    <Ionicons name="arrow-up" size={22} color={theme.colors.text} />
                </Pressable>
            </View>
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    wrap: {
        marginBottom: 8,
        gap: 6,
    },
    headerRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        marginLeft: 8,
        paddingVertical: 2,
    },
    header: {
        fontSize: 11,
        color: theme.colors.textSecondary,
        ...Typography.default('semiBold'),
    },
    row: {
        position: 'relative',
    },
    input: {
        minHeight: 60, // ~two lines tall
        maxHeight: 120,
        borderRadius: 12,
        paddingHorizontal: 12,
        paddingVertical: 8,
        paddingRight: 76, // clearance for the in-box action buttons
        fontSize: 15,
        ...Typography.default(),
    },
    actions: {
        position: 'absolute',
        right: 6,
        top: 0,
        bottom: 0,
        flexDirection: 'row',
        alignItems: 'center', // vertically center within the box
        gap: 4,
    },
    iconButton: {
        width: 30,
        height: 30,
        alignItems: 'center',
        justifyContent: 'center',
    },
}));
