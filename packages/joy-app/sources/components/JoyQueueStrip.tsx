// Pending-message strip shown above the composer for joy-tmux sessions. Lists
// messages still WAITING behind a processing turn — once the daemon dispatches
// one it leaves the queue and shows up in chat. Each row carries VISIBLE
// Edit / ✕ actions (no long-press guessing); the strip is width-matched to the
// composer by its CenteredInputWidth wrapper in SessionView.
import * as React from 'react';
import { View, Text, Pressable } from 'react-native';
import { sync } from '@/sync/sync';
import Ionicons from '@expo/vector-icons/Ionicons';
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

// One queued message: text (single line, ellipsized so it can never exceed the
// strip) + inline Edit and ✕. Deliberately no background boxes on the actions —
// they read as plain tappable affordances, not buttons.
const QueuedRow = React.memo(function QueuedRow(props: {
    text: string;
    onEdit: () => void;
    onDelete: () => void;
    onSteer?: () => void;
}) {
    const { theme } = useUnistyles();
    return (
        <View style={styles.row}>
            <Text style={styles.text} numberOfLines={1}>{props.text}</Text>
            {props.onSteer && (
                <Pressable
                    onPress={props.onSteer}
                    hitSlop={8}
                    accessibilityRole="button"
                    accessibilityLabel="Steer now"
                    style={(p) => [styles.action, { opacity: p.pressed ? 0.5 : 1 }]}
                >
                    <Ionicons name="arrow-up-circle-outline" size={17} color={theme.colors.text} />
                </Pressable>
            )}
            <Pressable
                onPress={props.onEdit}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel={t('common.edit')}
                style={(p) => [styles.action, { opacity: p.pressed ? 0.5 : 1 }]}
            >
                <Ionicons name="pencil-outline" size={18} color={theme.colors.text} />
            </Pressable>
            <Pressable
                onPress={props.onDelete}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel={t('common.delete')}
                style={(p) => [styles.action, { opacity: p.pressed ? 0.5 : 1 }]}
            >
                <Ionicons name="close" size={19} color={theme.colors.text} />
            </Pressable>
        </View>
    );
});

export const JoyQueueStrip = React.memo(({ queue, sessionId }: { queue: Queue; sessionId: string }) => {
    // Hidden items are rapid app-sends (visible:false — their chat bubbles
    // already exist). Both hidden and visible items get the same Edit / ✕ row.
    // Age-gated (paused bypasses — a fault state must show at once); older
    // daemons don't send `hidden`, so fall back to a count-only line.
    const hiddenCountRaw = queue.hidden === undefined
        ? Math.max(0, (queue.pendingCount ?? 0) - queue.queue.length)
        : 0;
    const hidden = useDelayedAppearance(queue.hidden ?? [], HIDDEN_APPEAR_MS, queue.paused);
    const hiddenCountOnly = useDelayedAppearance(
        hiddenCountRaw > 0 ? COUNT_SENTINEL : [],
        HIDDEN_APPEAR_MS,
        queue.paused,
    ).length > 0 ? hiddenCountRaw : 0;

    // Hook must precede the empty-queue early return: returning null before a
    // useState means the first queued item ADDS a hook next render — React
    // throws "Rendered more hooks than during the previous render" and the
    // whole session view falls to the error boundary.
    const [collapsed, setCollapsed] = React.useState(false);

    const visible = queue.queue;
    const total = visible.length + hidden.length + hiddenCountOnly;
    if (total === 0 && !queue.paused) return null;

    // Reason-specific paused banner — distinguishes "the pane input has stray
    // text blocking dispatch" from a plain failed/timed-out send.
    const pausedMessage =
        queue.pauseReason === 'input_dirty'
            ? t('joyQueue.pausedInputDirty')
            : queue.pauseReason === 'dispatch_mismatch'
                ? t('joyQueue.pausedDispatchMismatch')
                : t('joyQueue.pausedDefault');

    // Visible (user-queued) item: edit in place via the daemon queue op.
    const editVisible = async (id: string, current: string) => {
        const next = await Modal.prompt(t('joyQueue.editTitle'), '', { defaultValue: current });
        if (next != null && next.trim() && next.trim() !== current) queue.edit(id, next.trim());
    };
    // Hidden (app-sent) item: the message is already an immutable server row, so
    // "edit" cancels the queued delivery and drops the text into the on-device
    // drafts strip for reworking. The original chat bubble stays; it just won't
    // be answered.
    const editHidden = (id: string, text: string) => {
        void queue.cancel(id);
        useDraftQueueStore.getState().add(sessionId, text);
    };

    return (
        <View style={styles.wrap}>
            {total > 0 && (
                <Pressable
                    style={styles.header}
                    onPress={() => setCollapsed((c) => !c)}
                    accessibilityRole="button"
                    accessibilityLabel={collapsed ? 'Expand queue' : 'Collapse queue'}
                >
                    <Ionicons name={collapsed ? 'chevron-forward' : 'chevron-down'} size={12} color={styles.headerText.color as string} />
                    <Text style={styles.headerText}>{`QUEUED · ${total}`}</Text>
                </Pressable>
            )}

            {queue.paused && (
                <Pressable style={styles.pausedRow} onPress={() => queue.resume()}>
                    <Ionicons name="warning-outline" size={15} color="#FF9500" />
                    <Text style={styles.pausedText} numberOfLines={2}>{pausedMessage}</Text>
                </Pressable>
            )}

            {!collapsed && hidden.map((item) => (
                <QueuedRow
                    key={item.id}
                    text={item.text}
                    onEdit={() => editHidden(item.id, item.text)}
                    onDelete={() => { void queue.cancel(item.id); }}
                    onSteer={() => { void queue.cancel(item.id); void sync.sendMessage(sessionId, `/steer ${item.text}`, { source: 'chat' }); }}
                />
            ))}

            {!collapsed && visible.map((m) => (
                <QueuedRow
                    key={m.id}
                    text={m.text}
                    onEdit={() => { void editVisible(m.id, m.text); }}
                    onDelete={() => { void queue.cancel(m.id); }}
                    onSteer={() => { void queue.cancel(m.id); void sync.sendMessage(sessionId, `/steer ${m.text}`, { source: 'chat' }); }}
                />
            ))}

            {/* Legacy daemons without per-item `hidden` data: count only. */}
            {hiddenCountOnly > 0 && (
                <View style={styles.row}>
                    <Text style={styles.countOnly}>{t('joyQueue.pendingCount', { count: hiddenCountOnly })}</Text>
                </View>
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
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingHorizontal: 12,
        paddingVertical: 7,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.colors.divider,
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
    countOnly: {
        flex: 1,
        fontSize: 13,
        color: theme.colors.textSecondary,
        fontStyle: 'italic',
    },
    pausedRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingHorizontal: 12,
        paddingVertical: 8,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.colors.divider,
    },
    pausedText: {
        flex: 1,
        fontSize: 13,
        color: '#FF9500',
        ...Typography.default('semiBold'),
    },
}));
