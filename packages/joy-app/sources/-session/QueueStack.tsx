import * as React from 'react';
import { View, TextInput, Pressable, Platform, ScrollView } from 'react-native';
import { Text } from '@/components/StyledText';
import Ionicons from '@expo/vector-icons/Ionicons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { sync } from '@/sync/sync';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { useDraftQueueStore, type QueuedDraft } from './draftQueue';
import { MAX_AUTO_ATTEMPTS } from './draftQueueRelease';

// ONE stack for both kinds of held message, pinned above the composer:
//   kind='pending' — auto-held because a turn is running ahead ('busy');
//                    draftQueueRelease sends these itself when the turn ends.
//   kind='draft'   — deliberately stashed (Save draft); never auto-sent.
// They used to be two unrelated components with different rows, caps and
// affordances, so any change had to be made twice and they drifted (the
// pending strip grew error/retry, the draft strip didn't; one clipped at
// 120px, the other grew without bound). Now: identical header, identical
// inline-editable rows, identical cap. The only differences are the title and
// the send-side control — ↑ (send now) on a draft, ↻ (retry) on a pending item
// whose release keeps failing. Pending items have no ↑: they send themselves.
//
// Height is bounded at VISIBLE_ROWS rows; past that the stack scrolls and the
// header count says how many there are, so a long queue can no longer take
// the whole screen.
const VISIBLE_ROWS = 3;
const ROW_HEIGHT = 60 + 6; // input minHeight + gap

export const QueueStack = React.memo(function QueueStack({ sessionId, kind, items }: {
    sessionId: string;
    kind: 'pending' | 'draft';
    items: QueuedDraft[];
}) {
    const { theme } = useUnistyles();
    const [collapsed, setCollapsed] = React.useState(false);
    if (items.length === 0) return null;
    const title = kind === 'draft' ? t('joyQueue.draftsTitle') : t('joyQueue.pendingTitle');
    const overflow = items.length - VISIBLE_ROWS;
    return (
        <View style={styles.wrap}>
            <Pressable
                onPress={() => setCollapsed((c) => !c)}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel={collapsed ? t('joyQueue.expand') : t('joyQueue.collapse')}
                style={(p) => [styles.headerRow, { opacity: p.pressed ? 0.6 : 1 }]}
            >
                <Ionicons name={kind === 'pending' ? 'time-outline' : 'document-text-outline'} size={12} color={theme.colors.textSecondary} />
                <Text style={styles.header}>{`${title.toUpperCase()} · ${items.length}`}</Text>
                {overflow > 0 && !collapsed && (
                    <Text style={styles.more}>{t('joyQueue.moreItems', { count: overflow })}</Text>
                )}
                <Ionicons
                    name={collapsed ? 'chevron-up' : 'chevron-down'}
                    size={14}
                    color={theme.colors.textSecondary}
                />
            </Pressable>
            {!collapsed && (
                <ScrollView
                    style={{ maxHeight: VISIBLE_ROWS * ROW_HEIGHT }}
                    contentContainerStyle={styles.list}
                    nestedScrollEnabled
                    keyboardShouldPersistTaps="handled"
                    showsVerticalScrollIndicator={items.length > VISIBLE_ROWS}
                >
                    {items.map((d) => (
                        <QueueRow key={d.id} sessionId={sessionId} kind={kind} item={d} />
                    ))}
                </ScrollView>
            )}
        </View>
    );
});

const QueueRow = React.memo(function QueueRow({ sessionId, kind, item }: {
    sessionId: string;
    kind: 'pending' | 'draft';
    item: QueuedDraft;
}) {
    const { theme } = useUnistyles();
    const update = useDraftQueueStore((s) => s.update);
    const remove = useDraftQueueStore((s) => s.remove);
    const retryRelease = useDraftQueueStore((s) => s.retryRelease);

    const onSend = React.useCallback(() => {
        const text = item.text.trim();
        if (text) sync.sendMessage(sessionId, item.text, { source: 'chat' });
        remove(sessionId, item.id);
    }, [sessionId, item.id, item.text, remove]);

    // A release that keeps failing used to look exactly like a message politely
    // waiting its turn — and after MAX_AUTO_ATTEMPTS the app stopped retrying
    // without saying so. Show the reason, and give the parked state a retry.
    const failed = kind === 'pending' && item.lastError != null;
    const parked = failed && (item.attempt ?? 0) >= MAX_AUTO_ATTEMPTS;

    return (
        <View style={styles.row}>
            <View style={styles.inputWrap}>
                <TextInput
                    value={item.text}
                    onChangeText={(next) => update(sessionId, item.id, next)}
                    multiline
                    placeholder={t('joyQueue.draftPlaceholder')}
                    placeholderTextColor={theme.colors.textSecondary as string}
                    style={[
                        styles.input,
                        { color: theme.colors.text, backgroundColor: theme.colors.input.background },
                        // Kill the browser focus ring on web (no border on active).
                        Platform.OS === 'web' ? ({ outlineStyle: 'none' } as any) : null,
                    ]}
                />
                {/* Delete (×) and the send-side control sit inside the box, right. */}
                <View style={styles.actions}>
                    <Pressable
                        onPress={() => remove(sessionId, item.id)}
                        hitSlop={8}
                        accessibilityRole="button"
                        accessibilityLabel={t('common.delete')}
                        style={(p) => [styles.iconButton, { opacity: p.pressed ? 0.6 : 1 }]}
                    >
                        <Ionicons name="close" size={20} color={theme.colors.textSecondary} />
                    </Pressable>
                    {kind === 'draft' && (
                        <Pressable
                            onPress={onSend}
                            hitSlop={8}
                            accessibilityRole="button"
                            accessibilityLabel={t('joyQueue.sendNow')}
                            style={(p) => [styles.iconButton, { opacity: p.pressed ? 0.5 : 1 }]}
                        >
                            <Ionicons name="arrow-up" size={22} color={theme.colors.text} />
                        </Pressable>
                    )}
                    {failed && (
                        <Pressable
                            onPress={() => retryRelease(sessionId, item.id)}
                            hitSlop={8}
                            accessibilityRole="button"
                            accessibilityLabel={t('joyQueue.retry')}
                            style={(p) => [styles.iconButton, { opacity: p.pressed ? 0.5 : 1 }]}
                        >
                            <Ionicons name="refresh" size={20} color={theme.colors.text} />
                        </Pressable>
                    )}
                </View>
            </View>
            {failed && (
                <Text style={styles.error} numberOfLines={2}>
                    {parked
                        ? t('joyQueue.sendParked', { reason: item.lastError! })
                        : t('joyQueue.sendRetrying', { reason: item.lastError! })}
                </Text>
            )}
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
        letterSpacing: 0.4,
        color: theme.colors.textSecondary,
        ...Typography.default('semiBold'),
    },
    more: {
        fontSize: 11,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
    list: {
        gap: 6,
    },
    row: {
        gap: 4,
    },
    inputWrap: {
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
        alignItems: 'center', // vertically centred within the box
        gap: 4,
    },
    iconButton: {
        width: 30,
        height: 30,
        alignItems: 'center',
        justifyContent: 'center',
    },
    error: {
        paddingHorizontal: 12,
        fontSize: 12,
        color: theme.colors.textDestructive,
        ...Typography.default(),
    },
}));
