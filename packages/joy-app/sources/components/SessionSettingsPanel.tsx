/**
 * The composer's settings panel — one list at a time (see settingsPanel.ts
 * for why, and for the level rules).
 *
 * Root lists what each setting is currently on; tapping a row drills into
 * that setting's options; choosing one applies it and returns to the root,
 * so changing model and effort is one visit rather than two. The card is
 * pinned above the composer and grows upward, so a list that outgrows the
 * cap scrolls inside it rather than pushing the card's ceiling toward the
 * status bar.
 */
import * as React from 'react';
import { Pressable, Text, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import Ionicons from '@expo/vector-icons/Ionicons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { FloatingOverlay } from './FloatingOverlay';
import { hapticsLight } from './haptics';
import type { ModeOption } from './modelModeOptions';
import {
    canGoBack,
    initialLevel,
    levelAfterSelect,
    selectedName,
    visibleSections,
    type SettingsLevel,
    type SettingsSection,
    type SettingsSectionLevel,
} from './settingsPanel';

interface SessionSettingsPanelProps {
    sections: SettingsSection[];
    onSelect: (level: SettingsSectionLevel, option: ModeOption) => void;
    onClose: () => void;
    /** Ceiling for the card; a longer list scrolls inside it. */
    maxHeight: number;
    /** Accessibility label for the back chevron. */
    backLabel: string;
}

/** Enough movement to read as "this came from somewhere", not enough to
 *  animate the panel's own geometry — the card is pinned at the bottom, so
 *  a big slide would drag its ceiling around. */
const SWAP_SHIFT = 14;
const SWAP_MS = 160;

export const SessionSettingsPanel = React.memo((props: SessionSettingsPanelProps) => {
    const { theme } = useUnistyles();
    const sections = React.useMemo(() => visibleSections(props.sections), [props.sections]);
    const [level, setLevel] = React.useState<SettingsLevel>(() => initialLevel(props.sections));

    // A harness change while the panel is open (a restart into another agent)
    // can retire the section being shown; fall back rather than render a
    // header with nothing under it.
    React.useEffect(() => {
        if (level !== 'root' && !sections.some((s) => s.level === level)) {
            setLevel(initialLevel(props.sections));
        }
    }, [sections, level, props.sections]);

    // Direction the incoming content travels from: in from the right when
    // drilling down, from the left when coming back.
    const progress = useSharedValue(1);
    const direction = useSharedValue(1);
    const swapTo = React.useCallback((next: SettingsLevel, from: 1 | -1) => {
        direction.value = from;
        progress.value = 0;
        setLevel(next);
        progress.value = withTiming(1, { duration: SWAP_MS });
    }, [direction, progress]);

    const contentStyle = useAnimatedStyle(() => ({
        opacity: progress.value,
        transform: [{ translateX: (1 - progress.value) * SWAP_SHIFT * direction.value }],
    }));

    const openSection = React.useCallback((next: SettingsSectionLevel) => {
        hapticsLight();
        swapTo(next, 1);
    }, [swapTo]);

    const goBack = React.useCallback(() => {
        hapticsLight();
        swapTo('root', -1);
    }, [swapTo]);

    const choose = React.useCallback((sectionLevel: SettingsSectionLevel, option: ModeOption) => {
        hapticsLight();
        props.onSelect(sectionLevel, option);
        const next = levelAfterSelect(props.sections, sectionLevel);
        if (next === 'close') props.onClose();
        else swapTo(next, -1);
    }, [props, swapTo]);

    const current = level === 'root' ? null : sections.find((s) => s.level === level) ?? null;
    const showBack = canGoBack(props.sections, level);

    return (
        <FloatingOverlay maxHeight={props.maxHeight} showScrollIndicator keyboardShouldPersistTaps="always">
            <Animated.View style={contentStyle}>
                {current === null ? (
                    <View style={styles.body} testID="session-settings-root">
                        {sections.map((section) => {
                            const value = selectedName(section);
                            return (
                                <Pressable
                                    key={section.level}
                                    testID={`session-settings-open-${section.level}`}
                                    onPress={() => openSection(section.level)}
                                    accessibilityRole="button"
                                    accessibilityLabel={`${section.label}${value ? `, ${value}` : ''}`}
                                    style={({ pressed }) => [styles.rootRow, pressed && styles.rowPressed]}
                                >
                                    <Text style={styles.rootLabel} numberOfLines={1}>{section.label}</Text>
                                    {!!value && (
                                        <Text style={styles.rootValue} numberOfLines={1}>{value}</Text>
                                    )}
                                    <Ionicons name="chevron-forward" size={15} color={theme.colors.textSecondary} style={styles.chevron} />
                                </Pressable>
                            );
                        })}
                    </View>
                ) : (
                    <View style={styles.body} testID={`session-settings-${current.level}`}>
                        <View style={styles.header}>
                            {showBack && (
                                <Pressable
                                    testID="session-settings-back"
                                    onPress={goBack}
                                    accessibilityRole="button"
                                    accessibilityLabel={props.backLabel}
                                    hitSlop={8}
                                    style={styles.backButton}
                                >
                                    <Ionicons name="chevron-back" size={16} color={theme.colors.textSecondary} />
                                </Pressable>
                            )}
                            <Text style={styles.headerTitle} numberOfLines={1}>{current.title}</Text>
                        </View>
                        {current.options.map((option) => {
                            const isSelected = current.selectedKey === option.key;
                            return (
                                <Pressable
                                    key={option.key}
                                    testID={`session-settings-option-${option.key}`}
                                    onPress={() => choose(current.level, option)}
                                    accessibilityRole="radio"
                                    accessibilityState={{ selected: isSelected }}
                                    style={({ pressed }) => [styles.optionRow, pressed && styles.rowPressed]}
                                >
                                    <View style={[styles.radio, isSelected ? styles.radioActive : styles.radioInactive]}>
                                        {isSelected && <View style={styles.radioDot} />}
                                    </View>
                                    <View style={styles.optionText}>
                                        <Text style={[styles.optionLabel, isSelected ? styles.optionLabelActive : styles.optionLabelInactive]}>
                                            {option.name}
                                        </Text>
                                        {!!option.description && (
                                            <Text style={styles.optionDescription}>{option.description}</Text>
                                        )}
                                    </View>
                                </Pressable>
                            );
                        })}
                    </View>
                )}
            </Animated.View>
        </FloatingOverlay>
    );
});

const styles = StyleSheet.create((theme) => ({
    body: {
        paddingVertical: 8,
    },
    rootRow: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        paddingVertical: 11,
    },
    rowPressed: {
        backgroundColor: theme.colors.surfacePressed,
    },
    rootLabel: {
        fontSize: 14,
        color: theme.colors.text,
        flexShrink: 0,
        ...Typography.default(),
    },
    rootValue: {
        flex: 1,
        textAlign: 'right',
        fontSize: 14,
        color: theme.colors.textSecondary,
        marginLeft: 12,
        ...Typography.default(),
    },
    chevron: {
        marginLeft: 6,
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        paddingBottom: 6,
    },
    backButton: {
        marginLeft: -4,
        marginRight: 6,
    },
    headerTitle: {
        fontSize: 12,
        fontWeight: '600',
        color: theme.colors.textSecondary,
        ...Typography.default('semiBold'),
    },
    optionRow: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        paddingHorizontal: 16,
        paddingVertical: 8,
    },
    radio: {
        width: 16,
        height: 16,
        borderRadius: 8,
        borderWidth: 2,
        alignItems: 'center',
        justifyContent: 'center',
        marginRight: 12,
        marginTop: 2,
    },
    radioActive: {
        borderColor: theme.colors.radio.active,
    },
    radioInactive: {
        borderColor: theme.colors.radio.inactive,
    },
    radioDot: {
        width: 6,
        height: 6,
        borderRadius: 3,
        backgroundColor: theme.colors.radio.dot,
    },
    optionText: {
        flex: 1,
    },
    optionLabel: {
        fontSize: 14,
        ...Typography.default(),
    },
    optionLabelActive: {
        color: theme.colors.radio.active,
    },
    optionLabelInactive: {
        color: theme.colors.text,
    },
    optionDescription: {
        fontSize: 11,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
}));
