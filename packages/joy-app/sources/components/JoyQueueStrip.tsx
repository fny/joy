// Pending-message strip shown above the composer for joy-tmux sessions. Lists
// only messages still WAITING behind a processing turn — once the daemon
// dispatches one it leaves the queue and shows up in chat, so there's no
// "sending…" limbo row here. Edit/Delete live behind a long-press (touch) or
// right-click (web) menu so they're not hit by accident.
import * as React from 'react';
import { View, Text, Pressable, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import type { useJoyQueue } from '@/hooks/useJoyQueue';

type Queue = ReturnType<typeof useJoyQueue>;

export const JoyQueueStrip = React.memo(({ queue }: { queue: Queue }) => {
    const { theme } = useUnistyles();
    // Only waiting items (and the paused banner). The in-flight message has
    // left the queue — no "sending" block.
    const hasItems = queue.queue.length > 0 || queue.paused;
    if (!hasItems) return null;

    const editItem = async (id: string, current: string) => {
        const next = await Modal.prompt('Edit queued message', '', { defaultValue: current });
        if (next != null && next.trim() && next.trim() !== current) queue.edit(id, next.trim());
    };

    const showMenu = (id: string, text: string) => {
        Modal.alert('Queued message', text, [
            { text: 'Edit', onPress: () => { void editItem(id, text); } },
            { text: 'Delete', style: 'destructive', onPress: () => { void queue.cancel(id); } },
            { text: 'Cancel', style: 'cancel' },
        ]);
    };

    return (
        <View style={styles.wrap}>
            {queue.paused && (
                <Pressable style={styles.pausedRow} onPress={() => queue.resume()}>
                    <Ionicons name="warning-outline" size={15} color="#FF9500" />
                    <Text style={styles.pausedText} numberOfLines={1}>
                        A queued message didn’t send — tap to resume
                    </Text>
                </Pressable>
            )}

            {queue.queue.map((m, i) => (
                <Pressable
                    key={m.id}
                    style={(p) => [styles.row, p.pressed && styles.rowPressed]}
                    onLongPress={() => showMenu(m.id, m.text)}
                    delayLongPress={350}
                    // Desktop web: right-click opens the same menu.
                    {...(Platform.OS === 'web'
                        ? { onContextMenu: (e: any) => { e?.preventDefault?.(); showMenu(m.id, m.text); } }
                        : {})}
                >
                    <Ionicons name="time-outline" size={13} color={theme.colors.textSecondary} />
                    <Text style={styles.idx}>{i + 1}</Text>
                    <Text style={styles.text} numberOfLines={2}>{m.text}</Text>
                </Pressable>
            ))}

            {queue.queue.length > 0 && (
                <Text style={styles.hint}>
                    {Platform.OS === 'web' ? 'right-click' : 'hold'} a message to edit or delete
                </Text>
            )}
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    wrap: {
        marginHorizontal: 8,
        marginBottom: 6,
        backgroundColor: theme.colors.input.background,
        borderRadius: 12,
        paddingVertical: 4,
        overflow: 'hidden',
    },
    pausedRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingHorizontal: 12,
        paddingVertical: 8,
    },
    pausedText: {
        flex: 1,
        fontSize: 12,
        color: '#FF9500',
        ...Typography.default('semiBold'),
    },
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: 12,
        paddingVertical: 7,
    },
    rowPressed: {
        backgroundColor: theme.colors.surfacePressed,
    },
    idx: {
        fontSize: 11,
        minWidth: 12,
        textAlign: 'center',
        color: theme.colors.textSecondary,
        ...Typography.mono(),
    },
    text: {
        flex: 1,
        fontSize: 13,
        color: theme.colors.text,
        ...Typography.default(),
    },
    hint: {
        fontSize: 10,
        color: theme.colors.textSecondary,
        paddingHorizontal: 12,
        paddingTop: 2,
        paddingBottom: 4,
        ...Typography.default(),
    },
}));
