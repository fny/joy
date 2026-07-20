import * as React from 'react';
import { useSession, useSessionMessages, useSetting } from "@/sync/storage";
import { sync } from '@/sync/sync';
import { ActivityIndicator, AppState, InteractionManager, NativeScrollEvent, NativeSyntheticEvent, Platform, Pressable, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
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
// "Live" (pinned to the newest message) is a SEPARATE, much tighter band than
// the 300px scroll-button threshold: someone 250px up is reading, and their
// position must not be discarded as "basically at the bottom".
const LIVE_THRESHOLD = 48;

// Saved viewport per session, surviving unmounts AND screen retention (the
// terminal-pane push keeps this screen mounted — only navigation focus moves).
// Semantic snapshot, committed ONLY on blur/background/unmount — never from
// onScroll, whose stream includes FlashList's own multi-pass initial
// positioning and programmatic corrections (writing those corrupted the
// snapshot: a user who never scrolled acquired a garbage offset).
// `reading` restores by ANCHOR ROW + intra-row offset, not pixels: a raw
// offset lands wherever the fresh mount's height ESTIMATES say it is, and the
// cumulative estimate error across hundreds of variable-height rows is
// exactly the reported "messages jump up a lot" (codex gpt-5.6-sol root-cause
// review, 2026-07-20). newestMessageId is the raw newest message id (not a
// display-row id — new tool messages get absorbed into existing group rows).
type SavedViewport =
    | { mode: 'live'; newestMessageId: string | null }
    | {
        mode: 'reading';
        anchorDisplayId: string;
        anchorMessageId: string | null;
        intraItemOffset: number;
        newestMessageId: string | null;
    };
const savedViewport = new Map<string, SavedViewport>();
const SAVED_SCROLL_MAX = 30;
function rememberViewport(sessionId: string, snapshot: SavedViewport) {
    if (!savedViewport.has(sessionId) && savedViewport.size >= SAVED_SCROLL_MAX) {
        const oldest = savedViewport.keys().next().value;
        if (oldest !== undefined) savedViewport.delete(oldest);
    }
    savedViewport.set(sessionId, snapshot);
}

/** Canonical (oldest) underlying message of a display row — the regroup-proof
 *  anchor fallback. tool-group messages are chronological (oldest first);
 *  agent-work-group messages are NEWEST-first, so its oldest is `.at(-1)`. */
function anchorMessageIdFor(row: DisplayItem): string | null {
    if (row.type === 'message') return row.message.id;
    if (row.type === 'tool-group') return row.messages[0]?.id ?? null;
    if (row.type === 'agent-work-group') return row.messages[row.messages.length - 1]?.id ?? null;
    return null;
}

function rowContainsMessage(row: DisplayItem, messageId: string): boolean {
    if (row.type === 'message') return row.message.id === messageId;
    return row.messages.some((m) => m.id === messageId);
}

// Count a row as "visible" as soon as any sliver of it is in view, so the
// topmost partially-clipped row is tracked as the viewport top. Must be a stable
// reference — FlashList/RN forbid changing it between renders.
const VIEWABILITY_CONFIG = { itemVisiblePercentThreshold: 0 } as const;

export const ChatList = React.memo((props: { session: Session }) => {
    const { messages, hasMoreOlder, isLoadingOlder } = useSessionMessages(props.session.id);
    const joy__chatHistoryLimit = useSetting('joy__chatHistoryLimit');
    // Memoized: an un-memoized slice() minted a fresh array identity on EVERY
    // render (session object churns constantly mid-stream), defeating
    // ChatListInternal's memo + regrouping the whole window on the hottest path.
    const visibleMessages = React.useMemo(
        () => joy__chatHistoryLimit != null ? messages.slice(0, joy__chatHistoryLimit) : messages,
        [messages, joy__chatHistoryLimit],
    );
    // With the display cap active, older pages could never render — but
    // onStartReached still fired at the top of the capped window, downloading
    // the entire history page-by-page for nothing. Treat history as exhausted.
    const capActive = joy__chatHistoryLimit != null && messages.length >= joy__chatHistoryLimit;
    return (
        <ChatListInternal
            metadata={props.session.metadata}
            sessionId={props.session.id}
            messages={visibleMessages}
            hasMoreOlder={capActive ? false : hasMoreOlder}
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
    const sessionId = props.sessionId;
    // Newest message id, readable from the stable scroll callback — stamped
    // into the saved position so a stale restore can be detected.
    const newestIdRef = React.useRef<string | null>(null);
    newestIdRef.current = props.messages[0]?.id ?? null;
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
    // FlashList indexes into orderedItems (oldest→newest) — every save/restore
    // index lookup MUST use this ref, not displayItemsRef (newest→oldest):
    // indexing the wrong array anchors to the mirrored end of the conversation.
    const orderedItemsRef = React.useRef(orderedItems);
    orderedItemsRef.current = orderedItems;
    // Whether the user is pinned within LIVE_THRESHOLD of the end. Starts true:
    // a blur before the first scroll event must not manufacture a 'reading'
    // snapshot out of default-initialized refs.
    const nearBottomRef = React.useRef(true);

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
    // Mirror to a ref so renderItem can read the latest collapse state without
    // depending on it — keeping renderItem's identity stable across the
    // auto-collapse effect that fires on every new tool group mid-stream
    // (a changed renderItem makes FlashList re-render every visible row).
    // The state itself is passed as FlashList `extraData` so manual toggles
    // still trigger a row re-render pass.
    const collapsedGroupsRef = React.useRef(collapsedGroups);
    collapsedGroupsRef.current = collapsedGroups;

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

    // Auto-collapse completed groups when app goes to background / tab hidden.
    // (Viewport capture on background lives in the focus-scoped AppState
    // listener below — registered AFTER this one, so on the background event it
    // still reads pre-collapse layout: both listeners run in the same task,
    // the collapse setState renders only afterwards.)
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
                    expanded={!collapsedGroupsRef.current.has(item.id)}
                    onToggle={handleToggleGroup}
                />
            );
        }
        if (item.type === 'agent-work-group') {
            return (
                <AgentWorkGroupView
                    group={item}
                    metadata={props.metadata}
                    sessionId={props.sessionId}
                    expanded={!collapsedGroupsRef.current.has(item.id)}
                    onToggle={handleToggleGroup}
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
    }, [props.metadata, props.sessionId, canFork, handleForkFromMessage, handleToggleGroup]);

    // Non-inverted list: the newest messages sit at the visual bottom. Show the
    // scroll-to-bottom button once the user has scrolled UP far enough from the
    // bottom. Auto-stick-to-bottom on new messages is handled natively by
    // FlashList's maintainVisibleContentPosition.autoscrollToBottomThreshold —
    // no JS-side scroll is needed (running both fights the viewport mid-stream).
    const handleScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
        const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
        const distanceFromBottom = contentSize.height - layoutMeasurement.height - contentOffset.y;
        // Refs only — the snapshot is committed at lifecycle boundaries, never
        // from the scroll stream (see SavedViewport).
        nearBottomRef.current = distanceFromBottom <= LIVE_THRESHOLD;
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
    }, [sessionId]);

    // ── Viewport save/restore ─────────────────────────────────────────────
    // Commit points: navigation blur (terminal-pane push RETAINS this screen —
    // no unmount, no AppState change), app background, and unmount as a
    // fallback. Restore points: first onLoad (remount) and refocus of a
    // retained screen (onLoad never re-fires there).

    // True while restoreViewport's staged scrollToIndex is running. A blur
    // mid-restore must NOT snapshot the intermediate scroll position —
    // FlashList can't cancel a started scroll, so the pre-restore snapshot
    // (exactly what was being restored) stays the best record.
    const restoreInFlightRef = React.useRef(false);
    const captureViewport = useCallback(() => {
        if (restoreInFlightRef.current) return;
        const newestMessageId = newestIdRef.current;
        if (nearBottomRef.current) {
            rememberViewport(sessionId, { mode: 'live', newestMessageId });
            return;
        }
        const list = flatListRef.current;
        const items = orderedItemsRef.current;
        const index = list?.getFirstVisibleIndex() ?? -1;
        if (!list || index < 0 || index >= items.length) {
            // Can't resolve an anchor — drop the entry rather than keep a stale
            // one that would restore an OLD position later. Default = bottom.
            savedViewport.delete(sessionId);
            return;
        }
        const row = items[index];
        // Intra-row offset in the row's own coordinates. layout.y excludes the
        // ListHeaderComponent while the absolute offset includes it — subtract
        // getFirstItemOffset() or every snapshot is off by the header height.
        // NEGATIVE is legitimate near the very top (part of the header spacer
        // visible above the first row) — zeroing it would shift the restore up
        // by the visible header gap.
        let intra = 0;
        const layout = list.getLayout(index);
        if (layout) {
            intra = list.getAbsoluteLastScrollOffset() - list.getFirstItemOffset() - layout.y;
            if (!Number.isFinite(intra)) intra = 0;
        }
        rememberViewport(sessionId, {
            mode: 'reading',
            anchorDisplayId: row.id,
            anchorMessageId: anchorMessageIdFor(row),
            intraItemOffset: intra,
            newestMessageId,
        });
    }, [sessionId]);

    // Guards a restore across its awaits: any newer capture/restore cycle
    // (refocus, remount) invalidates in-flight completions so a late async
    // scroll can't yank a viewport the user has since taken over.
    const restoreGenRef = React.useRef(0);
    const restoreViewport = useCallback(async (opts: { retained: boolean }) => {
        const gen = ++restoreGenRef.current;
        const list = flatListRef.current;
        if (!list) return;
        const saved = savedViewport.get(sessionId);
        if (!saved) return;
        if (saved.mode === 'live') {
            // Fresh mounts already start at the bottom; a retained screen may
            // have drifted while hidden (rows grew, groups regrouped) — assert.
            if (opts.retained) list.scrollToEnd({ animated: false });
            return;
        }
        if (saved.newestMessageId !== newestIdRef.current) {
            // New content arrived while away → product rule: go to the bottom.
            savedViewport.delete(sessionId);
            if (opts.retained) list.scrollToEnd({ animated: false });
            return;
        }
        const items = orderedItemsRef.current;
        let index = items.findIndex((i) => i.id === saved.anchorDisplayId);
        let intra = saved.intraItemOffset;
        if (index < 0 && saved.anchorMessageId) {
            // Regrouping swallowed the display row — land at the top of the row
            // now containing the anchor message (the old intra offset is
            // meaningless in a different row).
            index = items.findIndex((i) => rowContainsMessage(i, saved.anchorMessageId!));
            intra = 0;
        }
        if (index < 0) {
            if (opts.retained) list.scrollToEnd({ animated: false });
            return;
        }
        // A collapsed-while-away group is shorter than the saved offset into
        // it — clamp so the restore can't land past the row. Only against a
        // MEASURED height: on a remount the anchor usually starts as an
        // estimate (often ~100px), and clamping a legitimate intra=500 against
        // it would permanently truncate the restore before scrollToIndex ever
        // measures the row.
        const isMeasured = (l: ReturnType<typeof list.getLayout>) =>
            Boolean(l && (l as { isHeightMeasured?: boolean }).isHeightMeasured);
        const clampIntra = (l: NonNullable<ReturnType<typeof list.getLayout>>, v: number) =>
            v > l.height - 1 ? Math.max(0, l.height - 1) : v;
        const layout = list.getLayout(index);
        if (layout && isMeasured(layout) && layout.height > 0) intra = clampIntra(layout, intra);
        restoreInFlightRef.current = true;
        try {
            await list.scrollToIndex({ index, animated: false, viewPosition: 0, viewOffset: intra });
            if (restoreGenRef.current !== gen) return;
            // scrollToIndex staged its own re-measurement passes. At most one
            // corrective call, for either: the data shifted under it (same id
            // now at a new index), or the anchor's real measured height turned
            // out shorter than the saved intra (collapsed-while-away group).
            const itemsAfter = orderedItemsRef.current;
            let idx2 = index;
            if (itemsAfter[index]?.id !== saved.anchorDisplayId) {
                idx2 = itemsAfter.findIndex((i) => i.id === saved.anchorDisplayId);
            }
            if (idx2 < 0) return;
            const layoutAfter = list.getLayout(idx2);
            const intra2 = layoutAfter && isMeasured(layoutAfter) && layoutAfter.height > 0
                ? clampIntra(layoutAfter, intra)
                : intra;
            if (idx2 !== index || intra2 !== intra) {
                await list.scrollToIndex({ index: idx2, animated: false, viewPosition: 0, viewOffset: intra2 });
            }
        } finally {
            restoreInFlightRef.current = false;
        }
    }, [sessionId]);

    // Remount path: onLoad fires once after the initial window is laid out.
    const restoredRef = React.useRef(false);
    const handleLoad = useCallback(() => {
        if (restoredRef.current) return;
        restoredRef.current = true;
        void restoreViewport({ retained: false });
    }, [restoreViewport]);

    // Retained-screen path: capture on blur, restore on refocus. The first
    // focus of a mount is skipped — onLoad owns that one (the list may not
    // even have laid out yet). Restore waits for the navigation transition so
    // it measures the settled viewport, and a blur cancels it via the token.
    const blurredSinceMountRef = React.useRef(false);
    useFocusEffect(
        useCallback(() => {
            let task = blurredSinceMountRef.current
                ? InteractionManager.runAfterInteractions(() => { void restoreViewport({ retained: true }); })
                : null;
            // App background/foreground does NOT blur the route, so it's
            // handled here — and ONLY while this chat is the focused route: a
            // chat retained under the terminal must not overwrite the good
            // blur snapshot with its detached geometry. Capture once per
            // non-active cycle (iOS fires active→inactive→background; the
            // second event would re-capture AFTER the group collapse rendered)
            // and restore when the app returns to the foreground (the
            // background collapse changed row geometry under the viewport).
            let bgCaptured = false;
            const sub = AppState.addEventListener('change', (state) => {
                if (state !== 'active') {
                    if (!bgCaptured) {
                        bgCaptured = true;
                        captureViewport();
                    }
                } else if (bgCaptured) {
                    bgCaptured = false;
                    task?.cancel();
                    task = InteractionManager.runAfterInteractions(() => { void restoreViewport({ retained: true }); });
                }
            });
            return () => {
                sub.remove();
                task?.cancel();
                restoreGenRef.current++; // invalidate any in-flight restore
                blurredSinceMountRef.current = true;
                captureViewport();
            };
        }, [captureViewport, restoreViewport]),
    );

    // Unmount fallback (layout-effect cleanup runs before children detach, so
    // the FlashList ref is still readable — a plain effect cleanup is not).
    React.useLayoutEffect(() => () => { captureViewport(); }, [captureViewport]);

    const scrollToBottom = useCallback(() => {
        // Don't pin topVisibleIndex to MAX here: onViewableItemsChanged corrects
        // it to the real viewport top after the scroll, and a stale MAX would make
        // the next Up press target the (already-visible) newest prompt → a no-op.
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

    // Up: jump to the nearest user prompt strictly ABOVE the current viewport top.
    // Always relative to the topmost visible row (symmetric with scrubToNextPrompt).
    // Do NOT special-case "at bottom" to target the newest prompt: at the bottom
    // that prompt is usually already on screen in the last screenful, so
    // scrollToIndex(viewPosition:0) can't lift it to the top and the press is a
    // no-op. Using the real viewport top always steps to a prompt above the fold.
    const scrubToPrevPrompt = useCallback(() => {
        const idxs = promptIndicesRef.current;
        if (idxs.length === 0) return;
        const top = topVisibleIndexRef.current;
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
                extraData={collapsedGroups}
                onScroll={handleScroll}
                onLoad={handleLoad}
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
