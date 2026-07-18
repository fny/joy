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
import { useDraftQueueStore } from '@/-session/draftQueue';
import { t } from '@/text';
import type { useJoyQueue } from '@/hooks/useJoyQueue';
import { useDelayedAppearance } from '@/hooks/useDelayedAppearance';

type Queue = ReturnType<typeof useJoyQueue>;

// Every app send transits the daemon dispatch queue for ~a second even when
// the agent is idle; hidden items younger than this are in-transit, not held,
// and rendering them flashed every send as "queued". Anything older is
// genuinely waiting (busy agent / stuck dispatch) and appears.
const HIDDEN_APPEAR_MS = 2500;
// Stable sentinel so the old-daemon count-only fallback rides the same gate.
const COUNT_SENTINEL = [{ id: '__pending-count__' }];

export const JoyQueueStrip = React.memo(({ queue, sessionId }: { queue: Queue; sessionId: string }) => {
    const { theme } = useUnistyles();
    // Visible chips, the paused banner, and HIDDEN pending items (rapid app
    // sends queue with visible:false — their chat bubbles already exist).
    // Hidden items get actionable chips too: Edit cancels the queued delivery
    // and moves the text into the on-device drafts strip (it can't be edited
    // in place — the message is already an immutable server row); Delete just
    // cancels. Older daemons don't send `hidden` — fall back to a count line.
    // Both are age-gated (paused bypasses — a fault state must show at once):
    // explicit user queue-adds below are NOT gated, queueing them was the
    // user's own action.
    const hiddenCountRaw = queue.hidden === undefined
        ? Math.max(0, (queue.pendingCount ?? 0) - queue.queue.length)
        : 0;
    const hidden = useDelayedAppearance(queue.hidden ?? [], HIDDEN_APPEAR_MS, queue.paused);
    const hiddenCountOnly = useDelayedAppearance(
        hiddenCountRaw > 0 ? COUNT_SENTINEL : [],
        HIDDEN_APPEAR_MS,
        queue.paused,
    ).length > 0 ? hiddenCountRaw : 0;
    const hasItems = queue.queue.length > 0 || queue.paused || hidden.length > 0 || hiddenCountOnly > 0;
    if (!hasItems) return null;

    // Reason-specific paused banner — distinguishes "the pane input has stray
    // text blocking dispatch" from a plain failed/timed-out send.
    const pausedMessage =
        queue.pauseReason === 'input_dirty'
            ? t('joyQueue.pausedInputDirty')
            : queue.pauseReason === 'dispatch_mismatch'
                ? t('joyQueue.pausedDispatchMismatch')
                : t('joyQueue.pausedDefault');

    const editItem = async (id: string, current: string) => {
        const next = await Modal.prompt(t('joyQueue.editTitle'), '', { defaultValue: current });
        if (next != null && next.trim() && next.trim() !== current) queue.edit(id, next.trim());
    };

    // Hidden (app-sent) queued item: Edit = cancel delivery + move text into
    // the drafts strip for reworking; Delete = cancel delivery. The original
    // chat bubble stays (immutable history) — it just won't be answered.
    const showHiddenMenu = (id: string, text: string) => {
        Modal.alert(t('joyQueue.queuedMessage'), text, [
            {
                text: t('common.edit'), onPress: () => {
                    void queue.cancel(id);
                    useDraftQueueStore.getState().add(sessionId, text);
                }
            },
            { text: t('common.delete'), style: 'destructive', onPress: () => { void queue.cancel(id); } },
            { text: t('common.cancel'), style: 'cancel' },
        ]);
    };

    const showMenu = (id: string, text: string) => {
        Modal.alert(t('joyQueue.queuedMessage'), text, [
            { text: t('common.edit'), onPress: () => { void editItem(id, text); } },
            { text: t('common.delete'), style: 'destructive', onPress: () => { void queue.cancel(id); } },
            { text: t('common.cancel'), style: 'cancel' },
        ]);
    };

    return (
        <View style={styles.wrap}>
            {hiddenCountOnly > 0 && (
                <View style={styles.pendingLine}>
                    <Text style={styles.pendingText}>{t('joyQueue.pendingCount', { count: hiddenCountOnly })}</Text>
                </View>
            )}
            {hidden.map((item) => (
                <Pressable
                    key={item.id}
                    onPress={() => showHiddenMenu(item.id, item.text)}
                    style={styles.pendingLine}
                    accessibilityRole="button"
                >
                    <Text style={styles.pendingText} numberOfLines={1}>{t('joyQueue.pendingItem', { text: item.text })}</Text>
                </Pressable>
            ))}
            {queue.paused && (
                <Pressable style={styles.pausedRow} onPress={() => queue.resume()}>
                    <Ionicons name="warning-outline" size={15} color="#FF9500" />
                    <Text style={styles.pausedText} numberOfLines={2}>
                        {pausedMessage}
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
                    {Platform.OS === 'web' ? t('joyQueue.hintWeb') : t('joyQueue.hintTouch')}
                </Text>
            )}
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    pendingLine: {
        paddingHorizontal: 14,
        paddingVertical: 4,
    },
    pendingText: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        fontStyle: 'italic',
    },
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
