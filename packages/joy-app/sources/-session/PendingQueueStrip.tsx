import * as React from 'react';
import { View, Pressable } from 'react-native';
import { Text } from '@/components/StyledText';
import Ionicons from '@expo/vector-icons/Ionicons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import { t } from '@/text';
import { useDrafts, useDraftQueueStore, draftReason, type QueuedDraft } from './draftQueue';
import { MAX_AUTO_ATTEMPTS } from './draftQueueRelease';

// App-side QUEUE ITEMS — messages auto-held because a turn is processing ahead
// ('busy'). Distinct from deliberate drafts (DraftQueueStrip) and from the
// daemon's own server queue (JoyQueueStrip). draftQueueRelease drains these when
// the turn completes. (Offline sends are NOT here — they ride the outbox with a
// per-message delivery status.)
export const PendingQueueStrip = React.memo(function PendingQueueStrip({ sessionId }: { sessionId: string }) {
    const all = useDrafts(sessionId);
    const items = React.useMemo(() => all.filter((d) => draftReason(d) === 'busy'), [all]);
    if (items.length === 0) return null;
    return (
        <View style={styles.wrap}>
            <View style={styles.header}>
                <Ionicons name="time-outline" size={13} color={styles.headerText.color as string} />
                <Text style={styles.headerText}>{t('joyQueue.pendingHeader', { count: items.length })}</Text>
            </View>
            {items.map((d) => (
                <PendingRow key={d.id} sessionId={sessionId} item={d} />
            ))}
        </View>
    );
});

const PendingRow = React.memo(function PendingRow({ sessionId, item }: { sessionId: string; item: QueuedDraft }) {
    const { theme } = useUnistyles();
    const update = useDraftQueueStore((s) => s.update);
    const remove = useDraftQueueStore((s) => s.remove);
    const retryRelease = useDraftQueueStore((s) => s.retryRelease);

    const onEdit = React.useCallback(async () => {
        const next = await Modal.prompt(t('joyQueue.editTitle'), '', { defaultValue: item.text });
        if (next != null && next.trim() && next.trim() !== item.text) update(sessionId, item.id, next.trim());
    }, [sessionId, item.id, item.text, update]);

    // A release that keeps failing used to leave the row looking exactly like a
    // message politely waiting its turn — and after MAX_AUTO_ATTEMPTS the app
    // stopped retrying without saying so, which reads as "queued forever".
    // Show the reason, and give the parked state a retry.
    const parked = (item.attempt ?? 0) >= MAX_AUTO_ATTEMPTS;

    return (
        <View style={styles.rowWrap}>
            <View style={styles.row}>
                <Text style={styles.text} numberOfLines={1}>{item.text}</Text>
                {item.lastError != null && (
                    <Pressable
                        onPress={() => retryRelease(sessionId, item.id)}
                        hitSlop={8}
                        accessibilityRole="button"
                        accessibilityLabel={t('joyQueue.retry')}
                        style={(p) => [styles.action, { opacity: p.pressed ? 0.5 : 1 }]}
                    >
                        <Ionicons name="refresh" size={18} color={theme.colors.text} />
                    </Pressable>
                )}
                <Pressable
                    onPress={onEdit}
                    hitSlop={8}
                    accessibilityRole="button"
                    accessibilityLabel={t('common.edit')}
                    style={(p) => [styles.action, { opacity: p.pressed ? 0.5 : 1 }]}
                >
                    <Ionicons name="pencil-outline" size={18} color={theme.colors.text} />
                </Pressable>
                <Pressable
                    onPress={() => remove(sessionId, item.id)}
                    hitSlop={8}
                    accessibilityRole="button"
                    accessibilityLabel={t('common.delete')}
                    style={(p) => [styles.action, { opacity: p.pressed ? 0.5 : 1 }]}
                >
                    <Ionicons name="close" size={19} color={theme.colors.text} />
                </Pressable>
            </View>
            {item.lastError != null && (
                <Text style={styles.error} numberOfLines={2}>
                    {parked
                        ? t('joyQueue.sendParked', { reason: item.lastError })
                        : t('joyQueue.sendRetrying', { reason: item.lastError })}
                </Text>
            )}
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    wrap: {
        marginBottom: 6,
        backgroundColor: theme.colors.input.background,
        borderRadius: 12,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
        overflow: 'hidden',
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingHorizontal: 12,
        paddingTop: 8,
        paddingBottom: 6,
    },
    headerText: {
        fontSize: 11,
        letterSpacing: 0.4,
        textTransform: 'uppercase',
        color: theme.colors.textSecondary,
        ...Typography.default('semiBold'),
    },
    rowWrap: {
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.colors.divider,
    },
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingHorizontal: 12,
        paddingVertical: 7,
    },
    error: {
        paddingHorizontal: 12,
        paddingBottom: 7,
        fontSize: 12,
        color: theme.colors.textDestructive,
        ...Typography.default(),
    },
    text: {
        flex: 1,
        fontSize: 14,
        color: theme.colors.text,
        ...Typography.default(),
    },
    action: {
        paddingHorizontal: 6,
        paddingVertical: 2,
    },
    editLabel: {
        fontSize: 14,
        color: theme.colors.textLink,
        ...Typography.default('semiBold'),
    },
}));
