import { AgentContentView } from '@/components/AgentContentView';
import { AgentInput } from '@/components/AgentInput';
import type { MultiTextInputHandle } from '@/components/MultiTextInput';
import { layout } from '@/components/layout';
import {
    getAvailableModels,
    getAvailablePermissionModes,
    getEffortLevelsForModel,
    resolveCurrentOption,
    EffortLevel,
} from '@/components/modelModeOptions';
import { getSuggestions } from '@/components/autocomplete/suggestions';
import { ChatHeaderView } from '@/components/ChatHeaderView';
import { ChatList, type ChatListHandle } from '@/components/ChatList';
import { SessionSearchBar } from './SessionSearchBar';
import { Deferred } from '@/components/Deferred';
import { EmptyMessages } from '@/components/EmptyMessages';
import { VoiceAssistantStatusBar } from '@/components/VoiceAssistantStatusBar';
import { useDraft } from '@/hooks/useDraft';
import { useToolsCollapsed } from '@/hooks/useToolsCollapsed';
import { MachineResourceBanner } from '@/components/MachineResourceBanner';
import { useDrawingResult } from '@/hooks/useDrawingResult';
import { useEscapeAbort } from '@/hooks/useEscapeAbort';
import { useImagePicker } from '@/hooks/useImagePicker';
import { Modal } from '@/modal';
import { voiceHooks } from '@/realtime/hooks/voiceHooks';
import { getCurrentVoiceConversationId, getCurrentVoiceSessionDurationSeconds, startRealtimeSession, stopRealtimeSession } from '@/realtime/RealtimeSession';
import { gitStatusSync } from '@/sync/gitStatusSync';
import { sessionAbort } from '@/sync/ops';
import { storage, useIsDataReady, useLocalSetting, useRealtimeStatus, useSessionMessages, useSessionUsage, useSetting } from '@/sync/storage';
import { useSession } from '@/sync/storage';
import { Session, isJoyDaemonSource } from '@/sync/storageTypes';
import { sync } from '@/sync/sync';
import { t } from '@/text';
import { getVoiceMessageCount, getVoiceOnboardingPromptLoadCount } from '@/sync/persistence';
import { isRunningOnMac } from '@/utils/platform';
import { useDeviceType, useHeaderHeight, useIsLandscape, useIsTablet } from '@/utils/responsive';
import { FilesSidebar, SidebarMode } from '@/components/FilesSidebar';
import { AllFilesDiffView } from '@/components/AllFilesDiffView';
import { FileViewPanel } from '@/components/FileViewPanel';
import { prefetchPierreDiff } from '@/components/diff/PierreDiffView';
import { GitFileStatus } from '@/sync/gitStatusFiles';
import { useOverlayNav } from '@/-session/sessionOverlayNav';
import { formatPathRelativeToHome, getResumeCommandBlock, getSessionName, useSessionStatus } from '@/utils/sessionUtils';
import { useSessionQuickActions } from '@/hooks/useSessionQuickActions';
import { isVersionSupported, MINIMUM_CLI_VERSION } from '@/utils/versionUtils';
import * as Clipboard from 'expo-clipboard';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';
import * as React from 'react';
import { useMemo } from 'react';
import { ActivityIndicator, Platform, Pressable, Text, View, useWindowDimensions } from 'react-native';
import Animated, { useSharedValue, useAnimatedStyle, withTiming, Easing } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useActiveInterval } from '@/hooks/useActiveInterval';
import { useUnistyles } from 'react-native-unistyles';
import type { ModelMode, PermissionMode } from '@/components/PermissionModeSelector';
import { resolveAgentDefaultConfig } from '@/sync/agentDefaults';
import { JOY_CLAUDE_MODELS, JOY_CLAUDE_PERMISSION_MODES, JOY_CODEX_PERMISSION_MODES } from '@/sync/joyModels';
import { apiSocket } from '@/sync/apiSocket';
import { useJoyQueue } from '@/hooks/useJoyQueue';
import { useSessionMessageBackstop } from '@/hooks/useSessionMessageBackstop';
import { JoyQueueStrip } from '@/components/JoyQueueStrip';
import { DraftQueueStrip } from './DraftQueueStrip';
import { PendingQueueStrip } from './PendingQueueStrip';
import { DisconnectedBanner } from './DisconnectedBanner';
import { GoalBar } from './GoalBar';
import { LoginBar } from './LoginBar';
import { DialogBar } from './DialogBar';
import { CodexApprovalBar } from './CodexApprovalBar';
import { useDraftQueueStore } from './draftQueue';
import { isFresh } from '@/sync/storage';

// Slash commands that execute IMMEDIATELY mid-turn and therefore bypass the
// app-side queue hold. Sources: official docs confirm /model and /effort
// "switch immediately" mid-turn (model-config.md) and /btw runs while Claude
// works (interactive-mode.md); the CLI binary's `immediate` set covers the
// local-UI commands; /compact and /clear are boundary-only per docs — they
// HOLD. Plus joy's daemon-intercepted commands (steer/title/login-code),
// whose whole point is mid-turn delivery.
const IMMEDIATE_COMMANDS = new Set([
    'model', 'effort',
    'btw', 'goal', 'stop', 'mcp', 'skills', 'hooks', 'loops', 'color',
    'doctor', 'version', 'focus', 'brief', 'daemon',
    'steer', 'title', 'login-code',
]);

export const SessionView = React.memo((props: { id: string }) => {
    const sessionId = props.id;
    const router = useRouter();
    const session = useSession(sessionId);
    const isDataReady = useIsDataReady();
    const { theme } = useUnistyles();
    const safeArea = useSafeAreaInsets();
    const isLandscape = useIsLandscape();
    const deviceType = useDeviceType();
    const headerHeight = useHeaderHeight();
    const realtimeStatus = useRealtimeStatus();
    const isTablet = useIsTablet();
    const { width: windowWidth } = useWindowDimensions();
    const fileDiffsSidebarEnabled = useSetting('fileDiffsSidebar');
    const zenMode = useLocalSetting('zenMode');

    // Escape key exits zen mode (web only)
    React.useEffect(() => {
        if (Platform.OS !== 'web' || !zenMode) return;
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                storage.getState().applyLocalSettings({ zenMode: false });
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [zenMode]);

    // Base condition: can we show the diff sidebar at all?
    const canShowSidebar = fileDiffsSidebarEnabled
        && (isRunningOnMac() || Platform.OS === 'web')
        && windowWidth >= SIDEBAR_MIN_WINDOW_WIDTH
        && isDataReady && !!session;

    const showSidebar = canShowSidebar && !zenMode;

    // Match left sidebar width: 30% of window, clamped to 250–360px
    const sidebarWidth = Math.min(Math.max(Math.floor(windowWidth * 0.3), 250), 360);

    // Animate diff sidebar width.
    //
    // On web we snap the value (duration: 0). The animated `width` change
    // triggers a flex-row reflow on every frame, which in turn re-measures
    // the entire chat tree (FlatList rows, message blocks). At ~60fps that
    // grinds to ~15fps on dev builds. Snapping skips the layout thrash —
    // the chat reflows once instead of 60 times. Native keeps the smooth
    // animation because it runs on Reanimated's UI thread.
    const sidebarAnim = useSharedValue(showSidebar ? 1 : 0);
    React.useEffect(() => {
        sidebarAnim.value = withTiming(showSidebar ? 1 : 0, {
            duration: Platform.OS === 'web' ? 0 : 250,
            easing: Easing.out(Easing.cubic),
        });
    }, [showSidebar]);
    const animatedSidebarStyle = useAnimatedStyle(() => ({
        width: sidebarAnim.value * sidebarWidth,
        opacity: sidebarAnim.value,
        overflow: 'hidden' as const,
    }));

    const [sidebarMode, setSidebarMode] = React.useState<SidebarMode>('changes');

    // Overlay state is managed as a browser-style history stack so the
    // sidebar's back / forward arrows can navigate between chat ↔ diff ↔ file
    // without a per-overlay close button. Stack + cursor live in one piece
    // of state so functional updates stay coordinated.
    type OverlayEntry =
        | { kind: 'none' }
        | { kind: 'diff'; file: string }
        | { kind: 'file'; path: string };
    const [overlayHistory, setOverlayHistory] = React.useState<{ stack: OverlayEntry[]; cursor: number }>(
        { stack: [{ kind: 'none' }], cursor: 0 }
    );
    const overlayCurrent = overlayHistory.stack[overlayHistory.cursor] ?? { kind: 'none' };
    const diffViewOpen = overlayCurrent.kind === 'diff';
    const fileViewPath = overlayCurrent.kind === 'file' ? overlayCurrent.path : null;
    const scrollToFile = overlayCurrent.kind === 'diff' ? overlayCurrent.file : null;

    const pushOverlay = React.useCallback((entry: OverlayEntry) => {
        setOverlayHistory((prev) => {
            const truncated = prev.stack.slice(0, prev.cursor + 1);
            truncated.push(entry);
            return { stack: truncated, cursor: truncated.length - 1 };
        });
    }, []);

    const handleSidebarFilePress = React.useCallback((file: GitFileStatus) => {
        if (file.status === 'deleted') return;
        pushOverlay({ kind: 'diff', file: file.fullPath });
    }, [pushOverlay]);
    const handleAllFilesFilePress = React.useCallback((filePath: string) => {
        pushOverlay({ kind: 'file', path: filePath });
    }, [pushOverlay]);

    // When sidebar capability is lost (screen too narrow, disabled), close views.
    // Don't close on zen mode toggle — keep the view visible.
    React.useEffect(() => {
        if (!canShowSidebar) {
            setOverlayHistory({ stack: [{ kind: 'none' }], cursor: 0 });
        }
    }, [canShowSidebar]);

    // Right-side header content published by the active overlay (diff toggle / save button).
    const [headerRightSlot, setHeaderRightSlot] = React.useState<React.ReactNode>(null);

    // Wire intra-session back / forward into the global SidebarNavigator arrows.
    const canOverlayBack = overlayHistory.cursor > 0;
    const canOverlayForward = overlayHistory.cursor < overlayHistory.stack.length - 1;
    React.useEffect(() => {
        useOverlayNav.getState().publish({
            canBack: canOverlayBack,
            canForward: canOverlayForward,
            back: () => {
                if (!canOverlayBack) return false;
                setOverlayHistory((prev) => (
                    prev.cursor <= 0 ? prev : { ...prev, cursor: prev.cursor - 1 }
                ));
                return true;
            },
            forward: () => {
                if (!canOverlayForward) return false;
                setOverlayHistory((prev) => (
                    prev.cursor >= prev.stack.length - 1 ? prev : { ...prev, cursor: prev.cursor + 1 }
                ));
                return true;
            },
        });
        return () => useOverlayNav.getState().reset();
    }, [canOverlayBack, canOverlayForward]);

    // Warm Pierre's lazy web chunks while the user is still reading chat.
    React.useEffect(() => {
        prefetchPierreDiff();
    }, []);

    // Compute header props based on session state
    const headerProps = useMemo(() => {
        if (!isDataReady) {
            return { title: '', folderName: undefined, isConnected: false };
        }
        if (!session) {
            return { title: t('errors.sessionDeleted'), folderName: undefined, isConnected: false };
        }
        const isConnected = session.presence === 'online';
        const pathSegments = session.metadata?.path?.split(/[/\\]/).filter(Boolean);
        const folderName = pathSegments?.[pathSegments.length - 1];
        const sessionName = getSessionName(session);
        return {
            title: sessionName,
            folderName,
            isConnected,
            // No joy badge: every session is joy-tmux, so the indicator is
            // redundant (the terminal shortcut in the header already signals it).
            badge: undefined,
        };
    }, [session, isDataReady]);

    // joy-tmux sessions: header shortcut to the interactive tmux pane
    // (/joy/pane) for raw intervention — trust prompts, TUI menus, etc.
    // Top-left collapse/expand-all-tool-calls toggle (task: reduce scrollback
    // noise in one tap). State lives in the useToolsCollapsed store; every
    // ToolView subscribes.
    const toolsCollapsed = useToolsCollapsed((s) => s.collapsed);
    const collapseAllSlot = React.useMemo(() => (
        <Pressable
            onPress={() => useToolsCollapsed.getState().toggle()}
            hitSlop={10}
            style={{ paddingHorizontal: 4 }}
            accessibilityRole="button"
            accessibilityLabel={toolsCollapsed ? 'Expand all tool calls' : 'Collapse all tool calls'}
        >
            <Ionicons
                name={toolsCollapsed ? 'chevron-expand-outline' : 'chevron-collapse-outline'}
                size={19}
                color={theme.colors.header.tint}
            />
        </Pressable>
    ), [toolsCollapsed, theme]);

    const joyTerminalSlot = React.useMemo(() => {
        const joyId = session?.metadata?.joy__sessionId;
        const joyMachine = session?.metadata?.machineId;
        if (!isJoyDaemonSource(session?.metadata?.joy__source) || !joyId || !joyMachine) return null;
        return (
            <Pressable
                onPress={() => router.push(`/joy/pane/${encodeURIComponent(joyMachine)}/${encodeURIComponent(joyId)}`)}
                hitSlop={10}
                style={{ paddingHorizontal: 4 }}
            >
                <Ionicons name="terminal-outline" size={20} color={theme.colors.header.tint} />
            </Pressable>
        );
    }, [session?.metadata?.joy__source, session?.metadata?.joy__sessionId, session?.metadata?.machineId, router, theme]);

    const mainContent = (
        <>
            {/* Status bar shadow for landscape mode */}
            {isLandscape && deviceType === 'phone' && (
                <View style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    right: 0,
                    height: safeArea.top,
                    backgroundColor: theme.colors.surface,
                    zIndex: 1000,
                    shadowColor: theme.colors.shadow.color,
                    shadowOffset: {
                        width: 0,
                        height: 2,
                    },
                    shadowOpacity: theme.colors.shadow.opacity,
                    shadowRadius: 3,
                    elevation: 5,
                }} />
            )}

            {/* Header - always shown on desktop/Mac, hidden in landscape mode only on actual phones */}
            {!(isLandscape && deviceType === 'phone' && Platform.OS !== 'web') && (
                <View style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    right: 0,
                    zIndex: 1000
                }}>
                    <ChatHeaderView
                        title={headerProps.title}
                        folderName={headerProps.folderName}
                        isConnected={headerProps.isConnected}
                        badge={headerProps.badge}
                        extraPathSegment={fileViewPath ?? undefined}
                        rightSlot={(diffViewOpen || !!fileViewPath) ? headerRightSlot : <>{collapseAllSlot}{joyTerminalSlot}</>}
                        onTitlePress={session ? () => router.push(`/session/${sessionId}/info`) : undefined}
                        onBackPress={() => router.back()}
                    />
                    {/* Voice status bar below header - not on tablet (shown in sidebar) */}
                    {!isTablet && realtimeStatus !== 'disconnected' && (
                        <VoiceAssistantStatusBar variant="full" />
                    )}
                    <MachineResourceBanner machineId={session?.metadata?.machineId} />
                </View>
            )}

            {/* Content based on state */}
            <View style={{ flex: 1, paddingTop: !(isLandscape && deviceType === 'phone' && Platform.OS !== 'web') ? safeArea.top + headerHeight + (!isTablet && realtimeStatus !== 'disconnected' ? 32 : 0) : 0 }}>
                {!isDataReady ? (
                    <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
                        <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                    </View>
                ) : !session ? (
                    <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
                        <Ionicons name="trash-outline" size={48} color={theme.colors.textSecondary} />
                        <Text style={{ color: theme.colors.text, fontSize: 20, marginTop: 16, fontWeight: '600' }}>{t('errors.sessionDeleted')}</Text>
                        <Text style={{ color: theme.colors.textSecondary, fontSize: 15, marginTop: 8, textAlign: 'center', paddingHorizontal: 32 }}>{t('errors.sessionDeletedDescription')}</Text>
                    </View>
                ) : (
                    <SessionViewLoaded key={sessionId} sessionId={sessionId} session={session} />
                )}
            </View>
        </>
    );

    if (!canShowSidebar) {
        return mainContent;
    }

    // Desktop layout: chat + animated sidebar at the same level (full height).
    // When a sidebar file is selected, InlineFileDiff overlays the main content
    // (chat stays mounted underneath so state is preserved).
    return (
        <View style={{ flex: 1, flexDirection: 'row' }}>
            <View
                style={{
                    flex: 1,
                    // Web-only: isolate the chat subtree's layout from the
                    // parent flex-row. If we ever bring back a width
                    // animation on the right sidebar, `contain` prevents
                    // layout work from leaking up to the chat tree on
                    // every frame.
                    ...(Platform.OS === 'web' ? { contain: 'layout style paint' as any } : {}),
                }}
            >
                {mainContent}
                {diffViewOpen && canShowSidebar && (
                    <View
                        pointerEvents="box-none"
                        style={{
                            position: 'absolute',
                            top: safeArea.top + headerHeight,
                            left: 0,
                            right: 0,
                            bottom: 0,
                            backgroundColor: theme.colors.surface,
                        }}
                    >
                        <AllFilesDiffView
                            sessionId={sessionId}
                            scrollToFile={scrollToFile}
                            onlyFile={scrollToFile}
                            onHeaderRightSlotChange={setHeaderRightSlot}
                        />
                    </View>
                )}
                {fileViewPath && canShowSidebar && (
                    <View
                        pointerEvents="box-none"
                        style={{
                            position: 'absolute',
                            top: safeArea.top + headerHeight,
                            left: 0,
                            right: 0,
                            bottom: 0,
                            backgroundColor: theme.colors.surface,
                        }}
                    >
                        <FileViewPanel
                            sessionId={sessionId}
                            filePath={fileViewPath}
                            onHeaderRightSlotChange={setHeaderRightSlot}
                        />
                    </View>
                )}
            </View>
            <Animated.View style={[{ minWidth: 0, alignSelf: 'stretch' }, animatedSidebarStyle]}>
                <View style={{ width: sidebarWidth, flex: 1 }}>
                    <FilesSidebar
                        sessionId={sessionId}
                        selectedPath={sidebarMode === 'changes' ? scrollToFile : fileViewPath}
                        onFilePress={handleSidebarFilePress}
                        mode={sidebarMode}
                        onModeChange={setSidebarMode}
                        onAllFilesFilePress={handleAllFilesFilePress}
                    />
                </View>
            </Animated.View>
        </View>
    );
});

const SIDEBAR_MIN_WINDOW_WIDTH = 1100;

// Hoisted so AgentInput's React.memo doesn't see a new array ref on every keystroke
const AGENT_INPUT_AUTOCOMPLETE_PREFIXES = ['@', '/'];

// Imperative handle exposed by ChatComposer so SessionViewLoaded can read /
// clear the message text without subscribing to it (which would re-render
// the whole loaded screen on every keystroke).
type ChatComposerHandle = {
    getMessage: () => string;
    clearMessage: () => void;
};

type ChatComposerProps = Omit<
    React.ComponentProps<typeof AgentInput>,
    'initialValue' | 'onChangeText'
> & {
    sessionId: string;
    composerHandleRef: React.RefObject<ChatComposerHandle | null>;
};

// Owns the chat-message draft autosave. The textarea itself is uncontrolled:
// keystrokes never round-trip through React state, so the parent can stay
// stable on every keystroke and deletion doesn't batch on a busy main thread.
// `message` here is a low-priority mirror updated via startTransition; it's
// only used to feed useDraft's debounced autosave. Reads/clears on send go
// through the MultiTextInput handle imperatively.
const ChatComposer = React.memo(function ChatComposer(props: ChatComposerProps) {
    const { sessionId, composerHandleRef, ...rest } = props;
    // Synchronously hydrate the textarea with any saved draft so the user sees
    // their work-in-progress on session open without an extra round-trip.
    const initialDraft = React.useMemo(() => {
        return storage.getState().sessions[sessionId]?.draft ?? '';
    }, [sessionId]);
    const inputHandleRef = React.useRef<MultiTextInputHandle>(null);
    const [message, setMessage] = React.useState(initialDraft);

    const applyDraft = React.useCallback((text: string) => {
        inputHandleRef.current?.setTextAndSelection(text, { start: text.length, end: text.length });
        setMessage(text);
    }, []);

    const { clearDraft } = useDraft(sessionId, message, applyDraft);

    const handleChangeText = React.useCallback((text: string) => {
        // Transition keeps the textarea responsive even when the draft
        // autosave / re-render takes longer than a frame.
        React.startTransition(() => setMessage(text));
    }, []);

    React.useImperativeHandle(composerHandleRef, () => ({
        getMessage: () => inputHandleRef.current?.getText() ?? '',
        clearMessage: () => {
            inputHandleRef.current?.setTextAndSelection('', { start: 0, end: 0 });
            setMessage('');
            clearDraft();
        },
    }), [clearDraft]);

    return (
        <AgentInput
            {...rest}
            ref={inputHandleRef}
            sessionId={sessionId}
            initialValue={initialDraft}
            onChangeText={handleChangeText}
        />
    );
});

function SessionViewLoaded({ sessionId, session }: { sessionId: string, session: Session }) {
    const { theme } = useUnistyles();
    const router = useRouter();
    const safeArea = useSafeAreaInsets();
    const isLandscape = useIsLandscape();
    const deviceType = useDeviceType();
    const isTablet = useIsTablet();
    const realtimeStatus = useRealtimeStatus();
    const { messages, isLoaded } = useSessionMessages(sessionId);
    // Newest user-sent message timestamp — drives the backstop's "recently sent"
    // trigger (messages are sorted newest-first, so the first user-text wins).
    const lastUserSentAt = React.useMemo(() => {
        for (const m of messages) {
            if (m.kind === 'user-text') return m.createdAt;
        }
        return null;
    }, [messages]);
    // Repair loop against silently-dropped socket events while watching a live turn.
    useSessionMessageBackstop(sessionId, session.thinking === true, lastUserSentAt);
    const acknowledgedCliVersions = useLocalSetting('acknowledgedCliVersions');
    const zenMode = useLocalSetting('zenMode');
    const headerHeight = useHeaderHeight();
    const sessionInputHorizontalPadding = Platform.OS === 'web' || isRunningOnMac() || isTablet ? 12 : 8;

    // In-session search: Cmd/Ctrl+F opens the search bar (web/desktop). We take
    // over the browser's native find — a chat is virtualized, so the browser's
    // find can't reach rows that aren't mounted; ours searches the loaded model
    // and scrolls to matches. Esc closes it (handled inside the bar too).
    const chatListRef = React.useRef<ChatListHandle>(null);
    const [searchOpen, setSearchOpen] = React.useState(false);
    React.useEffect(() => {
        if (Platform.OS !== 'web') return;
        const handleKeyDown = (e: KeyboardEvent) => {
            if ((e.metaKey || e.ctrlKey) && (e.key === 'f' || e.key === 'F')) {
                e.preventDefault();
                e.stopPropagation();
                setSearchOpen(true);
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, []);

    // Check if CLI version is outdated and not already acknowledged
    const cliVersion = session.metadata?.version;
    const machineId = session.metadata?.machineId;
    const isCliOutdated = cliVersion && !isVersionSupported(cliVersion, MINIMUM_CLI_VERSION);
    const isAcknowledged = machineId && acknowledgedCliVersions[machineId] === cliVersion;
    const shouldShowCliWarning = isCliOutdated && !isAcknowledged;
    const isJoyDaemon = isJoyDaemonSource(session.metadata?.joy__source);
    // joy sessions carry no `flavor` in metadata (just joy__source); they're
    // always Claude, so coerce it so model/effort lookups resolve.
    // joy-tmux sessions carry their agent in metadata.flavor ('codex'); absent
    // → claude (legacy joy-tmux sessions and the claude path send no flavor).
    const flavor = isJoyDaemon ? (session.metadata?.flavor ?? 'claude') : session.metadata?.flavor;
    const joySessionId = session.metadata?.joy__sessionId;
    // Opencode: the daemon's curated allowlist backs the model picker so the
    // chip can CYCLE (codex stays a 1-entry display: its catalog is per-model
    // efforts and switching rides the pane, not an RPC).
    const [ocModels, setOcModels] = React.useState<{ id: string; displayName: string }[]>([]);
    React.useEffect(() => {
        if (flavor !== 'opencode' || !machineId) return;
        let cancelled = false;
        apiSocket.machineRPC<{ ok?: boolean; models?: { id: string; displayName: string }[] }, {}>(machineId, 'joy-opencode-models', {})
            .then((res) => { if (!cancelled && res.models?.length) setOcModels(res.models); })
            .catch(() => { /* old daemon — chip stays display-only */ });
        return () => { cancelled = true; };
    }, [flavor, machineId]);

    const availableModels = React.useMemo(() => {
        if (!isJoyDaemon) return getAvailableModels(flavor, session.metadata, t);
        // Codex models are dynamic slugs (gpt-5.6-sol…), not the claude family
        // catalog — resolving currentModelCode against JOY_CLAUDE_MODELS never
        // matched, so codex sessions showed NO model label (bug 2026-07-31).
        // Synthesize a one-entry catalog from the daemon-published code.
        if (flavor === 'opencode' && ocModels.length) {
            return ocModels.map((m) => ({ key: m.id, name: m.displayName, description: null }));
        }
        if (flavor === 'codex' || flavor === 'opencode') {
            const code = session.metadata?.currentModelCode;
            return code ? [{ key: code, name: code, description: null }] : [];
        }
        return JOY_CLAUDE_MODELS;
    }, [isJoyDaemon, flavor, session.metadata, ocModels]);
    const availableModes = React.useMemo(() => {
        // joy sessions: only the modes interactive claude can actually reach
        // via Shift+Tab, in the terminal's cycle order (so browser Shift+Tab
        // cycling matches). happy's list has dontAsk (unreachable) and lacks
        // auto. CODEX joy sessions use codex's OWN modes — the claude modes
        // (esp. `auto`) silently escalate to full access on codex (finding #1).
        const modes = isJoyDaemon
            ? (flavor === 'codex' ? JOY_CODEX_PERMISSION_MODES
                : flavor === 'opencode' || flavor === 'pi' ? [] // v1: opencode/pi have no permission surface
                : JOY_CLAUDE_PERMISSION_MODES)
            : getAvailablePermissionModes(flavor, session.metadata, t);
        return modes;
    }, [isJoyDaemon, flavor, session.metadata]);
    const agentDefaultOverrides = useSetting('agentDefaultOverrides');
    const effectiveAgentDefaults = React.useMemo(() => (
        resolveAgentDefaultConfig(agentDefaultOverrides, flavor)
    ), [agentDefaultOverrides, flavor]);

    const permissionMode = React.useMemo<PermissionMode | null>(() => (
        resolveCurrentOption(availableModes, [
            session.permissionMode,
            effectiveAgentDefaults.permissionMode,
            session.metadata?.currentOperatingModeCode,
        ])
    ), [availableModes, session.permissionMode, effectiveAgentDefaults.permissionMode, session.metadata?.currentOperatingModeCode]);

    const modelMode = React.useMemo<ModelMode | null>(() => (
        resolveCurrentOption(availableModels, [
            session.modelMode,
            effectiveAgentDefaults.modelMode,
            session.metadata?.currentModelCode,
        ])
    ), [availableModels, session.modelMode, effectiveAgentDefaults.modelMode, session.metadata?.currentModelCode]);

    // Effort level state
    const modelKey = modelMode?.key ?? 'default';
    const availableEffortLevels = React.useMemo<EffortLevel[]>(
        () => getEffortLevelsForModel(flavor, modelKey),
        [flavor, modelKey],
    );
    const effortLevel = React.useMemo<EffortLevel | null>(() => (
        resolveCurrentOption(availableEffortLevels, [
            session.effortLevel,
            effectiveAgentDefaults.effortLevel,
        ])
    ), [availableEffortLevels, session.effortLevel, effectiveAgentDefaults.effortLevel]);

    const sessionStatus = useSessionStatus(session);
    // joy message queue: messages sent while Claude is busy line up here and
    // the daemon drains them one at a time. Only meaningful for joy sessions.
    const joyQueue = useJoyQueue(machineId, joySessionId, session.metadata?.joy__queue);
    const sessionUsage = useSessionUsage(sessionId);
    const alwaysShowContextSize = useSetting('alwaysShowContextSize');
    const expResumeSession = useSetting('expResumeSession');
    const { canResume, resumeSession, resumingSession } = useSessionQuickActions(session);
    const isDisconnected = !sessionStatus.isConnected;
    const resumeCommandBlock = getResumeCommandBlock(session);

    // Image attachment state
    const { selectedImages, pickImages, pickFromLibrary, pasteImage, removeImage, clearImages, addImages } = useImagePicker();

    // Attach menu (native): the Files picker can't browse Photos and RN text
    // inputs drop image pastes, so photos and clipboard images need explicit
    // entries. Web keeps the direct file picker — its file input covers
    // everything and paste is intercepted at the document level.
    const handleAttach = React.useCallback(() => {
        // Draw lives INSIDE the attach sheet (it produces an attachment) —
        // one entry point for everything that ends up as an image.
        const draw = { text: t('imageUpload.draw'), onPress: () => { router.push(`/session/${sessionId}/draw`); } };
        if (Platform.OS === 'web') {
            Modal.alert(t('imageUpload.attachTitle'), undefined, [
                { text: t('imageUpload.chooseFile'), onPress: () => { void pickImages(); } },
                draw,
                { text: t('common.cancel'), style: 'cancel' },
            ]);
            return;
        }
        Modal.alert(t('imageUpload.attachTitle'), undefined, [
            { text: t('imageUpload.photoLibrary'), onPress: () => { void pickFromLibrary(); } },
            { text: t('imageUpload.chooseFile'), onPress: () => { void pickImages(); } },
            { text: t('imageUpload.pasteImage'), onPress: () => { void pasteImage(); } },
            draw,
            { text: t('common.cancel'), style: 'cancel' },
        ]);
    }, [pickImages, pickFromLibrary, pasteImage, router, sessionId]);

    // Estimated session cost for the composer info line: the daemon's
    // joy-session-usage rolls subagent burn into the parent and prices with
    // the real cache-tier table, so ask it rather than re-deriving app-side.
    // Cheap (persistent parse cache daemon-side) but still only every 5 min.
    const [sessionCostUsd, setSessionCostUsd] = React.useState<number | null>(null);
    const costMachineId = session?.metadata?.machineId;
    const costClaudeId = session?.metadata?.claudeSessionId;
    React.useEffect(() => {
        if (!costMachineId || !costClaudeId || !isJoyDaemonSource(session?.metadata?.joy__source)) return;
        let cancelled = false;
        const fetchCost = async () => {
            try {
                const r = await apiSocket.machineRPC<{ ok?: boolean; entry?: { cost?: number } | null }, { period: string; claudeSessionId: string }>(
                    costMachineId, 'joy-session-usage', { period: 'all', claudeSessionId: costClaudeId },
                );
                if (!cancelled && r?.ok && r.entry?.cost != null) setSessionCostUsd(r.entry.cost);
            } catch { /* info line just omits the segment */ }
        };
        void fetchCost();
        const timer = setInterval(() => void fetchCost(), 5 * 60 * 1000);
        return () => { cancelled = true; clearInterval(timer); };
    }, [costMachineId, costClaudeId, session?.metadata?.joy__source]);

    // Drawing pad: opens the full-screen sketch route; the pad deposits its
    // captured PNG in useDrawingResult and this effect folds it into the
    // composer's attachments when we regain focus. (The Draw entry itself
    // lives in the attach sheet — handleAttach.)
    const drawnImage = useDrawingResult((s) => s.sessionId === sessionId ? s.image : null);
    React.useEffect(() => {
        if (!drawnImage) return;
        addImages([drawnImage]);
        useDrawingResult.getState().consume();
    }, [drawnImage, addImages]);

    // ChatComposer owns the message state + useDraft subscription. We only
    // hold an imperative handle so handleSend can read the live text and
    // clear it without subscribing to it (which would re-render the whole
    // SessionViewLoaded tree on every keystroke).
    const composerHandleRef = React.useRef<ChatComposerHandle | null>(null);

    // Handle dismissing CLI version warning
    const handleDismissCliWarning = React.useCallback(() => {
        if (machineId && cliVersion) {
            storage.getState().applyLocalSettings({
                acknowledgedCliVersions: {
                    ...acknowledgedCliVersions,
                    [machineId]: cliVersion
                }
            });
        }
    }, [machineId, cliVersion, acknowledgedCliVersions]);

    // joy-tmux sessions run interactive claude — mode/model changes must be
    // typed into the pane, not just stored app-side. joy-send-keys is the
    // raw-keystroke RPC (see joy-tmux keyTokens.ts).
    const sendJoyKeys = React.useCallback((script: string) => {
        if (!machineId || !joySessionId) return;
        void apiSocket.machineRPC(machineId, 'joy-send-keys', { id: joySessionId, script })
            .catch(() => { /* keystroke best-effort; stored state still updates */ });
    }, [machineId, joySessionId]);

    // Function to update permission mode
    const updatePermissionMode = React.useCallback((mode: PermissionMode) => {
        if (isJoyDaemon && machineId && joySessionId) {
            // Absolute set, server-side: joy-tmux reads the CURRENT mode off
            // the pane footer, walks Shift+Tab the right number of steps in
            // the real cycle (bypass → auto → default → acceptEdits → plan),
            // and verifies the footer afterwards. No client-side guessing.
            void apiSocket.machineRPC(machineId, 'joy-set-mode', { id: joySessionId, mode: mode.key })
                .catch(() => { /* best-effort; stored state still updates */ });
        }
        storage.getState().updateSessionPermissionMode(sessionId, mode.key);
    }, [sessionId, isJoyDaemon, machineId, joySessionId]);

    const updateModelMode = React.useCallback((mode: ModelMode) => {
        if (isJoyDaemon && flavor === 'opencode') {
            // No pane: the daemon switches the opencode session server-side.
            if (machineId && joySessionId) {
                void apiSocket.machineRPC(machineId, 'joy-opencode-set-model', { id: joySessionId, model: mode.key })
                    .catch(() => { /* best-effort; stored state still updates */ });
            }
        } else if (isJoyDaemon) {
            // /model <key> switches the interactive session directly; keys in
            // JOY_CLAUDE_MODELS are valid /model arguments.
            sendJoyKeys(`/model ${mode.key}<Enter>`);
        }
        storage.getState().updateSessionModelMode(sessionId, mode.key);
    }, [sessionId, isJoyDaemon, flavor, machineId, joySessionId, sendJoyKeys]);

    const updateEffortLevel = React.useCallback((level: EffortLevel) => {
        if (isJoyDaemon) {
            // /effort <level> sets the interactive session's reasoning effort,
            // exactly like /model sets the model. Levels low/medium/high/xhigh/
            // max are all valid /effort arguments and take effect immediately.
            sendJoyKeys(`/effort ${level.key}<Enter>`);
        }
        storage.getState().updateSessionEffortLevel(sessionId, level.key);
    }, [sessionId, isJoyDaemon, sendJoyKeys]);

    // Memoize header-dependent styles to prevent re-renders
    const headerDependentStyles = React.useMemo(() => ({
        contentContainer: {
            flex: 1
        },
        flatListStyle: {
            marginTop: 0 // No marginTop needed since header is handled by parent
        },
    }), []);

    // handleSend reads the live message via the composer ref, so it doesn't
    // need to re-create on every keystroke.
    const handleSend = React.useCallback(() => {
        const liveMessage = composerHandleRef.current?.getMessage() ?? '';
        const hasImages = selectedImages.length > 0;
        if (!liveMessage.trim() && !hasImages) return;
        const attachments = selectedImages;

        // THE queue is APP-SIDE (draft queue): a plain-text message sent while
        // the agent is busy is HELD here — editable/deletable until its turn —
        // and auto-released by draftQueueRelease when the turn completes. This
        // is deliberate (2026-07-10): daemon-side queueing meant fighting the
        // TUI for edit/cancel and inferring delivery from fragile signals. An
        // earlier app-side gate failed because thinking was stale and sends
        // were fire-and-forget; both are fixed (hook-driven thinking, and the
        // release is an automatic loop, not a one-shot). Slash commands and
        // attachment sends bypass the hold: commands are steer/immediate by
        // nature, and drafts don't carry attachments.
        const latest = storage.getState().sessions[sessionId];
        // Hold ONLY on fresh, provable busy: live presence + the ephemeral
        // thinking flag. A stale thinking (missed turn-end — the freeze bug
        // family) or a stale joy__thinking mirror must NOT gate sends: a
        // wrongly-held message is worse than a wrongly-immediate one (the
        // daemon/TUI queue absorbs the latter; the former ate sends, boite
        // Workspace/18, 2026-07-11).
        const busy = latest?.thinking === true
            && latest?.presence === 'online'
            && isFresh(latest);
        // NOTE: offline sends are NOT diverted here. They go through the normal
        // send path (optimistic echo + durable outbox, which auto-retries and
        // re-flushes on reconnect); their delivery state shows as a per-message
        // status (sending / waiting for connection / not delivered), iMessage-
        // style — see MessageDeliveryStatus. Only a message held behind a
        // processing turn ('busy') is queued app-side.
        // Only commands that actually EXECUTE mid-turn bypass the hold: the
        // CLI's immediate set (verified against the 2.1.198 binary — /model,
        // /compact, /clear are NOT in it; typed mid-turn they'd just sit in
        // Claude's TUI buffer, outside our editable queue and its ordering)
        // plus joy's daemon-intercepted commands, which exist for mid-turn use.
        const cmdMatch = /^\/([a-z-]+)/i.exec(liveMessage.trim());
        const isImmediateCommand = cmdMatch != null && IMMEDIATE_COMMANDS.has(cmdMatch[1].toLowerCase());
        if (isJoyDaemon && busy && !isImmediateCommand && !hasImages) {
            composerHandleRef.current?.clearMessage();
            // A message held because a turn is processing ahead is a QUEUE ITEM
            // ('busy'), not a draft — released by draftQueueRelease when the turn
            // completes.
            useDraftQueueStore.getState().add(sessionId, liveMessage, 'busy');
            return;
        }
        composerHandleRef.current?.clearMessage();
        clearImages();
        sync.sendMessage(sessionId, liveMessage, { source: 'chat', attachments });
    }, [sessionId, isJoyDaemon, selectedImages, clearImages]);

    // Stash the current input as an on-device draft (queued at the bottom of the
    // chat) and clear the box so the user can compose the next one. Drafts are
    // never sent to joy-tmux until the user sends them from the draft strip.
    const handleSaveDraft = React.useCallback(() => {
        const text = composerHandleRef.current?.getMessage() ?? '';
        if (!text.trim()) return;
        useDraftQueueStore.getState().add(sessionId, text, 'draft');
        composerHandleRef.current?.clearMessage();
    }, [sessionId]);

    const handleAbort = React.useCallback(() => {
        storage.getState().resetSessionAgentOverrides(sessionId);
        sessionAbort(sessionId);
    }, [sessionId]);

    // Esc contract on this screen (web/desktop): abort when a turn is running,
    // otherwise nothing — never navigate away. The browser-navigation Esc
    // handler consults this registration instead of route-back (useEscapeAbort).
    const escAbortable = sessionStatus.state === 'thinking';
    React.useEffect(() => {
        useEscapeAbort.getState().setHandler(escAbortable ? handleAbort : null);
        return () => useEscapeAbort.getState().setHandler(null);
    }, [escAbortable, handleAbort]);

    const handleFileViewerPress = React.useCallback(() => {
        router.push(`/session/${sessionId}/files`);
    }, [router, sessionId]);

    const handleAutocompleteSuggestions = React.useCallback((query: string) => (
        getSuggestions(sessionId, query)
    ), [sessionId]);

    const connectionStatus = React.useMemo(() => ({
        text: sessionStatus.statusText,
        color: sessionStatus.statusColor,
        dotColor: sessionStatus.statusDotColor,
        isPulsing: sessionStatus.isPulsing,
    }), [sessionStatus.statusText, sessionStatus.statusColor, sessionStatus.statusDotColor, sessionStatus.isPulsing]);

    const usageData = React.useMemo(() => {
        const source = sessionUsage ?? session.latestUsage;
        if (!source) return undefined;
        return {
            inputTokens: source.inputTokens,
            outputTokens: source.outputTokens,
            cacheCreation: source.cacheCreation,
            cacheRead: source.cacheRead,
            contextSize: source.contextSize,
        };
    }, [sessionUsage, session.latestUsage]);


    // Handle microphone button press - memoized to prevent button flashing
    const handleMicrophonePress = React.useCallback(async () => {
        if (realtimeStatus === 'connecting') {
            return; // Prevent actions during transitions
        }
        if (realtimeStatus === 'disconnected' || realtimeStatus === 'error') {
            try {
                const initialPrompt = voiceHooks.onVoiceStarted(sessionId);
                await startRealtimeSession(sessionId, initialPrompt);
            } catch (error) {
                console.error('Failed to start realtime session:', error);
                Modal.alert(t('common.error'), t('errors.voiceSessionFailed'));
            }
        } else if (realtimeStatus === 'connected') {
            await stopRealtimeSession();

            // Notify voice assistant about voice session stop
            voiceHooks.onVoiceStopped();
        }
    }, [realtimeStatus, sessionId]);

    // Memoize mic button state to prevent flashing during chat transitions
    const micButtonState = useMemo(() => ({
        onMicPress: handleMicrophonePress,
        isMicActive: realtimeStatus === 'connected' || realtimeStatus === 'connecting'
    }), [handleMicrophonePress, realtimeStatus]);

    // Trigger session visibility and initialize git status sync
    React.useLayoutEffect(() => {

        // Trigger session sync
        sync.onSessionVisible(sessionId);
        // Refresh session metadata once on open so a title that missed its live
        // update (stuck on "New chat") is corrected on open / switch-back.
        sync.refreshOpenSessionMeta();

        // Mark session as currently being viewed (clears unread)
        storage.getState().setCurrentViewingSession(sessionId);

        // Initialize git status sync for this session
        gitStatusSync.getSync(sessionId);

        return () => {
            // Clear viewing session on unmount
            const current = storage.getState().currentViewingSessionId;
            if (current === sessionId) {
                storage.getState().setCurrentViewingSession(null);
            }
        };
    }, [sessionId, realtimeStatus]);

    // Staleness backstop for the open chat: a missed live update (zombie
    // socket, silently dropped frame) froze the conversation until the user
    // navigated away and back — reconnect/foreground heals never fired because
    // nothing LOOKED broken. Probe the server for rows beyond our cursor on a
    // short cadence while this screen is active; the probe no-ops when in sync.
    useActiveInterval(() => {
        void sync.probeViewedSessionStaleness();
    }, 7000);

    let content = (
        <>
            <LoginBar sessionId={sessionId} />
            <DisconnectedBanner />
            <DialogBar sessionId={sessionId} />
            <CodexApprovalBar sessionId={sessionId} />
            <GoalBar sessionId={sessionId} />
            <Deferred>
                {messages.length > 0 && (
                    <ChatList ref={chatListRef} session={session} />
                )}
            </Deferred>
            {searchOpen && messages.length > 0 && (
                <View
                    pointerEvents="box-none"
                    style={{
                        position: 'absolute',
                        top: safeArea.top + headerHeight + 8,
                        left: 12,
                        right: 12,
                        alignItems: 'flex-end',
                        zIndex: 20,
                    }}
                >
                    <SessionSearchBar
                        sessionId={sessionId}
                        onScrollToMessage={(id) => chatListRef.current?.scrollToMessageId(id) ?? false}
                        onClose={() => setSearchOpen(false)}
                    />
                </View>
            )}
        </>
    );
    const placeholder = messages.length === 0 ? (
        <>
            {isLoaded ? (
                <EmptyMessages session={session} />
            ) : (
                <ActivityIndicator size="small" color={theme.colors.textSecondary} />
            )}
        </>
    ) : null;

    const composer = (
        <>
        {isJoyDaemon && (
            <CenteredInputWidth horizontalPadding={sessionInputHorizontalPadding}>
                <JoyQueueStrip queue={joyQueue} sessionId={sessionId} />
            </CenteredInputWidth>
        )}
        {isJoyDaemon && !isDisconnected && (
            <CenteredInputWidth horizontalPadding={sessionInputHorizontalPadding}>
                <PendingQueueStrip sessionId={sessionId} />
            </CenteredInputWidth>
        )}
        <CenteredInputWidth horizontalPadding={sessionInputHorizontalPadding}>
            <DraftQueueStrip sessionId={sessionId} />
        </CenteredInputWidth>
        <ChatComposer
            composerHandleRef={composerHandleRef}
            placeholder={t('session.inputPlaceholder')}
            sessionId={sessionId}
            permissionMode={permissionMode}
            onPermissionModeChange={updatePermissionMode}
            availableModes={availableModes}
            modelMode={modelMode}
            availableModels={availableModels}
            onModelModeChange={updateModelMode}
            effortLevel={effortLevel}
            availableEffortLevels={availableEffortLevels}
            onEffortLevelChange={updateEffortLevel}
            metadata={session.metadata}
            connectionStatus={connectionStatus}
            blockSend={false}
            onSend={handleSend}
            onSaveDraft={handleSaveDraft}
            onMicPress={isDisconnected ? undefined : micButtonState.onMicPress}
            isMicActive={isDisconnected ? false : micButtonState.isMicActive}
            onAbort={isDisconnected ? undefined : handleAbort}
            showAbortButton={sessionStatus.state === 'thinking'}
            onFileViewerPress={!isTablet ? handleFileViewerPress : undefined}
            selectedImages={selectedImages}
            onPickImages={handleAttach}
            costUsd={sessionCostUsd}
            onRemoveImage={removeImage}
            onAddImages={addImages}
            autocompletePrefixes={AGENT_INPUT_AUTOCOMPLETE_PREFIXES}
            autocompleteSuggestions={handleAutocompleteSuggestions}
            usageData={usageData}
            alwaysShowContextSize={alwaysShowContextSize}
            zenMode={zenMode}
        />
        </>
    );

    // Disconnected sessions get the full Resume affordance regardless of
    // whether they were explicitly archived or just lost their CLI (e.g.
    // Ctrl-C in terminal — lifecycleState stays 'running', server flips
    // active=false). InactiveArchivedHint handles both cases: shows the
    // Resume button when canResume is true, falls back to the
    // copy-this-command hint when the experiments toggle is off or the
    // machine isn't reachable.
    const inactiveHint = isDisconnected ? (
        <CenteredInputWidth horizontalPadding={sessionInputHorizontalPadding}>
            <InactiveArchivedHint
                resumeCommandBlock={expResumeSession ? resumeCommandBlock : null}
                canResume={canResume}
                resuming={resumingSession}
                onResume={resumeSession}
            />
        </CenteredInputWidth>
    ) : null;

    const input = (
        <>
            {inactiveHint}
            {composer}
        </>
    );


    return (
        <>
            {/* CLI Version Warning Overlay - Subtle centered pill */}
            {shouldShowCliWarning && !(isLandscape && deviceType === 'phone') && (
                <Pressable
                    onPress={handleDismissCliWarning}
                    style={{
                        position: 'absolute',
                        top: 8, // Position at top of content area (padding handled by parent)
                        alignSelf: 'center',
                        backgroundColor: '#FFF3CD',
                        borderRadius: 100, // Fully rounded pill
                        paddingHorizontal: 14,
                        paddingVertical: 7,
                        flexDirection: 'row',
                        alignItems: 'center',
                        zIndex: 998, // Below voice bar but above content
                        shadowColor: '#000',
                        shadowOffset: { width: 0, height: 2 },
                        shadowOpacity: 0.15,
                        shadowRadius: 4,
                        elevation: 4,
                    }}
                >
                    <Ionicons name="warning-outline" size={14} color="#FF9500" style={{ marginRight: 6 }} />
                    <Text style={{
                        fontSize: 12,
                        color: '#856404',
                        fontWeight: '600'
                    }}>
                        {t('sessionInfo.cliVersionOutdated')}
                    </Text>
                    <Ionicons name="close" size={14} color="#856404" style={{ marginLeft: 8 }} />
                </Pressable>
            )}

            {/* Main content area - no padding since header is overlay */}
            <View style={{ flexBasis: 0, flexGrow: 1, paddingBottom: safeArea.bottom + ((isRunningOnMac() || Platform.OS === 'web') ? 8 : 0) }}>
                <AgentContentView
                    content={content}
                    input={input}
                    placeholder={placeholder}
                />
            </View >

            {/* Back button for landscape phone mode when header is hidden */}
            {
                isLandscape && deviceType === 'phone' && (
                    <Pressable
                        onPress={() => router.back()}
                        style={{
                            position: 'absolute',
                            top: safeArea.top + 8,
                            left: 16,
                            width: 44,
                            height: 44,
                            borderRadius: 22,
                            backgroundColor: `rgba(${theme.dark ? '28, 23, 28' : '255, 255, 255'}, 0.9)`,
                            alignItems: 'center',
                            justifyContent: 'center',
                            ...Platform.select({
                                ios: {
                                    shadowColor: '#000',
                                    shadowOffset: { width: 0, height: 2 },
                                    shadowOpacity: 0.1,
                                    shadowRadius: 4,
                                },
                                android: {
                                    elevation: 2,
                                }
                            }),
                        }}
                        hitSlop={15}
                    >
                        <Ionicons
                            name={Platform.OS === 'ios' ? 'chevron-back' : 'arrow-back'}
                            size={Platform.select({ ios: 28, default: 24 })}
                            color="#000"
                        />
                    </Pressable>
                )
            }
        </>
    )
}

function InactiveArchivedHint(props: {
    resumeCommandBlock: NonNullable<ReturnType<typeof getResumeCommandBlock>> | null;
    canResume: boolean;
    resuming: boolean;
    onResume: () => void;
}) {
    const { theme } = useUnistyles();
    const hintTextStyle = {
        color: theme.colors.agentEventText,
        fontSize: 13,
        lineHeight: 18,
        textAlign: 'left' as const,
    };

    return (
        <View style={{
            paddingTop: 12,
            paddingBottom: 10,
            gap: 10,
            alignItems: 'stretch',
        }}>
            <View style={{ paddingHorizontal: 8, gap: 4 }}>
                <Text style={hintTextStyle}>
                    {t('session.inactiveArchived')}
                </Text>
                {props.canResume ? null : props.resumeCommandBlock && (
                    <Text style={hintTextStyle}>
                        {t('session.resumeFromTerminal')}
                    </Text>
                )}
            </View>
            {props.canResume ? (
                <Pressable
                    onPress={props.onResume}
                    disabled={props.resuming}
                    style={({ pressed }) => ({
                        height: 40,
                        borderRadius: 10,
                        backgroundColor: theme.colors.button.primary.background,
                        opacity: props.resuming ? 0.6 : pressed ? 0.8 : 1,
                        alignItems: 'center',
                        justifyContent: 'center',
                        marginHorizontal: 8,
                    })}
                >
                    {props.resuming ? (
                        <ActivityIndicator size="small" color={theme.colors.button.primary.tint} />
                    ) : (
                        <Text style={{ color: theme.colors.button.primary.tint, fontSize: 15, fontWeight: '600' }}>
                            {t('sessionInfo.resumeSession')}
                        </Text>
                    )}
                </Pressable>
            ) : props.resumeCommandBlock && (
                <ResumeCommandCopyBlock resumeCommandBlock={props.resumeCommandBlock} />
            )}
        </View>
    );
}

function ResumeCommandCopyBlock({ resumeCommandBlock }: {
    resumeCommandBlock: NonNullable<ReturnType<typeof getResumeCommandBlock>>;
}) {
    const { theme } = useUnistyles();
    const [copied, setCopied] = React.useState(false);

    return (
        <Pressable
            onPress={async () => {
                await Clipboard.setStringAsync(resumeCommandBlock.copyText);
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
            }}
            style={{
                minHeight: 48,
                borderRadius: 14,
                backgroundColor: theme.colors.surfaceHigh,
                flexDirection: 'row',
                gap: 8,
                paddingHorizontal: 16,
                paddingVertical: 12,
                alignItems: 'flex-start',
            }}
        >
            <View style={{ flex: 1 }}>
                {resumeCommandBlock.lines.map((line, index) => (
                    <Text
                        key={`${line}-${index}`}
                        style={{
                            color: theme.colors.text,
                            fontSize: 13,
                            lineHeight: 18,
                            fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
                        }}
                    >
                        {line}
                    </Text>
                ))}
            </View>
            <Ionicons
                name={copied ? 'checkmark' : 'copy-outline'}
                size={16}
                color={copied ? '#30D158' : theme.colors.textSecondary}
                style={{ marginTop: 1 }}
            />
        </Pressable>
    );
}

function CenteredInputWidth(props: {
    children: React.ReactNode;
    horizontalPadding: number;
}) {
    return (
        <View style={{
            width: '100%',
            paddingHorizontal: props.horizontalPadding,
            alignItems: 'center',
        }}>
            <View style={{
                width: '100%',
                maxWidth: layout.maxWidth,
            }}>
                {props.children}
            </View>
        </View>
    );
}
