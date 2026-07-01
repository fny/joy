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

// Count a row as "visible" as soon as any sliver of it is in view, so the
// topmost partially-clipped row is tracked as the viewport top. Must be a stable
// reference — FlashList/RN forbid changing it between renders.
const VIEWABILITY_CONFIG = { itemVisiblePercentThreshold: 0 } as const;

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
    // Topmost item index currently in the viewport. Kept in sync with manual
    // scrolls via onViewableItemsChanged and set optimistically on each scrub,
    // so scrubbing always steps relative to where the user actually is (a stored
    // pointer would go stale the moment the user scrolled by hand).
    const topVisibleIndexRef = React.useRef<number>(0);
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
    // Built in ONE pass with the prompt indices — displayItems recomputes on
    // every streamed token batch, so a separate reverse + rescan doubled the
    // per-update O(n) work on the app's hottest render path. promptIndices are
    // the user's own prompts (oldest→newest), the jump targets for the prompt
    // stepper; mirrored to a ref so the stable viewability/scroll callbacks
    // read the latest without re-subscribing.
    const { orderedItems, promptIndices } = React.useMemo(() => {
        const n = displayItems.length;
        const ordered = new Array<DisplayItem>(n);
        const prompts: number[] = [];
        for (let i = 0; i < n; i++) {
            const it = displayItems[n - 1 - i];
            ordered[i] = it;
            if (it.type === 'message' && it.message.kind === 'user-text') prompts.push(i);
        }
        return { orderedItems: ordered, promptIndices: prompts };
    }, [displayItems]);
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
        // A subsequent Up should start from the newest prompt again.
        topVisibleIndexRef.current = Number.MAX_SAFE_INTEGER;
        flatListRef.current?.scrollToEnd({ animated: true });
    }, []);

    // Track the topmost visible row so scrubbing steps relative to the current
    // viewport, not a stored pointer that manual scrolling would invalidate.
    const handleViewableItemsChanged = useCallback((info: { viewableItems: Array<{ index: number | null }> }) => {
        let min = Infinity;
        for (const v of info.viewableItems) {
            if (v.index != null && v.index < min) min = v.index;
        }
        if (min !== Infinity) topVisibleIndexRef.current = min;
    }, []);

    // Up: jump to the nearest user prompt ABOVE the current viewport. When parked
    // at the bottom the first press goes to the newest prompt (which may sit just
    // below the fold), so we treat "at bottom" as an unbounded top.
    const scrubToPrevPrompt = useCallback(() => {
        const idxs = promptIndicesRef.current;
        if (idxs.length === 0) return;
        const top = showScrollButtonRef.current ? topVisibleIndexRef.current : Number.MAX_SAFE_INTEGER;
        let target = -1;
        for (let i = idxs.length - 1; i >= 0; i--) {
            if (idxs[i] < top) { target = idxs[i]; break; }
        }
        if (target < 0) return; // already above every prompt
        topVisibleIndexRef.current = target; // optimistic — survives rapid presses
        flatListRef.current?.scrollToIndex({ index: target, animated: true, viewPosition: 0 });
    }, []);

    // Down: jump to the nearest user prompt BELOW the current viewport, or to the
    // very bottom once we've stepped past the last one.
    const scrubToNextPrompt = useCallback(() => {
        const idxs = promptIndicesRef.current;
        const top = topVisibleIndexRef.current;
        let target = -1;
        for (let i = 0; i < idxs.length; i++) {
            if (idxs[i] > top) { target = idxs[i]; break; }
        }
        if (target < 0) {
            scrollToBottom();
            return;
        }
        topVisibleIndexRef.current = target; // optimistic — survives rapid presses
        flatListRef.current?.scrollToIndex({ index: target, animated: true, viewPosition: 0 });
    }, [scrollToBottom]);

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
                onViewableItemsChanged={handleViewableItemsChanged}
                viewabilityConfig={VIEWABILITY_CONFIG}
                ListHeaderComponent={<ListHeader isLoadingOlder={props.isLoadingOlder} />}
                ListFooterComponent={<ListFooter sessionId={props.sessionId} />}
                onStartReached={handleLoadOlder}
                onStartReachedThreshold={0.5}
            />
            {(showScrollButton || showUpButton) && (
                <View style={styles.scrollButtonContainer} pointerEvents="box-none">
                    {/* Scrubbing arrows (chevrons = step between your prompts) */}
                    {showUpButton && (
                        <Pressable
                            style={({ pressed }) => [
                                styles.scrollButton,
                                pressed ? styles.scrollButtonPressed : styles.scrollButtonDefault
                            ]}
                            onPress={scrubToPrevPrompt}
                            accessibilityRole="button"
                            accessibilityLabel="Previous prompt"
                        >
                            <Octicons name="chevron-up" size={16} color={theme.colors.text} />
                        </Pressable>
                    )}
                    {showScrollButton && (
                        <Pressable
                            style={({ pressed }) => [
                                styles.scrollButton,
                                pressed ? styles.scrollButtonPressed : styles.scrollButtonDefault
                            ]}
                            onPress={scrubToNextPrompt}
                            accessibilityRole="button"
                            accessibilityLabel="Next prompt"
                        >
                            <Octicons name="chevron-down" size={16} color={theme.colors.text} />
                        </Pressable>
                    )}
                    {/* Jump straight to the latest message (solid arrow = go to live) */}
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
