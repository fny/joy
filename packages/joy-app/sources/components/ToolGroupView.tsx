import * as React from 'react';
import { encodePathParam } from '@/utils/pathParam';
import { View, Text, Pressable, ActivityIndicator, Platform, LayoutChangeEvent } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import Ionicons from '@expo/vector-icons/Ionicons';
import Octicons from '@expo/vector-icons/Octicons';
import {
    AgentWorkGroupItem,
    ToolGroupItem,
    ToolDisplayItem,
    formatWorkDuration,
    generateGroupSummary,
    groupToolCallsForDisplay,
    hasPendingPermission,
} from '@/hooks/useGroupedMessages';
import { MessageView } from './MessageView';
import { Metadata } from '@/sync/storageTypes';
import { layout } from './layout';
import { useElapsedTime } from '@/hooks/useElapsedTime';
import { t } from '@/text';
import { Message, ToolCallMessage } from '@/sync/typesMessage';
import { getToolSummaryCategory, getToolSummaryDetail, ToolSummaryCategory } from '@/utils/toolDisplay';
import { useRouter } from 'expo-router';
import { formatMCPTitle } from './tools/views/MCPToolView';
import { nestedGroupContaining, RevealLayout, RevealTarget } from './searchReveal';

type RevealRoot = React.RefObject<React.ComponentRef<typeof View> | null>;

/** In-session search reveal (#203): the row holding the search target gets
 *  `reveal`; the rendered hit is wrapped in a RevealAnchor that reports its
 *  layout relative to `revealRoot` (the top-level row's outer view) through
 *  `onRevealLayout`, so ChatList scrolls to the hit itself. */
interface RevealProps {
    reveal?: RevealTarget | null;
    onRevealLayout?: (layout: RevealLayout) => void;
}

function RevealAnchor(props: {
    target: RevealTarget;
    root: RevealRoot;
    onLayout?: (layout: RevealLayout) => void;
    children: React.ReactNode;
}) {
    const { target, root, onLayout } = props;
    const ref = React.useRef<React.ComponentRef<typeof View>>(null);
    const report = React.useCallback((fallbackHeight: number | null) => {
        const node = ref.current;
        const rootNode = root.current;
        if (!node || !rootNode || !onLayout) return;
        node.measureLayout(rootNode, (_x, y, _width, height) => {
            const h = height > 0 ? height : (fallbackHeight ?? 0);
            onLayout({ messageId: target.messageId, nonce: target.nonce, y, height: h });
        }, () => { /* unmounted mid-measure: nothing to reveal */ });
    }, [target, root, onLayout]);
    const handleLayout = React.useCallback((e: LayoutChangeEvent) => {
        report(e.nativeEvent.layout.height);
    }, [report]);
    // A repeated search for the same message (new nonce) on an already laid
    // out anchor gets no onLayout; re-measure on the target change instead.
    // The first target is reported by onLayout once the view exists.
    const initialTargetRef = React.useRef(target);
    React.useEffect(() => {
        if (initialTargetRef.current === target) return;
        report(null);
    }, [target, report]);
    return (
        <View ref={ref} collapsable={false} onLayout={handleLayout}>
            {props.children}
        </View>
    );
}

interface ToolGroupViewProps extends RevealProps {
    group: ToolGroupItem;
    metadata: Metadata | null;
    sessionId: string;
    expanded: boolean;
    // Called with the group's id so parents can pass ONE stable handler to
    // every group instead of a fresh closure per render (which defeats memo).
    onToggle: (id: string) => void;
    nested?: boolean;
    hideSingleToolChildren?: boolean;
    /** The enclosing row's root view for reveal measurement; a top-level
     *  group uses its own outer view. */
    revealRoot?: RevealRoot;
}

// Message refs are stable across grouping passes (useGroupedMessages rebuilds
// the group objects/arrays every render, but the underlying Message objects
// only change identity when their content changes). Comparing element-wise is
// therefore both cheap and sufficient to catch any content update.
function areMessagesEqual(a: Message[], b: Message[]): boolean {
    if (a === b) return true;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}

// Covers every rendered input: id (identity + onToggle target), expanded,
// derived flags (hasRunning / hasPendingPermission), the message array
// element-wise (summary, category, suppressChildren and all child rows derive
// from it), plus the passthrough props (metadata, sessionId, onToggle, nested,
// hideSingleToolChildren).
function areToolGroupPropsEqual(prev: ToolGroupViewProps, next: ToolGroupViewProps): boolean {
    return prev.group.id === next.group.id
        && prev.expanded === next.expanded
        && prev.group.hasRunning === next.group.hasRunning
        && prev.group.hasPendingPermission === next.group.hasPendingPermission
        && prev.metadata === next.metadata
        && prev.sessionId === next.sessionId
        && prev.onToggle === next.onToggle
        && prev.nested === next.nested
        && prev.hideSingleToolChildren === next.hideSingleToolChildren
        && prev.reveal === next.reveal
        && prev.onRevealLayout === next.onRevealLayout
        && prev.revealRoot === next.revealRoot
        && areMessagesEqual(prev.group.messages, next.group.messages);
}

export const ToolGroupView = React.memo<ToolGroupViewProps>((props) => {
    const { group, metadata, sessionId, expanded, onToggle, nested, hideSingleToolChildren, reveal, onRevealLayout } = props;
    const router = useRouter();
    const ownRootRef = React.useRef<React.ComponentRef<typeof View>>(null);
    const revealRoot = props.revealRoot ?? ownRootRef;
    const summary = React.useMemo(() => generateGroupSummary(group.messages), [group.messages]);
    const summaryCategory = React.useMemo(() => getGroupSummaryCategory(group.messages), [group.messages]);
    // A lone tool folds into its header row — unless it still needs the user:
    // a pending approval (its own or a nested subagent's) or an open question
    // keeps the full card and its controls visible.
    const singleCandidate = hideSingleToolChildren && group.messages.length === 1 && group.messages[0]?.kind === 'tool-call'
        ? group.messages[0]
        : null;
    const singleNeedsInteraction = singleCandidate !== null
        && (hasPendingPermission([singleCandidate]) || singleCandidate.tool.name === 'AskUserQuestion');
    const suppressChildren = singleCandidate !== null && !singleNeedsInteraction;
    const singleToolMessage = suppressChildren ? singleCandidate : null;
    const handleToggle = React.useCallback(() => {
        onToggle(group.id);
    }, [onToggle, group.id]);
    const handleSingleToolPress = React.useCallback(() => {
        if (!singleToolMessage) {
            onToggle(group.id);
            return;
        }
        const filePath = isFileEditTool(singleToolMessage.tool.name) && typeof singleToolMessage.tool.input?.file_path === 'string'
            ? singleToolMessage.tool.input.file_path
            : null;
        if (filePath) {
            router.push(`/session/${sessionId}/file?path=${encodePathParam(filePath)}`);
            return;
        }
        router.push(`/session/${sessionId}/message/${singleToolMessage.id}`);
    }, [onToggle, group.id, router, sessionId, singleToolMessage]);
    const renderGroupMessage = React.useCallback((msg: Message) => {
        const row = (
            <ToolGroupMessageRow
                key={msg.id}
                message={msg}
                metadata={metadata}
                sessionId={sessionId}
            />
        );
        if (reveal && reveal.messageId === msg.id) {
            return (
                <RevealAnchor key={msg.id} target={reveal} root={revealRoot} onLayout={onRevealLayout}>
                    {row}
                </RevealAnchor>
            );
        }
        return row;
    }, [metadata, sessionId, reveal, revealRoot, onRevealLayout]);

    const header = (
        <CollapseHeader
            expanded={expanded}
            hasRunning={group.hasRunning}
            label={summary}
            onPress={singleToolMessage ? handleSingleToolPress : handleToggle}
            category={summaryCategory}
            showChevron
        />
    );
    // A lone tool folded into its header IS the hit's rendering.
    const revealHeader = reveal != null && singleToolMessage !== null && reveal.messageId === singleToolMessage.id;

    const body = (
        <View style={nested ? styles.nestedInnerContainer : styles.innerContainer}>
            {revealHeader ? (
                <RevealAnchor target={reveal} root={revealRoot} onLayout={onRevealLayout}>
                    {header}
                </RevealAnchor>
            ) : header}
            {expanded && !suppressChildren && (
                <View style={styles.content}>
                    {group.messages.map(renderGroupMessage)}
                </View>
            )}
        </View>
    );

    if (nested) {
        return (
            <View style={styles.nestedOuterContainer}>
                {body}
            </View>
        );
    }

    return (
        <View style={styles.outerContainer} ref={ownRootRef} collapsable={false}>
            {body}
        </View>
    );
}, areToolGroupPropsEqual);

interface AgentWorkGroupViewProps extends RevealProps {
    group: AgentWorkGroupItem;
    metadata: Metadata | null;
    sessionId: string;
    expanded: boolean;
    // Called with the group's id — see ToolGroupViewProps.onToggle.
    onToggle: (id: string) => void;
}

// Covers every rendered input: id, expanded, hasRunning (header spinner),
// hasPendingPermission (derived flag, compared defensively), startedAt /
// completedAt (duration label + elapsed timer), the message array element-wise
// (nested grouping derives from it), plus metadata / sessionId / onToggle.
function areAgentWorkGroupPropsEqual(prev: AgentWorkGroupViewProps, next: AgentWorkGroupViewProps): boolean {
    return prev.group.id === next.group.id
        && prev.expanded === next.expanded
        && prev.group.hasRunning === next.group.hasRunning
        && prev.group.hasPendingPermission === next.group.hasPendingPermission
        && prev.group.startedAt === next.group.startedAt
        && prev.group.completedAt === next.group.completedAt
        && prev.metadata === next.metadata
        && prev.sessionId === next.sessionId
        && prev.onToggle === next.onToggle
        && prev.reveal === next.reveal
        && prev.onRevealLayout === next.onRevealLayout
        && areMessagesEqual(prev.group.messages, next.group.messages);
}

export const AgentWorkGroupView = React.memo<AgentWorkGroupViewProps>((props) => {
    const { group, metadata, sessionId, expanded, onToggle, reveal, onRevealLayout } = props;
    const rootRef = React.useRef<React.ComponentRef<typeof View>>(null);
    const runningElapsedSeconds = useElapsedTime(group.completedAt === null ? group.startedAt : null);
    const durationMs = group.completedAt === null
        ? runningElapsedSeconds * 1000
        : group.completedAt - group.startedAt;
    const label = t('toolGroup.workedFor', { duration: formatWorkDuration(durationMs) });
    const nestedItemsNewestFirst = React.useMemo(
        () => groupToolCallsForDisplay(group.messages, true, { groupSingleToolCalls: true }),
        [group.messages],
    );
    const nestedItems = React.useMemo(
        () => [...nestedItemsNewestFirst].reverse(),
        [nestedItemsNewestFirst],
    );

    // Nested groups start collapsed (unless awaiting approval) the FIRST time
    // they appear; after that the user's toggles win. Re-seeding on every
    // message update snapped manually expanded groups shut on each late tool
    // result, so only never-seen group ids are touched here.
    const seenToolGroupsRef = React.useRef<Set<string>>(new Set());
    const manuallyToggledToolGroupsRef = React.useRef<Set<string>>(new Set());
    const [collapsedToolGroups, setCollapsedToolGroups] = React.useState<Set<string>>(() => {
        const initial = new Set<string>();
        for (const item of nestedItemsNewestFirst) {
            if (item.type === 'tool-group') {
                seenToolGroupsRef.current.add(item.id);
                if (!item.hasPendingPermission) initial.add(item.id);
            }
        }
        return initial;
    });

    React.useEffect(() => {
        setCollapsedToolGroups((prev) => {
            let changed = false;
            const next = new Set(prev);
            for (const item of nestedItemsNewestFirst) {
                if (item.type !== 'tool-group') {
                    continue;
                }
                const manual = manuallyToggledToolGroupsRef.current.has(item.id);
                if (!seenToolGroupsRef.current.has(item.id)) {
                    seenToolGroupsRef.current.add(item.id);
                    if (!item.hasPendingPermission && !next.has(item.id)) {
                        next.add(item.id);
                        changed = true;
                    }
                    continue;
                }
                // A group that newly needs the user opens even if it was seen
                // — but never overrides a deliberate collapse.
                if (item.hasPendingPermission && next.has(item.id) && !manual) {
                    next.delete(item.id);
                    changed = true;
                }
            }
            return changed ? next : prev;
        });
    }, [nestedItemsNewestFirst]);

    // A search reveal (#203) opens the nested group holding the target, just
    // as ChatList opens this row: the outer expansion alone left a hit inside
    // an independently collapsed nested group hidden. Declared AFTER the
    // seeding effect above so a never-seen group's initial collapse is undone
    // in the same commit. Reads the nested items through a ref so only a new
    // reveal reopens — a later toggle by the user is respected.
    const nestedItemsRef = React.useRef(nestedItemsNewestFirst);
    nestedItemsRef.current = nestedItemsNewestFirst;
    React.useEffect(() => {
        if (!reveal) return;
        const groupId = nestedGroupContaining(nestedItemsRef.current, reveal.messageId);
        if (!groupId) return;
        manuallyToggledToolGroupsRef.current.delete(groupId); // a search reveal is not a manual toggle
        setCollapsedToolGroups((prev) => {
            if (!prev.has(groupId)) return prev;
            const next = new Set(prev);
            next.delete(groupId);
            return next;
        });
    }, [reveal]);

    const handleToggleNestedGroup = React.useCallback((groupId: string) => {
        manuallyToggledToolGroupsRef.current.add(groupId);
        setCollapsedToolGroups((prev) => {
            const next = new Set(prev);
            if (next.has(groupId)) {
                next.delete(groupId);
            } else {
                next.add(groupId);
            }
            return next;
        });
    }, []);

    const handleToggle = React.useCallback(() => {
        onToggle(group.id);
    }, [onToggle, group.id]);

    const renderNestedItem = React.useCallback((item: ToolDisplayItem) => {
        if (item.type === 'tool-group') {
            const nestedReveal = reveal && item.messages.some((m) => m.id === reveal.messageId) ? reveal : null;
            return (
                <ToolGroupView
                    key={item.id}
                    group={item}
                    metadata={metadata}
                    sessionId={sessionId}
                    expanded={!collapsedToolGroups.has(item.id)}
                    onToggle={handleToggleNestedGroup}
                    nested
                    hideSingleToolChildren
                    reveal={nestedReveal}
                    onRevealLayout={onRevealLayout}
                    revealRoot={rootRef}
                />
            );
        }
        const message = (
            <MessageView
                key={item.id}
                message={item.message}
                metadata={metadata}
                sessionId={sessionId}
            />
        );
        if (reveal && reveal.messageId === item.message.id) {
            return (
                <RevealAnchor key={item.id} target={reveal} root={rootRef} onLayout={onRevealLayout}>
                    {message}
                </RevealAnchor>
            );
        }
        return message;
    }, [collapsedToolGroups, handleToggleNestedGroup, metadata, sessionId, reveal, onRevealLayout]);

    return (
        <View style={styles.outerContainer} ref={rootRef} collapsable={false}>
            <View style={styles.innerContainer}>
                <CollapseHeader
                    expanded={expanded}
                    hasRunning={group.hasRunning}
                    label={label}
                    onPress={handleToggle}
                />
                {expanded && (
                    <View style={styles.content}>
                        {nestedItems.map(renderNestedItem)}
                    </View>
                )}
            </View>
        </View>
    );
}, areAgentWorkGroupPropsEqual);

function CollapseHeader(props: {
    expanded: boolean;
    hasRunning: boolean;
    label: string;
    onPress: () => void;
    category?: ToolSummaryCategory | null;
    showChevron?: boolean;
    disabled?: boolean;
}) {
    const { theme } = useUnistyles();
    const showChevron = props.showChevron ?? true;
    const content = (
        <>
            {props.category ? (
                <View style={styles.headerIcon}>
                    <ToolSummaryIcon category={props.category} color={theme.colors.textSecondary} />
                </View>
            ) : null}
            <Text style={styles.summaryText} numberOfLines={1}>
                {props.label}
            </Text>
            {props.hasRunning && (
                <ActivityIndicator
                    size="small"
                    color={theme.colors.textSecondary}
                    style={{ transform: [{ scaleX: 0.7 }, { scaleY: 0.7 }] }}
                />
            )}
            {showChevron ? (
                <Ionicons
                    name={props.expanded ? 'chevron-down' : 'chevron-forward'}
                    size={13}
                    color={theme.colors.textSecondary}
                />
            ) : null}
        </>
    );

    if (props.disabled) {
        return (
            <View style={styles.header}>
                {content}
            </View>
        );
    }

    return (
        <Pressable
            onPress={props.onPress}
            style={({ pressed }) => [
                styles.header,
                pressed && styles.headerPressed,
            ]}
        >
            {content}
        </Pressable>
    );
}

function ToolGroupMessageRow(props: {
    message: Message;
    metadata: Metadata | null;
    sessionId: string;
}) {
    if (props.message.kind !== 'tool-call') {
        return (
            <MessageView
                message={props.message}
                metadata={props.metadata}
                sessionId={props.sessionId}
            />
        );
    }

    const shouldRenderFullTool = props.message.tool.permission?.status === 'pending'
        || props.message.tool.name === 'AskUserQuestion';
    if (shouldRenderFullTool) {
        return (
            <MessageView
                message={props.message}
                metadata={props.metadata}
                sessionId={props.sessionId}
            />
        );
    }

    return (
        <ToolSummaryRow
            message={props.message}
            sessionId={props.sessionId}
        />
    );
}

function ToolSummaryRow(props: {
    message: ToolCallMessage;
    sessionId: string;
}) {
    const { theme } = useUnistyles();
    const router = useRouter();
    const { tool } = props.message;
    const category = getToolSummaryCategory(tool.name);
    const detail = getToolSummaryDetail(tool);
    const title = getToolRowTitle(category, tool.name);
    const filePath = isFileEditTool(tool.name) && typeof tool.input?.file_path === 'string'
        ? tool.input.file_path
        : null;
    const isPressable = Boolean(props.sessionId);
    const handlePress = React.useCallback(() => {
        if (filePath) {
            router.push(`/session/${props.sessionId}/file?path=${encodePathParam(filePath)}`);
            return;
        }
        router.push(`/session/${props.sessionId}/message/${props.message.id}`);
    }, [filePath, props.message.id, props.sessionId, router]);

    const content = (
        <>
            <View style={styles.toolSummaryIcon}>
                <ToolSummaryIcon category={category} color={theme.colors.textSecondary} />
            </View>
            <Text style={styles.toolSummaryTitle} numberOfLines={1}>
                {title}
            </Text>
            {detail ? (
                <View style={styles.toolSummaryDetailPill}>
                    <Text style={styles.toolSummaryDetailText} numberOfLines={1}>
                        {detail}
                    </Text>
                </View>
            ) : null}
        </>
    );

    if (!isPressable) {
        return (
            <View style={styles.toolSummaryRow}>
                {content}
            </View>
        );
    }

    return (
        <Pressable
            onPress={handlePress}
            style={({ pressed }) => [
                styles.toolSummaryRow,
                pressed && styles.toolSummaryRowPressed,
            ]}
        >
            {content}
        </Pressable>
    );
}

function ToolSummaryIcon(props: {
    category: ToolSummaryCategory;
    color: string;
}) {
    switch (props.category) {
        case 'terminal':
            return <Octicons name="terminal" size={12} color={props.color} />;
        case 'edit':
            return <Octicons name="file-diff" size={12} color={props.color} />;
        case 'read':
            return <Octicons name="eye" size={12} color={props.color} />;
        case 'search':
            return <Octicons name="search" size={12} color={props.color} />;
        case 'web':
            return <Ionicons name="globe-outline" size={13} color={props.color} />;
        case 'task':
            return <Octicons name="rocket" size={12} color={props.color} />;
        default:
            return <Ionicons name="construct-outline" size={13} color={props.color} />;
    }
}

function getGroupSummaryCategory(messages: Message[]): ToolSummaryCategory | null {
    const categories = new Set<ToolSummaryCategory>();
    for (const message of messages) {
        if (message.kind === 'tool-call') {
            categories.add(getToolSummaryCategory(message.tool.name));
        }
    }
    if (categories.size === 1) {
        return categories.values().next().value ?? null;
    }
    return categories.size > 1 ? 'other' : null;
}

function getToolRowTitle(category: ToolSummaryCategory, toolName: string): string {
    if (toolName.startsWith('mcp__')) {
        return formatMCPTitle(toolName);
    }

    switch (category) {
        case 'terminal':
            return t('tools.names.terminal');
        case 'edit':
            return t('toolGroup.editedFile');
        case 'read':
            return t('tools.names.readFile');
        case 'search':
            return t('tools.names.search');
        case 'web':
            return t('tools.names.fetchUrl');
        case 'task':
            return t('tools.names.task');
        default:
            return toolName;
    }
}

function isFileEditTool(toolName: string): boolean {
    return toolName === 'Edit' || toolName === 'MultiEdit' || toolName === 'Write';
}

const styles = StyleSheet.create((theme) => ({
    outerContainer: {
        flexDirection: 'row',
        justifyContent: 'center',
    },
    innerContainer: {
        flexGrow: 1,
        flexBasis: 0,
        minWidth: 0,
        maxWidth: layout.maxWidth,
        marginVertical: 6,
        overflow: 'hidden',
    },
    nestedOuterContainer: {
        overflow: 'hidden',
    },
    nestedInnerContainer: {
        minWidth: 0,
        overflow: 'hidden',
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        alignSelf: 'stretch',
        marginHorizontal: 16,
        minHeight: 24,
        paddingVertical: 2,
        borderRadius: 4,
    },
    headerPressed: {
        opacity: 0.6,
    },
    headerIcon: {
        width: 14,
        height: 18,
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
    },
    summaryText: {
        flexShrink: 1,
        minWidth: 0,
        fontSize: 13,
        lineHeight: 20,
        color: theme.colors.textSecondary,
    },
    content: {
        marginTop: 2,
        gap: 2,
    },
    toolSummaryRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        minHeight: 24,
        marginHorizontal: 16,
        paddingVertical: 2,
        borderRadius: 4,
        overflow: 'hidden',
    },
    toolSummaryRowPressed: {
        opacity: 0.65,
    },
    toolSummaryIcon: {
        width: 14,
        height: 18,
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
    },
    toolSummaryTitle: {
        flexShrink: 0,
        fontSize: 13,
        lineHeight: 18,
        color: theme.colors.textSecondary,
    },
    toolSummaryDetailPill: {
        flexShrink: 1,
        minWidth: 0,
        maxWidth: '100%',
        borderRadius: 3,
        paddingHorizontal: 4,
        paddingVertical: 1,
        backgroundColor: theme.colors.surfaceHighest,
    },
    toolSummaryDetailText: {
        fontSize: 12,
        lineHeight: 16,
        color: theme.colors.textSecondary,
        fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
    },
}));
