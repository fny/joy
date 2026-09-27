import * as React from 'react';
import { useSession, useSessionMessages, useSetting, useUnopenableGaps } from "@/sync/storage";
import { sync } from '@/sync/sync';
import { projectUnopenableGapRows } from '@/sync/unopenableGapRows';
import { ActivityIndicator, AppState, InteractionManager, type LayoutChangeEvent, NativeScrollEvent, NativeSyntheticEvent, Platform, Pressable, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { FlashList, type FlashListRef } from '@shopify/flash-list';
import { useCallback } from 'react';
import { useHeaderHeight } from '@/utils/responsive';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MessageView } from './MessageView';
import { AgentWorkGroupView, ToolGroupView } from './ToolGroupView';
import { Metadata, Session } from '@/sync/storageTypes';
import { ChatFooter } from './ChatFooter';
import { Message } from '@/sync/typesMessage';
import { DisplayItem, ToolGroupItem, useGroupedMessages } from '@/hooks/useGroupedMessages';
import Octicons from '@expo/vector-icons/Octicons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { alertError, guarded } from '@/utils/guardAsync';
import { resolveRevealScroll, rowContainsMessage, RevealLayout, RevealTarget } from './searchReveal';
import { useSessionSearch } from '@/hooks/useSessionSearch';
import { distanceFromBottom, heldOpenTurn, initialScrollState, mayFollow, nextScrollState, type Metrics, type Mode, type ScrollEffect, type ScrollEvent } from './chatScroll';

const SCROLL_THRESHOLD = 300;

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
        // Message ids of the rows adjacent to the anchor at capture time —
        // tried in order when BOTH anchor lookups fail (history cap pruned the
        // anchor, or regrouping swallowed it), so the restore lands on the
        // nearest surviving neighbor instead of giving up.
        neighborMessageIds: string[];
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

// Count a row as "visible" as soon as any sliver of it is in view, so the
// topmost partially-clipped row is tracked as the viewport top. Must be a stable
// reference — FlashList/RN forbid changing it between renders.
const VIEWABILITY_CONFIG = { itemVisiblePercentThreshold: 0 } as const;

/** Imperative surface for in-session search: scroll the chat to the row that
 *  contains a given message id. Returns false when that message isn't in the
 *  currently loaded/grouped window (older history not paged in yet). */
export interface ChatListHandle {
    scrollToMessageId: (messageId: string) => boolean;
}

export const ChatList = React.forwardRef<ChatListHandle, { session: Session }>((props, ref) => {
    const { messages: storedMessages, hasMoreOlder, isLoadingOlder } = useSessionMessages(props.session.id);
    const unopenableGaps = useUnopenableGaps(props.session.id);
    // Spans this device could not decrypt show as a placeholder row each,
    // projected here at read time — never written into history (#128).
    const messages = React.useMemo(
        () => projectUnopenableGapRows(storedMessages, unopenableGaps),
        [storedMessages, unopenableGaps],
    );
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
            ref={ref}
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
    //
    // The spinner's slot is ALWAYS rendered, only its opacity changes. Mounting
    // and unmounting it grew and shrank the header by its own height, and the
    // header sits exactly where the user is heading when they scroll up — so
    // every older page shifted the whole list down and back up again, once per
    // fetch. That was the "scrolling jumps up and down as I scroll up" report
    // (2026-09-03). A constant-height header cannot move the content below it.
    return (
        <View>
            <View style={styles.loadingOlderSlot}>
                <ActivityIndicator size="small" style={{ opacity: props.isLoadingOlder ? 1 : 0 }} />
            </View>
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

const ChatListInternal = React.memo(React.forwardRef<ChatListHandle, {
    metadata: Metadata | null,
    sessionId: string,
    messages: Message[],
    hasMoreOlder: boolean,
    isLoadingOlder: boolean,
}>((props, ref) => {
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
    // into snapshots for diagnostics ('live' mode) — reading snapshots restore
    // their anchor regardless of new content (see runRestore).
    const newestIdRef = React.useRef<string | null>(null);
    newestIdRef.current = props.messages[0]?.id ?? null;
    const session = useSession(props.sessionId);

    // ── Viewport ownership (chatScroll.ts) ───────────────────────────────
    // Every event is reduced SYNCHRONOUSLY into this ref: a frame scheduled
    // earlier must read the current permission, not the last render's. The
    // mode is mirrored into state only for what renders from it (the down
    // button, the fold hold).
    const scrollStateRef = React.useRef(initialScrollState());
    const [mode, setMode] = React.useState<Mode>('following');
    // Filled in below, once the list's callbacks exist; events arriving
    // before then (none do — they all come from the list) would be dropped.
    const dispatchRef = React.useRef<(event: ScrollEvent) => void>(() => {});
    const dispatch = useCallback((event: ScrollEvent) => dispatchRef.current(event), []);

    // Collapse agent work between a user prompt and the final answer.
    // Nested tool groups remain expandable inside the work block.
    const groupToolCalls = useSetting('groupToolCalls');
    const hasPendingPermission = Boolean(
        session?.agentState?.requests && Object.keys(session.agentState.requests).length > 0,
    );
    // The latest turn stays unfolded from the moment it starts thinking until
    // the next prompt arrives — folding it the instant the turn ended pulled
    // the rows out from under the viewport (chatScroll.ts, heldOpenTurn).
    const latestPromptId = React.useMemo(() => props.messages.find((m) => m.kind === 'user-text')?.id ?? null, [props.messages]);
    const [heldOpen, setHeldOpen] = React.useState<string | null>(null);
    React.useEffect(() => {
        setHeldOpen((held) => heldOpenTurn(held, session?.thinking === true, latestPromptId));
    }, [session?.thinking, latestPromptId]);
    const collapseCurrentTurn = session?.thinking !== true && !hasPendingPermission && heldOpen !== latestPromptId;
    // A reader keeps the turn they were in unfolded until they follow again:
    // when the next prompt lands, that turn's rows would otherwise fold into
    // one work row under them — a jump no follow policy can prevent, since
    // it is the rows themselves that move (gpt-6-astra, round 2).
    // Every turn that is open at any point while reading is held, not just the
    // first — the reader may move down into a later one. Decided during render
    // from the machine's synchronous mode, and from the PREVIOUS render's open
    // turn too: when the reader leaving following and the next prompt land in
    // one commit, the turn that was open is the one to keep.
    const openTurnPrompt = collapseCurrentTurn ? null : latestPromptId;
    const prevOpenTurnRef = React.useRef(openTurnPrompt);
    const holdRef = React.useRef<Set<string>>(new Set());
    if (scrollStateRef.current.mode === 'reading') {
        if (prevOpenTurnRef.current) holdRef.current.add(prevOpenTurnRef.current);
        if (openTurnPrompt) holdRef.current.add(openTurnPrompt);
    } else if (holdRef.current.size > 0) {
        holdRef.current = new Set();
    }
    prevOpenTurnRef.current = openTurnPrompt;
    const holdKey = [...holdRef.current].join(',');
    const groupingOptions = React.useMemo(
        () => ({ collapseCurrentTurn, openPromptIds: holdKey ? new Set(holdKey.split(',')) : undefined }),
        [collapseCurrentTurn, holdKey],
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

    // In-session search target (#203). State so the row holding it re-renders
    // with the `reveal` prop (via extraData); mirrored to a ref so renderItem
    // and the reveal callbacks read the latest without changing identity.
    const [revealTarget, setRevealTarget] = React.useState<RevealTarget | null>(null);
    const revealTargetRef = React.useRef<RevealTarget | null>(null);
    const revealNonceRef = React.useRef(0);
    // Nonce whose hit already scrolled to its measured position: later layout
    // reports for it (streaming re-layouts, recycling) must not scroll again.
    const revealHandledRef = React.useRef(0);
    // The live search hit (#639). Same ref-plus-extraData shape as the reveal
    // target above: renderItem reads the ref so its identity never changes,
    // and extraData makes the visible rows re-render when the hit moves.
    const searchQuery = useSessionSearch((st) => st.query);
    const searchMessageId = useSessionSearch((st) => st.selectedMessageId);
    const searchRef = React.useRef({ query: searchQuery, messageId: searchMessageId });
    searchRef.current = { query: searchQuery, messageId: searchMessageId };
    const listExtraData = React.useMemo(
        () => ({ collapsedGroups, revealTarget, searchQuery, searchMessageId }),
        [collapsedGroups, revealTarget, searchQuery, searchMessageId],
    );

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

    // Deferred while reading: collapsing the groups a reader has open moves
    // the rows under them. It runs when they follow again.
    const prevUserMsgIdRef = React.useRef(latestUserMsgId);
    const collapsePendingRef = React.useRef(false);
    React.useEffect(() => {
        if (latestUserMsgId && latestUserMsgId !== prevUserMsgIdRef.current) {
            prevUserMsgIdRef.current = latestUserMsgId;
            collapsePendingRef.current = true;
        }
        if (collapsePendingRef.current && mode === 'following') {
            collapsePendingRef.current = false;
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
    }, [latestUserMsgId, mode]);

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

    // In-session search (Cmd/Ctrl+F): reveal the message with a given id.
    // Returns false if the id isn't in the grouped window so the caller can
    // surface "not in loaded history".
    //
    // A hit inside a COLLAPSED group is revealed first: the group renders its
    // messages only when expanded, so scrolling to the header alone left the
    // selected match absent from the visible chat (#203). Nested tool groups
    // inside an agent-work-group keep their own collapse state, so the target
    // also travels DOWN as the `reveal` prop: AgentWorkGroupView opens the
    // nested group holding it, and the rendered hit reports its layout within
    // the row (RevealAnchor → handleRevealLayout), which scrolls to the hit's
    // ACTUAL position resolved against the current data — scrolling to the
    // group start alone need not bring a later hit of a long group into view.
    // The coarse row scroll is the fallback for rows that never report (bare
    // message rows) and the way to mount a row that is virtualized out — its
    // anchor then reports and refines.
    // The navigate operation a reveal runs under: the reader scrolling
    // (or a newer jump) takes it over, and its late steps stop.
    const revealGenRef = React.useRef(-1);
    const isCurrentOp = useCallback((gen: number) => scrollStateRef.current.op?.gen === gen, []);
    const handleRevealLayout = useCallback((layout: RevealLayout) => {
        const target = revealTargetRef.current;
        if (!target || layout.nonce !== target.nonce || layout.messageId !== target.messageId) return;
        if (revealHandledRef.current === target.nonce) return;
        const gen = revealGenRef.current;
        if (!isCurrentOp(gen)) return;
        const list = flatListRef.current;
        if (!list) return;
        const scroll = resolveRevealScroll(orderedItemsRef.current, target.messageId, layout, list.getWindowSize().height);
        if (!scroll) return;
        revealHandledRef.current = target.nonce;
        void list.scrollToIndex({ ...scroll, animated: true }).finally(() => dispatch({ type: 'opDone', gen, now: Date.now() }));
    }, [dispatch, isCurrentOp]);
    React.useImperativeHandle(ref, () => ({
        scrollToMessageId: (messageId: string) => {
            const items = orderedItemsRef.current;
            const index = items.findIndex((i) => rowContainsMessage(i, messageId));
            if (index < 0) return false;
            const row = items[index];
            const target: RevealTarget = { messageId, nonce: ++revealNonceRef.current };
            revealTargetRef.current = target;
            dispatch({ type: 'navigate', now: Date.now() });
            const gen = scrollStateRef.current.op?.gen ?? -1;
            revealGenRef.current = gen;
            // Bare message rows have nothing to open or measure.
            setRevealTarget(row.type === 'message' ? null : target);
            const coarse = () => {
                if (revealTargetRef.current !== target || revealHandledRef.current === target.nonce || !isCurrentOp(gen)) return;
                const scroll = resolveRevealScroll(orderedItemsRef.current, messageId, null, 0);
                if (!scroll) return;
                const done = flatListRef.current?.scrollToIndex({ ...scroll, animated: true });
                // A bare row never reports a layout: its coarse jump is the whole operation.
                if (row.type === 'message') void done?.finally(() => dispatch({ type: 'opDone', gen, now: Date.now() }));
            };
            if (row.type !== 'message' && collapsedGroupsRef.current.has(row.id)) {
                manuallyCollapsedRef.current.delete(row.id); // a search reveal is not a manual collapse
                setCollapsedGroups((prev) => {
                    if (!prev.has(row.id)) return prev;
                    const next = new Set(prev);
                    next.delete(row.id);
                    return next;
                });
                // Once the expanded layout has committed (two frames later),
                // unless the hit's anchor already reported and scrolled.
                requestAnimationFrame(() => requestAnimationFrame(coarse));
                return true;
            }
            coarse();
            return true;
        },
    }), [dispatch, isCurrentOp]);

    const keyExtractor = useCallback((item: DisplayItem) => item.id, []);

    // Recycling pools. Without this every row shape — a one-line user bubble, a
    // long markdown answer, a tool group — shares ONE pool, so a recycled cell
    // mounts at the previous row's height and corrects only after measuring.
    // That correction is visible as jitter while scrolling. Splitting text rows
    // by ROLE as well as by item type matters most: user bubbles and agent
    // answers are the two extremes of the height range and recycled into each
    // other constantly.
    const getItemType = useCallback((item: DisplayItem) => (
        item.type === 'message' ? `message:${item.message.kind === 'user-text' ? 'user' : 'agent'}` : item.type
    ), []);

    const renderItem = useCallback(({ item }: { item: DisplayItem }) => {
        // Only the row holding the search target receives it (identity-stable
        // per search), so every other memoized row compares null to null.
        const target = revealTargetRef.current;
        const reveal = target && item.type !== 'message' && rowContainsMessage(item, target.messageId) ? target : null;
        if (item.type === 'tool-group') {
            return (
                <ToolGroupView
                    group={item}
                    metadata={props.metadata}
                    sessionId={props.sessionId}
                    expanded={!collapsedGroupsRef.current.has(item.id)}
                    onToggle={handleToggleGroup}
                    reveal={reveal}
                    onRevealLayout={handleRevealLayout}
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
                    reveal={reveal}
                    onRevealLayout={handleRevealLayout}
                />
            );
        }
        // Only the selected match highlights, so a keystroke re-renders one row
        // rather than every mounted message.
        const search = searchRef.current;
        const highlight = search.query && item.type === 'message' && item.message.id === search.messageId
            ? search.query
            : undefined;
        return (
            <MessageView
                highlight={highlight}
                message={item.message}
                metadata={props.metadata}
                sessionId={props.sessionId}
            />
        );
    }, [props.metadata, props.sessionId, handleToggleGroup, handleRevealLayout]);

    // ── Scroll facts, intent and effects (chatScroll.ts) ──────────────────
    // Non-inverted list: the newest messages sit at the visual bottom. Whether
    // new content pulls the viewport down is decided by the scroll machine,
    // from the reader's own input — never from where a scroll report landed
    // (that inference was the "scroll up → jumps to the bottom" bug: content
    // shrinking under a reader clamped them to the end, and the end re-armed
    // following). FlashList's autoscrollToBottomThreshold stays off: only one
    // owner may move the viewport.

    // Buttons: the down arrow shows whenever the reader is reading — also
    // right at the bottom, where it is the way back to following — or far
    // from the end; the prompt stepper keeps its distance thresholds.
    const updateButtons = useCallback((m: Metrics) => {
        const next = distanceFromBottom(m) > SCROLL_THRESHOLD;
        if (next !== showScrollButtonRef.current) {
            showScrollButtonRef.current = next;
            setShowScrollButton(next);
        }
        const up = m.offset > SCROLL_THRESHOLD;
        if (up !== showUpButtonRef.current) {
            showUpButtonRef.current = up;
            setShowUpButton(up);
        }
    }, []);

    const metricsOf = (e: NativeSyntheticEvent<NativeScrollEvent>): Metrics => {
        const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
        return { offset: contentOffset.y, maxOffset: Math.max(0, contentSize.height - layoutMeasurement.height) };
    };

    // Native: FlashList's filtered onScroll. Web reads the scroller's own
    // 'scroll' events instead (below) — FlashList drops these for 100ms after
    // each data-length correction.
    const handleScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
        if (Platform.OS === 'web') return;
        const m = metricsOf(e);
        dispatch({ type: 'scroll', metrics: m, now: Date.now() });
        updateButtons(m);
    }, [dispatch, updateButtons]);
    // Native drag and momentum bypass that filter and carry the offset.
    const handleScrollBeginDrag = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
        if (Platform.OS === 'web') return;
        dispatch({ type: 'dragStart', metrics: metricsOf(e), now: Date.now() });
    }, [dispatch]);
    const handleScrollEndDrag = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
        if (Platform.OS === 'web') return;
        dispatch({ type: 'dragEnd', metrics: metricsOf(e), now: Date.now() });
    }, [dispatch]);
    const handleMomentumBegin = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
        if (Platform.OS === 'web') return;
        dispatch({ type: 'momentumStart', metrics: metricsOf(e), now: Date.now() });
    }, [dispatch]);
    const handleMomentumEnd = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
        if (Platform.OS === 'web') return;
        dispatch({ type: 'momentumEnd', metrics: metricsOf(e), now: Date.now() });
    }, [dispatch]);

    // ── Viewport save/restore ─────────────────────────────────────────────
    // Commit points: navigation blur (terminal-pane push RETAINS this screen —
    // no unmount, no AppState change), app background, and unmount as a
    // fallback. Restore points: first onLoad (remount) and refocus of a
    // retained screen (onLoad never re-fires there). A restore is an
    // operation of the scroll machine: the reader taking over cancels it.
    const captureViewport = useCallback(() => {
        const state = scrollStateRef.current;
        // Mid-restore, the viewport is an intermediate position — FlashList
        // can't cancel a started scroll, so the pre-restore snapshot (exactly
        // what was being restored) stays the best record.
        if (state.op?.kind === 'restore' || state.restoreInterrupted) return;
        const newestMessageId = newestIdRef.current;
        if (state.mode === 'following') {
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
        // Neighbor fallbacks: rows just below then just above the anchor
        // (below first — landing slightly later in the conversation reads
        // better than jumping back before what the user already read).
        const neighbors: string[] = [];
        for (const j of [index + 1, index - 1, index + 2]) {
            const id = items[j] ? anchorMessageIdFor(items[j]) : null;
            if (id) neighbors.push(id);
        }
        rememberViewport(sessionId, {
            mode: 'reading',
            anchorDisplayId: row.id,
            anchorMessageId: anchorMessageIdFor(row),
            neighborMessageIds: neighbors,
            intraItemOffset: intra,
            newestMessageId,
        });
    }, [sessionId]);

    // Ask the machine to restore the saved viewport: a live snapshot follows,
    // a reading one starts a restore operation (runRestore below).
    // `token` is the machine generation when the restore was SCHEDULED: if the
    // reader has touched the list since (or anything else took over), the
    // queued restore is stale and does nothing.
    const requestRestore = useCallback((token: number) => {
        if (scrollStateRef.current.gen !== token) return;
        const saved = savedViewport.get(sessionId);
        if (!saved) return;
        dispatch({ type: 'restore', live: saved.mode === 'live', now: Date.now() });
    }, [sessionId, dispatch]);
    const scheduleRestore = useCallback(() => {
        const token = scrollStateRef.current.gen;
        return InteractionManager.runAfterInteractions(() => requestRestore(token));
    }, [requestRestore]);

    // A reading restore, under operation `gen`: every step first checks that
    // the operation is still current — the reader scrolling, a newer restore,
    // a blur all end it.
    const runRestore = useCallback(async (gen: number) => {
        const finish = () => dispatch({ type: 'opDone', gen, now: Date.now() });
        const list = flatListRef.current;
        const saved = savedViewport.get(sessionId);
        if (!list || !saved || saved.mode !== 'reading') { finish(); return; }
        // A reading anchor is restored even when new content arrived while
        // away (the OLD rule discarded it and jumped to the bottom — which
        // fired on essentially every terminal round-trip during a busy
        // session, since visiting the terminal is exactly when messages
        // stream in; joint claude+codex diagnosis 2026-08-04). Jumping to the
        // new content is the user's call, via the down button.
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
            // Anchor pruned (history cap) or dissolved — nearest surviving
            // neighbor from capture time, below-first.
            for (const nid of saved.neighborMessageIds ?? []) {
                index = items.findIndex((i) => rowContainsMessage(i, nid));
                if (index >= 0) { intra = 0; break; }
            }
        }
        if (index < 0) {
            // Nothing to anchor to. On a retained screen the native list is
            // still sitting near the old offset — leaving it alone preserves
            // more of the user's position than yanking to the bottom ever did.
            finish();
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
        try {
            await list.scrollToIndex({ index, animated: false, viewPosition: 0, viewOffset: intra });
            if (!isCurrentOp(gen)) return;
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
            finish();
        }
    }, [sessionId, dispatch, isCurrentOp]);

    // Web: the DOM scroller, once the list has one. Resolved on load and on
    // every layout, so the listeners attach late if they must, and move to a
    // replacement node.
    const [scrollNode, setScrollNode] = React.useState<HTMLElement | null>(null);
    const scrollNodeRef = React.useRef<HTMLElement | null>(null);
    const resolveScrollNode = useCallback(() => {
        if (Platform.OS !== 'web') return;
        const node = ((flatListRef.current as any)?.getScrollableNode?.() as HTMLElement | undefined) ?? null;
        if (node !== scrollNodeRef.current) { scrollNodeRef.current = node; setScrollNode(node); }
    }, []);
    /** Web can read the metrics synchronously; native reports them itself. */
    const webMetrics = useCallback((): Metrics | undefined => {
        const n = scrollNodeRef.current;
        return n ? { offset: n.scrollTop, maxOffset: Math.max(0, n.scrollHeight - n.clientHeight) } : undefined;
    }, []);

    // Remount path: onLoad fires once after the initial window is laid out.
    // Until then FlashList's startRenderingFromBottom owns the position.
    const restoredRef = React.useRef(false);
    const handleLoad = useCallback(() => {
        if (restoredRef.current) return;
        restoredRef.current = true;
        resolveScrollNode();
        const saved = savedViewport.get(sessionId);
        if (saved?.mode === 'reading') requestRestore(scrollStateRef.current.gen);
        else dispatch({ type: 'geometry', now: Date.now() });
    }, [sessionId, requestRestore, dispatch, resolveScrollNode]);

    // ── Effects ──────────────────────────────────────────────────────────
    // followBottom is coalesced to one native command per frame and checked
    // again when it runs: the permission may have been revoked meanwhile.
    // It goes straight to the native scroller, not through FlashList's
    // deferred scrollToEnd wrapper, whose queued command could land after
    // the reader took over.
    const followFrameRef = React.useRef<number | null>(null);
    const nativeScrollToEnd = useCallback((animated: boolean) => {
        flatListRef.current?.getNativeScrollRef()?.scrollToEnd({ animated });
    }, []);
    const runEffect = useCallback((effect: ScrollEffect) => {
        switch (effect.type) {
            case 'followBottom':
                if (followFrameRef.current !== null) return;
                followFrameRef.current = requestAnimationFrame(() => {
                    followFrameRef.current = null;
                    if (!restoredRef.current || !mayFollow(scrollStateRef.current, Date.now())) return;
                    nativeScrollToEnd(false);
                });
                return;
            case 'scrollToBottom':
                nativeScrollToEnd(effect.animated);
                return;
            case 'startOp':
                if (effect.kind === 'restore') void runRestore(effect.gen);
                return; // navigate: the caller runs the jump
        }
    }, [nativeScrollToEnd, runRestore]);

    // Timed phases (wheel, key, a drag's release) end by going quiet: one
    // timer, re-armed on every event, delivers the tick that ends them.
    const tickTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const modeSetRef = React.useRef<Mode>('following');
    dispatchRef.current = (event: ScrollEvent) => {
        const r = nextScrollState(scrollStateRef.current, event);
        scrollStateRef.current = r.state;
        if (r.state.mode !== modeSetRef.current) { modeSetRef.current = r.state.mode; setMode(r.state.mode); }
        if (tickTimerRef.current) { clearTimeout(tickTimerRef.current); tickTimerRef.current = null; }
        const until = r.state.interaction?.until;
        if (until != null) {
            tickTimerRef.current = setTimeout(() => {
                tickTimerRef.current = null;
                dispatchRef.current({ type: 'tick', metrics: webMetrics(), now: Date.now() });
            }, Math.max(0, until - event.now) + 5);
        }
        for (const effect of r.effects) runEffect(effect);
    };
    React.useEffect(() => () => {
        if (tickTimerRef.current) clearTimeout(tickTimerRef.current);
        if (followFrameRef.current !== null) cancelAnimationFrame(followFrameRef.current);
    }, []);

    // ── Geometry ─────────────────────────────────────────────────────────
    // New rows and streamed growth, the measured content size landing, and
    // the list's own height changing (the composer growing, the keyboard):
    // facts for the machine, which follows only a following reader.
    React.useEffect(() => {
        dispatch({ type: 'geometry', metrics: webMetrics(), now: Date.now() });
    }, [orderedItems, dispatch, webMetrics]);
    const handleContentSizeChange = useCallback(() => {
        dispatch({ type: 'geometry', metrics: webMetrics(), now: Date.now() });
    }, [dispatch, webMetrics]);
    const layoutHeightRef = React.useRef<number | null>(null);
    const handleLayout = useCallback((e: LayoutChangeEvent) => {
        resolveScrollNode();
        const h = e.nativeEvent.layout.height;
        const changed = layoutHeightRef.current !== null && layoutHeightRef.current !== h;
        layoutHeightRef.current = h;
        if (changed) dispatch({ type: 'geometry', metrics: webMetrics(), now: Date.now() });
    }, [dispatch, webMetrics, resolveScrollNode]);

    // Sending a prompt from THIS client is a request to watch the reply. A
    // send is a NEW row at deliveryStage 'local' (only rows this client sent
    // carry a stage, and only an unacknowledged one is 'local'). Keyed by the
    // row id, which the reducer keeps through the server's acknowledgment
    // (localId does not survive it: it turns null). Every id seen is kept, so
    // an older prompt resurfacing as the newest row is not a send either.
    const seenSendsRef = React.useRef<Set<string> | null>(null);
    if (seenSendsRef.current === null) {
        seenSendsRef.current = new Set(props.messages.filter((m) => m.kind === 'user-text' && m.deliveryStage !== undefined).map((m) => m.id));
    }
    const newest = props.messages[0];
    const freshSendId = newest?.kind === 'user-text' && newest.deliveryStage === 'local' ? newest.id : null;
    React.useEffect(() => {
        if (!freshSendId || seenSendsRef.current!.has(freshSendId)) return;
        seenSendsRef.current!.add(freshSendId);
        dispatch({ type: 'sent', now: Date.now() });
    }, [freshSendId, dispatch]);

    // Retained-screen path: capture on blur, restore on refocus. The first
    // focus of a mount is skipped — onLoad owns that one (the list may not
    // even have laid out yet). Restore waits for the navigation transition so
    // it measures the settled viewport, and a blur cancels it via the token.
    // Route visibility and app activity are separate facts for the machine:
    // returning to the app does not un-hide a route still under another
    // screen, and refocusing does not resume a backgrounded app.
    const blurredSinceMountRef = React.useRef(false);
    // App activity is a fact for the machine whatever route is focused — a
    // focus-scoped listener missed the app returning while another screen
    // was on top, and left the chat suspended for good.
    React.useEffect(() => {
        const sub = AppState.addEventListener('change', (state) => {
            dispatch({ type: state === 'active' ? 'appActive' : 'appBackground', now: Date.now() });
        });
        return () => sub.remove();
    }, [dispatch]);
    useFocusEffect(
        useCallback(() => {
            dispatch({ type: AppState.currentState === 'active' || AppState.currentState == null ? 'appActive' : 'appBackground', now: Date.now() });
            dispatch({ type: 'routeShown', now: Date.now() });
            let task = blurredSinceMountRef.current ? scheduleRestore() : null;
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
                    task = scheduleRestore();
                }
            });
            return () => {
                sub.remove();
                task?.cancel();
                blurredSinceMountRef.current = true;
                captureViewport();
                dispatch({ type: 'routeHidden', now: Date.now() });
            };
        }, [captureViewport, scheduleRestore, dispatch]),
    );

    // Unmount fallback (layout-effect cleanup runs before children detach, so
    // the FlashList ref is still readable — a plain effect cleanup is not).
    React.useLayoutEffect(() => () => { captureViewport(); }, [captureViewport]);

    const scrollToBottom = useCallback(() => {
        // Don't pin topVisibleIndex to MAX here: onViewableItemsChanged corrects
        // it to the real viewport top after the scroll, and a stale MAX would make
        // the next Up press target the (already-visible) newest prompt → a no-op.
        dispatch({ type: 'bottomPressed', now: Date.now() });
    }, [dispatch]);

    // A prompt-stepper jump, as a navigate operation: the reader reads there.
    // FlashList's scrollToIndex cannot be cancelled once started (its
    // preparation passes run to completion) — the operation's generation at
    // least keeps follow from fighting it, and ends it cleanly.
    const jumpToIndex = useCallback((index: number) => {
        dispatch({ type: 'navigate', now: Date.now() });
        const gen = scrollStateRef.current.op?.gen ?? -1;
        void flatListRef.current?.scrollToIndex({ index, animated: true, viewPosition: 0 })
            .finally(() => dispatch({ type: 'opDone', gen, now: Date.now() }));
    }, [dispatch]);

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
        jumpToIndex(target);
    }, [jumpToIndex]);

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
        jumpToIndex(target);
    }, [scrollToBottom, jumpToIndex]);

    // Older history lives at the visual TOP now, so `onStartReached` fires when
    // the user scrolls up toward it. Initial fetch only loads the latest 100
    // messages (see sync.fetchInitialLatestPage), so we lazy-load earlier pages
    // here; maintainVisibleContentPosition keeps the viewport anchored as
    // older pages prepend.
    const hasMoreOlder = props.hasMoreOlder;
    const isLoadingOlder = props.isLoadingOlder;
    // A failed page is reported (the spinner has already cleared); scrolling
    // up again retries.
    const handleLoadOlder = useCallback(() => {
        if (!hasMoreOlder || isLoadingOlder) return;
        guarded(() => sync.loadOlderMessages(sessionId), alertError())();
    }, [sessionId, hasMoreOlder, isLoadingOlder]);

    // Web intent, read from the scroller itself — sources FlashList cannot
    // swallow. RN-Web has no drag/momentum callbacks; wheel, keyboard and
    // pointer (scrollbar, touch) are the reader's hands. Also restores
    // vertical scrolling when Shift+wheel swaps deltaX/deltaY.
    React.useEffect(() => {
        const node = scrollNode;
        if (Platform.OS !== 'web' || !node) return;
        const metrics = (): Metrics => ({ offset: node.scrollTop, maxOffset: Math.max(0, node.scrollHeight - node.clientHeight) });
        const onScroll = () => {
            const m = metrics();
            dispatch({ type: 'scroll', metrics: m, now: Date.now() });
            updateButtons(m);
        };
        // Decide who owns the wheel BEFORE anything moves: a nested scroller
        // with room takes it, and the chat is only moved (Shift+wheel) after
        // the machine has heard the reader's direction.
        const onWheel = (e: WheelEvent) => {
            if (e.ctrlKey) return; // pinch / zoom
            const swapped = e.shiftKey && Math.abs(e.deltaX) > 0 && Math.abs(e.deltaY) < 1;
            if (!swapped && Math.abs(e.deltaX) > Math.abs(e.deltaY)) return; // horizontal: a code block or table
            const dy = swapped ? e.deltaX : e.deltaY;
            if (dy === 0 || nestedScrollerTakes(e.target, node, dy)) return;
            dispatch({ type: 'wheel', dy, now: Date.now() });
            if (swapped) {
                node.scrollTop += dy;
                e.preventDefault();
            }
        };
        const onKey = (e: KeyboardEvent) => {
            if (e.defaultPrevented || isEditable(e.target)) return;
            const active = document.activeElement;
            if (active && active !== document.body && !node.contains(active)) return;
            const dir = KEY_DIRECTION[e.key];
            if (!dir) return;
            const older = dir === 'older' || (e.key === ' ' && e.shiftKey);
            // A focused nested scroller with room takes its keys.
            if (active && active !== node && node.contains(active) && nestedScrollerTakes(active, node, older ? -1 : 1)) return;
            dispatch({ type: 'key', dir: older ? 'older' : 'newer', now: Date.now() });
        };
        // A scroll grab only: a touch, or a mouse press on the scrollbar. A
        // click inside the content (expanding a group, selecting text) is
        // not one — offset changes during it are the list's own (MVCP) and
        // must not be read as the reader's direction.
        const onPointerDown = (e: PointerEvent) => {
            if (e.pointerType === 'mouse') {
                if (e.button !== 0) return;
                const r = node.getBoundingClientRect();
                if (e.clientX < r.left + node.clientWidth) return;
            }
            dispatch({ type: 'pointerDown', metrics: metrics(), now: Date.now() });
        };
        // The release can land outside the scroller (a scrollbar drag), or
        // never arrive (window blur): listen on the window for every end.
        const onPointerUp = () => dispatch({ type: 'pointerUp', metrics: metrics(), now: Date.now() });
        node.addEventListener('scroll', onScroll, { passive: true });
        node.addEventListener('wheel', onWheel, { passive: false });
        node.addEventListener('pointerdown', onPointerDown, { passive: true });
        window.addEventListener('pointerup', onPointerUp, true);
        window.addEventListener('pointercancel', onPointerUp, true);
        window.addEventListener('blur', onPointerUp);
        window.addEventListener('keydown', onKey);
        return () => {
            node.removeEventListener('scroll', onScroll);
            node.removeEventListener('wheel', onWheel);
            node.removeEventListener('pointerdown', onPointerDown);
            window.removeEventListener('pointerup', onPointerUp, true);
            window.removeEventListener('pointercancel', onPointerUp, true);
            window.removeEventListener('blur', onPointerUp);
            window.removeEventListener('keydown', onKey);
        };
    }, [scrollNode, dispatch, updateButtons]);

    // The way back to following: whenever the reader is reading (even at the
    // bottom — clamped there by content shrinking, or a few px above it), or
    // far from the end.
    const showLiveButton = mode === 'reading' || showScrollButton;

    return (
        <View style={{ flex: 1 }}>
            <FlashList
                ref={flatListRef}
                data={orderedItems}
                keyExtractor={keyExtractor}
                getItemType={getItemType}
                maintainVisibleContentPosition={{
                    // startRenderingFromBottom: first paint starts at the bottom
                    // (newest) — the fast path; FlashList only mounts the visible
                    // window instead of every message.
                    startRenderingFromBottom: true,
                    // No autoscroll thresholds. Following the newest message
                    // is the scroll machine's job (chatScroll.ts). The top
                    // threshold never anchored anything: on iOS it animates to
                    // offset 0 after an anchor correction near the top — a
                    // jump to the oldest message while paging (gpt-6-astra).
                    // Anchoring prepended pages is MVCP itself.
                }}
                keyboardShouldPersistTaps="handled"
                keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'none'}
                renderItem={renderItem}
                extraData={listExtraData}
                onScroll={handleScroll}
                onScrollBeginDrag={handleScrollBeginDrag}
                onScrollEndDrag={handleScrollEndDrag}
                onMomentumScrollBegin={handleMomentumBegin}
                onMomentumScrollEnd={handleMomentumEnd}
                onContentSizeChange={handleContentSizeChange}
                onLayout={handleLayout}
                onLoad={handleLoad}
                scrollEventThrottle={16}
                onViewableItemsChanged={handleViewableItemsChanged}
                viewabilityConfig={VIEWABILITY_CONFIG}
                ListHeaderComponent={<ListHeader isLoadingOlder={props.isLoadingOlder} />}
                ListFooterComponent={<ListFooter sessionId={props.sessionId} />}
                onStartReached={handleLoadOlder}
                onStartReachedThreshold={0.5}
            />
            {(showScrollButton || showUpButton || showLiveButton) && (
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
                    {showLiveButton && (
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
}));

/** Keys that scroll the chat when nothing editable has focus. */
const KEY_DIRECTION: Record<string, 'older' | 'newer'> = {
    PageUp: 'older', ArrowUp: 'older', Home: 'older',
    PageDown: 'newer', ArrowDown: 'newer', End: 'newer', ' ': 'newer',
};

function isEditable(target: EventTarget | null): boolean {
    const el = target as HTMLElement | null;
    if (!el || !el.tagName) return false;
    return el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.tagName === 'BUTTON';
}

/** A wheel over a nested scroller (a long tool output, a code block) that
 *  can still scroll that way moves IT, not the chat. */
function nestedScrollerTakes(target: EventTarget | null, list: HTMLElement, dy: number): boolean {
    for (let el = target as HTMLElement | null; el && el !== list; el = el.parentElement) {
        if (el.scrollHeight <= el.clientHeight + 1) continue;
        const overflowY = getComputedStyle(el).overflowY;
        if (overflowY !== 'auto' && overflowY !== 'scroll') continue;
        if (dy < 0 ? el.scrollTop > 0 : el.scrollTop + el.clientHeight < el.scrollHeight - 1) return true;
    }
    return false;
}

function isCollapsibleDisplayItem(item: DisplayItem): item is ToolGroupItem | Extract<DisplayItem, { type: 'agent-work-group' }> {
    return item.type === 'tool-group' || item.type === 'agent-work-group';
}

const styles = StyleSheet.create((theme) => ({
    // Constant height whether or not the spinner is showing — see ListHeader.
    loadingOlderSlot: {
        height: 36,
        alignItems: 'center',
        justifyContent: 'center',
    },
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
