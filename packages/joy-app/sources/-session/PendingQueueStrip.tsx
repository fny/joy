import * as React from 'react';
import { View, Pressable } from 'react-native';
import { Text } from '@/components/StyledText';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import { t } from '@/text';
import { useDrafts, useDraftQueueStore, draftReason, type QueuedDraft } from './draftQueue';

// App-side QUEUE ITEMS — messages auto-held because a turn is processing ahead
// ('busy') or the device is offline ('network'). Distinct from deliberate
// drafts (DraftQueueStrip) and from the daemon's own server queue
// (JoyQueueStrip). draftQueueRelease drains these automatically: busy items when
// the turn completes, network items on reconnect (with a 2-min timeout).
export const PendingQueueStrip = React.memo(function PendingQueueStrip({ sessionId }: { sessionId: string }) {
    const all = useDrafts(sessionId);
    const items = React.useMemo(
        () => all.filter((d) => { const r = draftReason(d); return r === 'busy' || r === 'network'; }),
        [all],
    );
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
    const retry = useDraftQueueStore((s) => s.retry);

    const isNetwork = draftReason(item) === 'network';
    const failed = item.timedOut === true;

    const onEdit = React.useCallback(async () => {
        const next = await Modal.prompt(t('joyQueue.editTitle'), '', { defaultValue: item.text });
        if (next != null && next.trim() && next.trim() !== item.text) update(sessionId, item.id, next.trim());
    }, [sessionId, item.id, item.text, update]);

    return (
        <View style={styles.row}>
            <View style={styles.textCol}>
                <Text style={styles.text} numberOfLines={1}>{item.text}</Text>
                {failed ? (
                    <Text style={styles.failed} numberOfLines={1}>{t('joyQueue.sendFailedOffline')}</Text>
                ) : isNetwork ? (
                    <Text style={styles.waiting} numberOfLines={1}>{t('joyQueue.waitingForNetwork')}</Text>
                ) : null}
            </View>
            {failed && (
                <Pressable
                    onPress={() => retry(sessionId, item.id)}
                    hitSlop={8}
                    accessibilityRole="button"
                    accessibilityLabel={t('common.retry')}
                    style={(p) => [styles.action, { opacity: p.pressed ? 0.5 : 1 }]}
                >
                    <Text style={styles.retryLabel}>{t('common.retry')}</Text>
                </Pressable>
            )}
            <Pressable
                onPress={onEdit}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel={t('common.edit')}
                style={(p) => [styles.action, { opacity: p.pressed ? 0.5 : 1 }]}
            >
                <Text style={styles.editLabel}>{t('common.edit')}</Text>
            </Pressable>
            <Pressable
                onPress={() => remove(sessionId, item.id)}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel={t('common.delete')}
                style={(p) => [styles.action, { opacity: p.pressed ? 0.5 : 1 }]}
            >
                <Ionicons name="close" size={19} color={theme.colors.deleteAction} />
            </Pressable>
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
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingHorizontal: 12,
        paddingVertical: 7,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.colors.divider,
    },
    textCol: {
        flex: 1,
        gap: 2,
    },
    text: {
        fontSize: 14,
        color: theme.colors.text,
        ...Typography.default(),
    },
    waiting: {
        fontSize: 11,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
    failed: {
        fontSize: 11,
        color: theme.colors.deleteAction,
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
    retryLabel: {
        fontSize: 14,
        color: theme.colors.textLink,
        ...Typography.default('semiBold'),
    },
}));
