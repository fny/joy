import * as React from 'react';
import { useSession, useSessionMessages, useSetting } from "@/sync/storage";
import { sync } from '@/sync/sync';
import { ActivityIndicator, AppState, NativeScrollEvent, NativeSyntheticEvent, Platform, Pressable, View } from 'react-native';
import { FlashList, type FlashListRef } from '@shopify/flash-list';
import { useCallback } from 'react';
import { useHeaderHeight } from '@/utils/responsive';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MessageView } from './MessageView';
import { AgentWorkGroupView, ToolGroupView } from './ToolGroupView';
import { DuplicateSheet } from './DuplicateSheet';
import { Metadata, Session } from '@/sync/storageTypes';
import { ChatFooter } from './ChatFooter';
import { Message } from '@/sync/typesMessage';
import { DisplayItem, ToolGroupItem, useGroupedMessages } from '@/hooks/useGroupedMessages';
import { Octicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Modal } from '@/modal';
import { useSessionQuickActions } from '@/hooks/useSessionQuickActions';

const SCROLL_THRESHOLD = 300;
// Count an item as "visible" once any sliver of it is on screen, so the prompt
// stepper's notion of the topmost/bottommost visible item tracks the edges.
const VIEWABILITY_CONFIG = { itemVisiblePercentThreshold: 1 } as const;

export const ChatList = React.memo((props: { session: Session }) => {
    const { messages, hasMoreOlder, isLoadingOlder } = useSessionMessages(props.session.id);
    const joy__chatHistoryLimit = useSetting('joy__chatHistoryLimit');
    const visibleMessages = joy__chatHistoryLimit != null ? messages.slice(0, joy__chatHistoryLimit) : messages;
    return (
        <ChatListInternal
            metadata={props.session.metadata}
            sessionId={props.session.id}
            messages={visibleMessages}
            hasMoreOlder={hasMoreOlder}
            isLoadingOlder={isLoadingOlder}
        />
    )
});

const ListHeader = React.memo((props: { isLoadingOlder: boolean }) => {
    const headerHeight = useHeaderHeight();
    const safeArea = useSafeAreaInsets();
    // Rendered at the visual top (ListHeaderComponent on the non-inverted
    // FlashList) — exactly where the "loading older messages" spinner belongs.
    // The spacer below keeps the nav header from clipping the oldest message.
    return (
        <View>
            {props.isLoadingOlder && (
                <View style={{ paddingVertical: 12, alignItems: 'center', justifyContent: 'center' }}>
                    <ActivityIndicator size="small" />
                </View>
            )}
            <View style={{ flexDirection: 'row', alignItems: 'center', height: headerHeight + safeArea.top + 32 }} />
        </View>
    );
});

const ListFooter = React.memo((props: { sessionId: string }) => {
    const session = useSession(props.sessionId)!;
    return (
        <ChatFooter controlledByUser={session.agentState?.controlledByUser || false} />
    )
});

const ChatListInternal = React.memo((props: {
    metadata: Metadata | null,
    sessionId: string,
    messages: Message[],
    hasMoreOlder: boolean,
    isLoadingOlder: boolean,
}) => {
    const { theme } = useUnistyles();
    const flatListRef = React.useRef<FlashListRef<DisplayItem>>(null);
    const [showScrollButton, setShowScrollButton] = React.useState(false);
    // Tracks whether the scroll-button is currently shown, so we only call
    // setShowScrollButton when the threshold is actually crossed instead of
    // on every scroll frame (60Hz). Without this guard, the entire list
    // parent re-renders on every wheel tick.
    const showScrollButtonRef = React.useRef(false);
    // The up button shows whenever we're not at the very top; mirrored to a ref
    // so onScroll only re-renders on a threshold crossing (like the down button).
    const [showUpButton, setShowUpButton] = React.useState(false);
    const showUpButtonRef = React.useRef(false);
    // Topmost visible index, tracked for the "previous prompt" jump button.
    const visibleRangeRef = React.useRef<{ first: number; last: number }>({ first: 0, last: 0 });
    const session = useSession(props.sessionId);

    // Collapse agent work between a user prompt and the final answer.
    // Nested tool groups remain expandable inside the work block.
    const groupToolCalls = useSetting('groupToolCalls');
    const hasPendingPermission = Boolean(
        session?.agentState?.requests && Object.keys(session.agentState.requests).length > 0,
    );
    const collapseCurrentTurn = session?.thinking !== true && !hasPendingPermission;
    const groupingOptions = React.useMemo(
        () => ({ collapseCurrentTurn }),
        [collapseCurrentTurn],
    );
    const displayItems = useGroupedMessages(props.messages, groupToolCalls, groupingOptions);
    // displayItems is newest-first (messages are sorted newest-first). FlashList
    // renders top→bottom, so feed it oldest→newest and let
    // maintainVisibleContentPosition.startRenderingFromBottom pin the newest at
    // the bottom — the v2 chat idiom (no `inverted`; see dev/inverted-list).
    const orderedItems = React.useMemo(() => [...displayItems].reverse(), [displayItems]);
    // Indices of the user's own prompts within orderedItems (oldest→newest) —
    // the jump targets for the prompt stepper. Mirrored to a ref so the stable
    // viewability/scroll callbacks read the latest without re-subscribing.
    const promptIndices = React.useMemo(() => {
        const out: number[] = [];
        orderedItems.forEach((it, i) => {
            if (it.type === 'message' && it.message.kind === 'user-text') out.push(i);
        });
        return out;
    }, [orderedItems]);
    const promptIndicesRef = React.useRef<number[]>(promptIndices);
    promptIndicesRef.current = promptIndices;

    // Tracks which groups are explicitly collapsed. Groups start collapsed;
    // pending approval groups are the only ones we auto-expand.
    const [collapsedGroups, setCollapsedGroups] = React.useState<Set<string>>(() => {
        const initial = new Set<string>();
        for (const item of displayItems) {
            if (isCollapsibleDisplayItem(item) && !item.hasPendingPermission) {
                initial.add(item.id);
            }
        }
        return initial;
    });

    // Auto-expand groups that need user approval — but only if the user
    // hasn't manually collapsed them.
    // We track manually-collapsed IDs so we never force-reopen them.
    const manuallyCollapsedRef = React.useRef<Set<string>>(new Set());
    const initialSeenCollapsibleGroups = React.useMemo(() => {
        const initial = new Set<string>();
        for (const item of displayItems) {
            if (isCollapsibleDisplayItem(item)) {
                initial.add(item.id);
            }
        }
        return initial;
    }, []);
    const seenCollapsibleGroupsRef = React.useRef<Set<string>>(initialSeenCollapsibleGroups);

    React.useEffect(() => {
        setCollapsedGroups((prev) => {
            let changed = false;
            const next = new Set(prev);
            const seen = seenCollapsibleGroupsRef.current;
            for (const item of displayItems) {
                if (!isCollapsibleDisplayItem(item)) {
                    continue;
                }
                const isNewGroup = !seen.has(item.id);
                if (isNewGroup) {
                    seen.add(item.id);
                }
                if (item.hasPendingPermission && prev.has(item.id) && !manuallyCollapsedRef.current.has(item.id)) {
                    next.delete(item.id);
                    changed = true;
                    continue;
                }
                if (isNewGroup && !item.hasPendingPermission) {
                    next.add(item.id);
                    changed = true;
                }
            }
            return changed ? next : prev;
        });
    }, [displayItems]);

    // Ref so AppState handler reads fresh items without re-subscribing
    const displayItemsRef = React.useRef(displayItems);
    displayItemsRef.current = displayItems;

    // Auto-collapse completed groups when app goes to background / tab hidden
    React.useEffect(() => {
        const sub = AppState.addEventListener('change', (state) => {
            if (state !== 'active') {
                setCollapsedGroups((prev) => {
                    const next = new Set(prev);
                    for (const item of displayItemsRef.current) {
                        if (isCollapsibleDisplayItem(item) && !item.hasRunning) {
                            next.add(item.id);
                        }
                    }
                    return next;
                });
            }
        });
        return () => sub.remove();
    }, []);

    // Auto-collapse all previous groups when user sends a new message
    const latestUserMsgId = React.useMemo(() => {
        for (const msg of props.messages) {
            if (msg.kind === 'user-text') return msg.id;
        }
        return null;
    }, [props.messages]);

    const prevUserMsgIdRef = React.useRef(latestUserMsgId);
    React.useEffect(() => {
        if (latestUserMsgId && latestUserMsgId !== prevUserMsgIdRef.current) {
            prevUserMsgIdRef.current = latestUserMsgId;
            manuallyCollapsedRef.current.clear();
            setCollapsedGroups((prev) => {
                const next = new Set(prev);
                for (const item of displayItemsRef.current) {
                    if (isCollapsibleDisplayItem(item)) {
                        next.add(item.id);
                    }
                }
                return next;
            });
        }
    }, [latestUserMsgId]);

    const handleToggleGroup = useCallback((groupId: string) => {
        setCollapsedGroups((prev) => {
            const next = new Set(prev);
            if (next.has(groupId)) {
                next.delete(groupId);
                manuallyCollapsedRef.current.delete(groupId);
            } else {
                next.add(groupId);
                manuallyCollapsedRef.current.add(groupId);
            }
            return next;
        });
    }, []);

    const keyExtractor = useCallback((item: DisplayItem) => item.id, []);

    // Long-press → fork-from-this-message. Uses the same canFork gate as
    // the rest of the fork affordances: ridden by the expResumeSession
    // experiments toggle, requires a Claude session with claudeSessionId
    // and a machine that's online. Active OR inactive — fork works either
    // way (the on-disk JSONL exists in both cases).
    const { canFork } = useSessionQuickActions(session!, {});

    // joy keeps the original claudeUuid-based fork (the upstream rewind/fork
    // rework — initialRewindPointId/MessageText — is a separate feature not ported).
    const handleForkFromMessage = useCallback((_messageId: string, claudeUuid: string) => {
        Modal.show({
            component: DuplicateSheet,
            props: {
                sessionId: props.sessionId,
                initialClaudeUuid: claudeUuid,
            },
        } as any);
    }, [props.sessionId]);

    const renderItem = useCallback(({ item }: { item: DisplayItem }) => {
        if (item.type === 'tool-group') {
            return (
                <ToolGroupView
                    group={item}
                    metadata={props.metadata}
                    sessionId={props.sessionId}
                    expanded={!collapsedGroups.has(item.id)}
                    onToggle={() => handleToggleGroup(item.id)}
                />
            );
        }
        if (item.type === 'agent-work-group') {
            return (
                <AgentWorkGroupView
                    group={item}
                    metadata={props.metadata}
                    sessionId={props.sessionId}
                    expanded={!collapsedGroups.has(item.id)}
                    onToggle={() => handleToggleGroup(item.id)}
                />
            );
        }
        return (
            <MessageView
                message={item.message}
                metadata={props.metadata}
                sessionId={props.sessionId}
                onForkFromUserMessage={canFork ? handleForkFromMessage : undefined}
            />
        );
    }, [props.metadata, props.sessionId, canFork, handleForkFromMessage, collapsedGroups, handleToggleGroup]);

    // Non-inverted list: the newest messages sit at the visual bottom. Show the
    // scroll-to-bottom button once the user has scrolled UP far enough from the
    // bottom. Auto-stick-to-bottom on new messages is handled natively by
    // FlashList's maintainVisibleContentPosition.autoscrollToBottomThreshold —
    // no JS-side scroll is needed (running both fights the viewport mid-stream).
    const handleScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
        const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
        const distanceFromBottom = contentSize.height - layoutMeasurement.height - contentOffset.y;
        const next = distanceFromBottom > SCROLL_THRESHOLD;
        if (next !== showScrollButtonRef.current) {
            showScrollButtonRef.current = next;
            setShowScrollButton(next);
        }
        // Up button shows once we're scrolled down from the very top.
        const up = contentOffset.y > SCROLL_THRESHOLD;
        if (up !== showUpButtonRef.current) {
            showUpButtonRef.current = up;
            setShowUpButton(up);
        }
    }, []);

    const scrollToBottom = useCallback(() => {
        flatListRef.current?.scrollToEnd({ animated: true });
    }, []);

    // Track the visible index range for the "previous prompt" jump. Stable
    // callback — FlashList forbids swapping onViewableItemsChanged mid-flight, so
    // it reads everything via refs.
    const onViewableItemsChanged = useCallback(({ viewableItems }: { viewableItems: Array<{ index: number | null }> }) => {
        let first = Infinity;
        let last = -Infinity;
        for (const v of viewableItems) {
            if (v.index == null) continue;
            if (v.index < first) first = v.index;
            if (v.index > last) last = v.index;
        }
        if (first === Infinity) return;
        visibleRangeRef.current = { first, last };
    }, []);

    // Up: scroll to the nearest user prompt above the viewport (no-op if you're
    // already above the first prompt).
    const scrollToPrevPrompt = useCallback(() => {
        const { first } = visibleRangeRef.current;
        const idxs = promptIndicesRef.current;
        let target = -1;
        for (const i of idxs) {
            if (i < first) target = i;
            else break;
        }
        if (target >= 0) flatListRef.current?.scrollToIndex({ index: target, animated: true, viewPosition: 0 });
    }, []);

    // Older history lives at the visual TOP now, so `onStartReached` fires when
    // the user scrolls up toward it. Initial fetch only loads the latest 100
    // messages (see sync.fetchInitialLatestPage), so we lazy-load earlier pages
    // here; maintainVisibleContentPosition.autoscrollToTopThreshold keeps the
    // viewport anchored as older pages prepend (no jump).
    const sessionId = props.sessionId;
    const hasMoreOlder = props.hasMoreOlder;
    const isLoadingOlder = props.isLoadingOlder;
    const handleLoadOlder = useCallback(() => {
        if (!hasMoreOlder || isLoadingOlder) return;
        void sync.loadOlderMessages(sessionId);
    }, [sessionId, hasMoreOlder, isLoadingOlder]);

    // On macOS/web, Shift+wheel swaps deltaX/deltaY — restore vertical scrolling
    React.useEffect(() => {
        if (Platform.OS !== 'web') return;
        const node = (flatListRef.current as any)?.getScrollableNode?.() as HTMLElement | undefined;
        if (!node) return;
        const handler = (e: WheelEvent) => {
            if (e.shiftKey && Math.abs(e.deltaX) > 0 && Math.abs(e.deltaY) < 1) {
                node.scrollTop += e.deltaX;
                e.preventDefault();
            }
        };
        node.addEventListener('wheel', handler, { passive: false });
        return () => node.removeEventListener('wheel', handler);
    }, []);

    return (
        <View style={{ flex: 1 }}>
            <FlashList
                ref={flatListRef}
                data={orderedItems}
                keyExtractor={keyExtractor}
                maintainVisibleContentPosition={{
                    // startRenderingFromBottom: first paint starts at the bottom
                    // (newest) — the fast path; FlashList only mounts the visible
                    // window instead of every message.
                    startRenderingFromBottom: true,
                    // Stick to the bottom on new messages when the user is near it
                    // (streaming tokens / new turns), but don't yank them up when
                    // they're reading older history.
                    autoscrollToBottomThreshold: 0.2,
                    // Anchor the viewport when older pages prepend at the top.
                    autoscrollToTopThreshold: 100,
                }}
                keyboardShouldPersistTaps="handled"
                keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'none'}
                renderItem={renderItem}
                onScroll={handleScroll}
                scrollEventThrottle={16}
                onViewableItemsChanged={onViewableItemsChanged}
                viewabilityConfig={VIEWABILITY_CONFIG}
                ListHeaderComponent={<ListHeader isLoadingOlder={props.isLoadingOlder} />}
                ListFooterComponent={<ListFooter sessionId={props.sessionId} />}
                onStartReached={handleLoadOlder}
                onStartReachedThreshold={0.5}
            />
            {(showScrollButton || showUpButton) && (
                <View style={styles.scrollButtonContainer} pointerEvents="box-none">
                    {showScrollButton && (
                        <Pressable
                            style={({ pressed }) => [
                                styles.scrollButton,
                                pressed ? styles.scrollButtonPressed : styles.scrollButtonDefault
                            ]}
                            onPress={scrollToBottom}
                            accessibilityRole="button"
                            accessibilityLabel="Scroll to bottom"
                        >
                            <Octicons name="arrow-down" size={14} color={theme.colors.text} />
                        </Pressable>
                    )}
                    {showUpButton && (
                        <Pressable
                            style={({ pressed }) => [
                                styles.scrollButton,
                                pressed ? styles.scrollButtonPressed : styles.scrollButtonDefault
                            ]}
                            onPress={scrollToPrevPrompt}
                            accessibilityRole="button"
                            accessibilityLabel="Previous prompt"
                        >
                            <Octicons name="arrow-up" size={14} color={theme.colors.text} />
                        </Pressable>
                    )}
                </View>
            )}
        </View>
    )
});

function isCollapsibleDisplayItem(item: DisplayItem): item is ToolGroupItem | Extract<DisplayItem, { type: 'agent-work-group' }> {
    return item.type === 'tool-group' || item.type === 'agent-work-group';
}

const styles = StyleSheet.create((theme) => ({
    scrollButtonContainer: {
        position: 'absolute',
        right: 12,
        bottom: 12,
        alignItems: 'center',
        justifyContent: 'flex-end',
        gap: 8,
        pointerEvents: 'box-none',
    },
    scrollButton: {
        borderRadius: 16,
        width: 32,
        height: 32,
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 1,
        borderColor: theme.colors.divider,
        shadowColor: theme.colors.shadow.color,
        shadowOffset: { width: 0, height: 1 },
        shadowRadius: 2,
        shadowOpacity: theme.colors.shadow.opacity * 0.5,
        elevation: 2,
    },
    scrollButtonDefault: {
        backgroundColor: theme.colors.surface,
        opacity: 0.9,
    },
    scrollButtonPressed: {
        backgroundColor: theme.colors.surface,
        opacity: 0.7,
    },
}));
