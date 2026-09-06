import * as React from 'react';
import { Pressable, Modal as RNModal, Platform, ScrollView, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Typography } from '@/constants/Typography';
import { useSessionQuickActions, SessionActionItem } from '@/hooks/useSessionQuickActions';
import { useSession } from '@/sync/storage';
import { Session } from '@/sync/storageTypes';
import { computeMenuLayout, computeSheetMaxHeight } from './sessionActionsMenuLayout';

export type SessionActionsAnchor =
    | {
        type: 'point';
        x: number;
        y: number;
    }
    | {
        type: 'rect';
        x: number;
        y: number;
        width: number;
        height: number;
    };

interface SessionActionsPopoverProps {
    anchor: SessionActionsAnchor | null;
    onAfterArchive?: () => void;
    onAfterDelete?: () => void;
    onClose: () => void;
    sessionId: string;
    visible: boolean;
}


const WEB_MENU_WIDTH = 232;
const WEB_MENU_ITEM_HEIGHT = 48;
const WEB_MENU_MARGIN = 12;
const NATIVE_SHEET_TOP_MARGIN = 24;

const stylesheet = StyleSheet.create((theme) => ({
    backdrop: {
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: 'rgba(0, 0, 0, 0.12)',
    },
    card: {
        backgroundColor: theme.colors.surface,
        borderRadius: 16,
        overflow: 'hidden',
        shadowColor: theme.colors.shadow.color,
        shadowOpacity: theme.colors.shadow.opacity,
        shadowRadius: 18,
        shadowOffset: {
            width: 0,
            height: 8,
        },
        elevation: 10,
    },
    handle: {
        width: 40,
        height: 4,
        borderRadius: 999,
        marginTop: 10,
        marginBottom: 8,
        alignSelf: 'center',
    },
    menuItem: {
        minHeight: 48,
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        gap: 12,
    },
    menuItemPressed: {
        backgroundColor: theme.colors.surfaceSelected,
    },
    menuItemDivider: {
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: theme.colors.divider,
    },
    menuItemLabel: {
        flex: 1,
        fontSize: 15,
        lineHeight: 20,
        ...Typography.default(),
    },
    nativeContainer: {
        flex: 1,
        justifyContent: 'flex-end',
    },
    nativeSheet: {
        borderTopLeftRadius: 20,
        borderTopRightRadius: 20,
        overflow: 'hidden',
    },
    webContainer: {
        flex: 1,
    },
    webMenu: {
        position: 'absolute',
        width: WEB_MENU_WIDTH,
    },
}));

/**
 * Outer shell: resolves the session and renders NOTHING until it exists.
 * The action hook chain (useSessionQuickActions → useSessionStatus) reads
 * `session.presence` unconditionally, so calling it with a session that has
 * not hydrated or was deleted while the popover stayed mounted crashed the
 * screen before the old `!session` guard could run (#236). Hooks that need
 * the session live in the child below, which only mounts once it is there.
 */
export function SessionActionsPopover({
    anchor,
    onAfterArchive,
    onAfterDelete,
    onClose,
    sessionId,
    visible,
}: SessionActionsPopoverProps) {
    const session = useSession(sessionId);

    if (!visible || !anchor || !session) {
        return null;
    }

    return (
        <SessionActionsPopoverContent
            anchor={anchor}
            onAfterArchive={onAfterArchive}
            onAfterDelete={onAfterDelete}
            onClose={onClose}
            session={session}
        />
    );
}

interface SessionActionsPopoverContentProps {
    anchor: SessionActionsAnchor;
    onAfterArchive?: () => void;
    onAfterDelete?: () => void;
    onClose: () => void;
    session: Session;
}

function SessionActionsPopoverContent({
    anchor,
    onAfterArchive,
    onAfterDelete,
    onClose,
    session,
}: SessionActionsPopoverContentProps) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const safeArea = useSafeAreaInsets();
    const { height: windowHeight, width: windowWidth } = useWindowDimensions();
    const { actionItems: actions } = useSessionQuickActions(session, {
        onAfterArchive,
        onAfterDelete,
    });

    // The menu gets a height budget inside the viewport and scrolls beyond
    // it: in a short window the last rows (Archive, Delete) used to sit below
    // the screen with no way to reach them (#237).
    const layout = React.useMemo(() => computeMenuLayout({
        anchor,
        itemCount: actions.length,
        itemHeight: WEB_MENU_ITEM_HEIGHT,
        menuWidth: WEB_MENU_WIDTH,
        margin: WEB_MENU_MARGIN,
        windowWidth,
        windowHeight,
    }), [actions.length, anchor, windowHeight, windowWidth]);

    const handleActionPress = React.useCallback((action: SessionActionItem) => {
        onClose();
        action.onPress();
    }, [onClose]);

    const rows = actions.map((action, index) => {
        const isLast = index === actions.length - 1;
        const color = action.destructive ? theme.colors.status.error : theme.colors.text;

        return (
            <Pressable
                key={action.id}
                accessibilityRole="button"
                onPress={() => handleActionPress(action)}
                style={({ pressed }) => [
                    styles.menuItem,
                    !isLast && styles.menuItemDivider,
                    pressed && styles.menuItemPressed,
                ]}
            >
                <Ionicons
                    color={color}
                    name={action.icon as keyof typeof Ionicons.glyphMap}
                    size={18}
                />
                <Text numberOfLines={1} style={[styles.menuItemLabel, { color }]}>
                    {action.label}
                </Text>
            </Pressable>
        );
    });

    if (Platform.OS === 'web') {
        return (
            <RNModal
                animationType="none"
                onRequestClose={onClose}
                transparent
                visible
            >
                <View style={styles.webContainer}>
                    <Pressable onPress={onClose} style={styles.backdrop} />
                    <View
                        style={[
                            styles.webMenu,
                            {
                                left: layout.left,
                                top: layout.top,
                                maxHeight: layout.maxHeight,
                            },
                        ]}
                    >
                        <View style={[styles.card, { backgroundColor: theme.colors.header.background, maxHeight: layout.maxHeight }]}>
                            <ScrollView bounces={false} showsVerticalScrollIndicator>
                                {rows}
                            </ScrollView>
                        </View>
                    </View>
                </View>
            </RNModal>
        );
    }

    const sheetMaxHeight = computeSheetMaxHeight(windowHeight, safeArea.top, NATIVE_SHEET_TOP_MARGIN);

    return (
        <RNModal
            animationType="fade"
            onRequestClose={onClose}
            transparent
            visible
        >
            <View style={styles.nativeContainer}>
                <Pressable onPress={onClose} style={styles.backdrop} />
                <View
                    style={[
                        styles.nativeSheet,
                        {
                            backgroundColor: theme.colors.header.background,
                            paddingBottom: Math.max(16, safeArea.bottom),
                            maxHeight: sheetMaxHeight,
                        },
                    ]}
                >
                    <View style={[styles.card, { backgroundColor: theme.colors.header.background, flexShrink: 1 }]}>
                        <View style={[styles.handle, { backgroundColor: theme.colors.textSecondary }]} />
                        <ScrollView bounces={false} showsVerticalScrollIndicator>
                            {rows}
                        </ScrollView>
                    </View>
                </View>
            </View>
        </RNModal>
    );
}
