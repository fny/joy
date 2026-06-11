// Pending-message strip shown above the composer for joy-tmux sessions. Lists
// messages queued while Claude is busy; each is editable/cancelable until the
// daemon dispatches it (the in-flight one has already left the queue). Shows a
// resume affordance if a dispatch failed and auto-drain paused.
import * as React from 'react';
import { View, Text, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import type { useJoyQueue } from '@/hooks/useJoyQueue';

type Queue = ReturnType<typeof useJoyQueue>;

export const JoyQueueStrip = React.memo(({ queue }: { queue: Queue }) => {
    const { theme } = useUnistyles();
    const hasItems = queue.queue.length > 0 || queue.inFlight != null || queue.paused;
    if (!hasItems) return null;

    const editItem = async (id: string, current: string) => {
        const next = await Modal.prompt('Edit queued message', '', { defaultValue: current });
        if (next != null && next.trim() && next.trim() !== current) queue.edit(id, next.trim());
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

            {queue.inFlight != null && (
                <View style={[styles.row, styles.inFlightRow]}>
                    <Ionicons name="paper-plane-outline" size={14} color={theme.colors.textSecondary} />
                    <Text style={[styles.text, { color: theme.colors.textSecondary }]} numberOfLines={1}>
                        {queue.inFlight}
                    </Text>
                    <Text style={styles.tag}>sending…</Text>
                </View>
            )}

            {queue.queue.map((m, i) => (
                <View key={m.id} style={styles.row}>
                    <Text style={styles.idx}>{i + 1}</Text>
                    <Pressable style={styles.textPress} onPress={() => editItem(m.id, m.text)}>
                        <Text style={styles.text} numberOfLines={2}>{m.text}</Text>
                    </Pressable>
                    <Pressable hitSlop={8} onPress={() => editItem(m.id, m.text)} style={styles.iconBtn}>
                        <Ionicons name="pencil-outline" size={15} color={theme.colors.textSecondary} />
                    </Pressable>
                    <Pressable hitSlop={8} onPress={() => queue.cancel(m.id)} style={styles.iconBtn}>
                        <Ionicons name="close-circle" size={17} color={theme.colors.textSecondary} />
                    </Pressable>
                </View>
            ))}
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
        paddingVertical: 6,
    },
    inFlightRow: {
        opacity: 0.7,
    },
    idx: {
        fontSize: 11,
        minWidth: 14,
        textAlign: 'center',
        color: theme.colors.textSecondary,
        ...Typography.mono(),
    },
    textPress: { flex: 1 },
    text: {
        fontSize: 13,
        color: theme.colors.text,
        ...Typography.default(),
    },
    tag: {
        fontSize: 11,
        color: theme.colors.textSecondary,
        ...Typography.mono(),
    },
    iconBtn: {
        padding: 2,
    },
}));
