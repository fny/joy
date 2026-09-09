/**
 * The session list's controls: which axis it groups on, and which preset
 * filter is applied — plus "save this filter as a group", which is how a
 * custom group gets made without a builder form. You narrow the list, you
 * like what you see, you name it; the group is a by-product of what you were
 * already doing.
 *
 * Only rendered under localSettings.sessionListV2 (see useSessionListV2).
 */
import * as React from 'react';
import { Pressable, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Text } from '@/components/StyledText';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { useLocalSettingMutable, useSettingMutable } from '@/sync/storage';
import { Modal } from '@/modal';
import { t } from '@/text';
import type { FilterKey, GroupAxis } from '@/sync/sessionListModel';

const AXES: Array<{ key: GroupAxis; label: () => string }> = [
    { key: 'project', label: () => t('sidebar.axisProject') },
    { key: 'machine', label: () => t('sidebar.axisMachine') },
    { key: 'date', label: () => t('sidebar.axisDate') },
];

const FILTERS: Array<{ key: FilterKey; label: () => string }> = [
    { key: 'all', label: () => t('sidebar.filterAll') },
    { key: 'needs', label: () => t('sidebar.filterNeeds') },
    { key: 'working', label: () => t('sidebar.filterWorking') },
    { key: 'unread', label: () => t('sidebar.filterUnread') },
];

export const SessionListControls = React.memo(function SessionListControls() {
    const { theme } = useUnistyles();
    const [axis, setAxis] = useLocalSettingMutable('sessionGroupBy');
    const [filter, setFilter] = useLocalSettingMutable('sessionFilter');
    const [views, setViews] = useSettingMutable('sessionViews');

    // A filter that is worth keeping becomes a named group. Only offered for a
    // real filter — "save All as a group" would claim every session and empty
    // the rest of the list.
    const saveAsGroup = React.useCallback(async () => {
        const name = await Modal.prompt(t('sidebar.newGroup'), t('sidebar.nameGroup'), {
            placeholder: FILTERS.find((f) => f.key === filter)?.label() ?? '',
        });
        if (name === null || !name.trim()) return;
        setViews([...views, {
            id: `v${Date.now().toString(36)}`,
            name: name.trim(),
            filter,
        }]);
        setFilter('all');
    }, [filter, views, setViews, setFilter]);

    return (
        <View style={styles.wrap}>
            <View style={styles.segment}>
                {AXES.map((a) => (
                    <Pressable
                        key={a.key}
                        onPress={() => setAxis(a.key)}
                        accessibilityRole="button"
                        accessibilityState={{ selected: axis === a.key }}
                        style={[styles.segmentButton, axis === a.key && styles.segmentButtonActive]}
                    >
                        <Text style={[styles.segmentLabel, axis === a.key && styles.segmentLabelActive]} numberOfLines={1}>
                            {a.label()}
                        </Text>
                    </Pressable>
                ))}
            </View>
            <View style={styles.chips}>
                {FILTERS.map((f) => (
                    <Pressable
                        key={f.key}
                        onPress={() => setFilter(f.key)}
                        accessibilityRole="button"
                        accessibilityState={{ selected: filter === f.key }}
                        style={[styles.chip, filter === f.key && styles.chipActive]}
                    >
                        <Text style={[styles.chipLabel, filter === f.key && styles.chipLabelActive]} numberOfLines={1}>
                            {f.label()}
                        </Text>
                    </Pressable>
                ))}
                {filter !== 'all' && (
                    <Pressable
                        onPress={saveAsGroup}
                        accessibilityRole="button"
                        accessibilityLabel={t('sidebar.saveAsGroup')}
                        style={styles.chip}
                    >
                        <Ionicons name="bookmark-outline" size={13} color={theme.colors.textSecondary} />
                    </Pressable>
                )}
            </View>
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    wrap: {
        paddingHorizontal: 16,
        paddingTop: 10,
        paddingBottom: 8,
        gap: 8,
    },
    segment: {
        flexDirection: 'row',
        backgroundColor: theme.colors.groupped.background,
        borderRadius: 8,
        padding: 2,
        gap: 2,
    },
    segmentButton: {
        flex: 1,
        paddingVertical: 6,
        borderRadius: 6,
        alignItems: 'center',
    },
    segmentButtonActive: {
        backgroundColor: theme.colors.surface,
    },
    segmentLabel: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        ...Typography.default('semiBold'),
    },
    segmentLabelActive: {
        color: theme.colors.text,
    },
    chips: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 6,
    },
    chip: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 5,
        paddingHorizontal: 11,
        paddingVertical: 6,
        borderRadius: 999,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
    },
    chipActive: {
        backgroundColor: theme.colors.surfaceHigh,
        borderColor: 'transparent',
    },
    chipLabel: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        ...Typography.default('semiBold'),
    },
    chipLabelActive: {
        color: theme.colors.textLink,
    },
}));
