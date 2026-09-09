/**
 * A section head in the v2 session list: pinned, a custom group, or a derived
 * group on the current axis.
 *
 * It carries the section's own count and — when collapsed — the most urgent
 * state inside it, so collapsing compresses the list without concealing
 * anything waiting on you. It also reports what the active filter took from
 * it, rather than quietly shrinking (sessionListModel.ts, rules 2 and 3).
 *
 * Pinned never collapses: a pin is a statement that you want it in front of
 * you, so its head is a label rather than a control.
 */
import * as React from 'react';
import { Pressable, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Text } from '@/components/StyledText';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { useLocalSettingMutable, useSettingMutable, type SessionListViewItem } from '@/sync/storage';
import { STATUS_PALETTE } from '@/utils/sessionUtils';
import { Modal } from '@/modal';
import { t } from '@/text';
import type { SessionState } from '@/sync/sessionFacts';

type HeaderItem = Extract<SessionListViewItem, { type: 'group-header' }>;

export const SessionGroupHeader = React.memo(function SessionGroupHeader({ item }: { item: HeaderItem }) {
    const { theme } = useUnistyles();
    const [collapsed, setCollapsed] = useLocalSettingMutable('collapsedSessionGroups');
    const [views, setViews] = useSettingMutable('sessionViews');
    const isPinned = item.kind === 'pinned';

    const toggle = React.useCallback(() => {
        if (isPinned) return;
        const next = collapsed.indexOf(item.sectionKey) === -1
            ? [...collapsed, item.sectionKey]
            : collapsed.filter((k) => k !== item.sectionKey);
        setCollapsed(next);
    }, [isPinned, collapsed, item.sectionKey, setCollapsed]);

    // A custom group is the user's own object, so it is theirs to remove.
    const removeView = React.useCallback(async () => {
        const id = item.sectionKey.startsWith('v:') ? item.sectionKey.slice(2) : null;
        if (!id) return;
        const ok = await Modal.confirm(item.title, t('sidebar.removeGroupConfirm'), {
            confirmText: t('sidebar.removeGroup'),
            destructive: true,
        });
        if (ok) setViews(views.filter((v) => v.id !== id));
    }, [item.sectionKey, item.title, views, setViews]);

    const worst = item.worstState ? STATUS_PALETTE[item.worstState as SessionState] : undefined;

    return (
        <Pressable
            onPress={toggle}
            onLongPress={item.kind === 'view' ? removeView : undefined}
            disabled={isPinned}
            accessibilityRole={isPinned ? 'header' : 'button'}
            accessibilityState={isPinned ? undefined : { expanded: !item.collapsed }}
            style={styles.row}
        >
            {isPinned ? (
                <Ionicons name="star" size={11} color={theme.colors.textLink} style={styles.icon} />
            ) : (
                <Ionicons
                    name={item.collapsed ? 'chevron-forward' : 'chevron-down'}
                    size={11}
                    color={theme.colors.textSecondary}
                    style={styles.icon}
                />
            )}
            <Text style={styles.title} numberOfLines={1}>{item.title}</Text>

            {/* Rule 3: a collapsed section still names what most wants a human. */}
            {item.collapsed && !!worst && (
                <View style={styles.rollup}>
                    <View style={[styles.dot, { backgroundColor: worst.dotColor }]} />
                </View>
            )}
            {/* Rule 2: say what the filter took instead of quietly shrinking. */}
            {item.hiddenByFilter > 0 && (
                <Text style={styles.hidden} numberOfLines={1}>
                    {t('sidebar.hiddenByFilter', { count: item.hiddenByFilter })}
                </Text>
            )}
            <Text style={styles.count}>{item.count}</Text>
        </Pressable>
    );
});

const styles = StyleSheet.create((theme) => ({
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 7,
        paddingHorizontal: 16,
        paddingVertical: 7,
        backgroundColor: theme.colors.groupped.background,
    },
    icon: {
        width: 12,
    },
    title: {
        flexShrink: 1,
        fontSize: 12,
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    rollup: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    dot: {
        width: 7,
        height: 7,
        borderRadius: 3.5,
    },
    hidden: {
        flexShrink: 1,
        fontSize: 11,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
    count: {
        marginLeft: 'auto',
        fontSize: 11,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
}));
