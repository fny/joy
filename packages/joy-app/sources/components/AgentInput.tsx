import Ionicons from '@expo/vector-icons/Ionicons';
import Octicons from '@expo/vector-icons/Octicons';
import * as React from 'react';
import { View, Platform, useWindowDimensions, ViewStyle, Text, ActivityIndicator, TouchableWithoutFeedback, Image as RNImage, Pressable } from 'react-native';
import { Image } from 'expo-image';
import { AgentInputAttachmentStrip } from './AgentInputAttachmentStrip';
import type { AttachmentPreview } from '@/sync/attachmentTypes';
import { generateThumbhash } from '@/utils/thumbhash';
import { getImagesFromClipboard, getImagesFromDrop, fileToAttachmentPreview } from '@/utils/pasteImages.web';
import { layout } from './layout';
import { MultiTextInput, KeyPressEvent, MULTI_TEXT_INPUT_FONT_SIZE, MULTI_TEXT_INPUT_LINE_HEIGHT } from './MultiTextInput';
import { Typography } from '@/constants/Typography';
import { useChatFontScale } from '@/hooks/useChatFontScale';
import { PermissionMode, ModelMode } from './PermissionModeSelector';
import { EffortLevel, type ModeOption } from './modelModeOptions';
import { hapticsLight, hapticsError } from './haptics';
import { Shaker, ShakeInstance } from './Shaker';
import { StatusDot } from './StatusDot';
import { useActiveWord } from './autocomplete/useActiveWord';
import { AutocompleteDismissal, dismissalAt, isDismissalActive } from './autocomplete/dismissal';
import { useActiveSuggestions } from './autocomplete/useActiveSuggestions';
import { AgentInputAutocomplete } from './AgentInputAutocomplete';
import { FloatingOverlay } from './FloatingOverlay';
import { SessionSettingsPanel } from './SessionSettingsPanel';
import type { SettingsSection, SettingsSectionLevel } from './settingsPanel';
import { TextInputState, MultiTextInputHandle } from './MultiTextInput';
import { applySuggestion } from './autocomplete/applySuggestion';
import { GitStatusBadge, useHasMeaningfulGitStatus } from './GitStatusBadge';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useSetting } from '@/sync/storage';
import { hackMode, hackModes } from '@/sync/modeHacks';
import { Theme } from '@/theme';
import { t } from '@/text';
import { Metadata } from '@/sync/storageTypes';
import { contextWindowFor, formatTokens } from './contextWindow';
import { useMachineLimits } from '@/hooks/useMachineLimits';
import { tightestLimit, limitWindowName, limitResetLabel } from '@/utils/limitsFormat';

interface AgentInputProps {
    // `initialValue` seeds the uncontrolled textarea once; keystrokes never
    // round-trip back into it via React, which is what keeps fast typing/
    // deletion crisp. The parent reads the live text via the imperative ref.
    initialValue: string;
    placeholder: string;
    // Fires on every keystroke so the parent can sync derived state (drafts,
    // hasText) — typically wrapped in startTransition / debounce by the caller.
    onChangeText?: (text: string) => void;
    sessionId?: string;
    onSend: () => void;
    sendIcon?: React.ReactNode;
    /** Voice: shown in the send slot while the box is empty (hidden while a
     *  voice conversation is live or standing by — the status bar owns it). */
    onMicPress?: () => void;
    isMicActive?: boolean;
    permissionMode?: PermissionMode | null;
    availableModes?: PermissionMode[];
    onPermissionModeChange?: (mode: PermissionMode) => void;
    modelMode?: ModelMode | null;
    availableModels?: ModelMode[];
    onModelModeChange?: (mode: ModelMode) => void;
    effortLevel?: EffortLevel | null;
    availableEffortLevels?: EffortLevel[];
    onEffortLevelChange?: (level: EffortLevel) => void;
    metadata?: Metadata | null;
    onAbort?: () => void | Promise<void>;
    showAbortButton?: boolean;
    connectionStatus?: {
        text: string;
        color: string;
        dotColor: string;
        isPulsing?: boolean;
        cliStatus?: {
            claude: boolean | null;
            codex: boolean | null;
            gemini?: boolean | null;
        };
    };
    autocompletePrefixes: string[];
    autocompleteSuggestions: (query: string) => Promise<{ key: string, text: string, component: React.ElementType }[]>;
    usageData?: {
        inputTokens: number;
        outputTokens: number;
        cacheCreation: number;
        cacheRead: number;
        contextSize: number;
    };
    alwaysShowContextSize?: boolean;
    onFileViewerPress?: () => void;
    agentType?: 'claude' | 'codex' | 'gemini' | 'openclaw' | 'opencode';
    onAgentClick?: () => void;
    machineName?: string | null;
    /** Which machine's account quota the status segment reports (#646). */
    machineId?: string | null;
    onMachineClick?: () => void;
    currentPath?: string | null;
    onPathClick?: () => void;
    blockSend?: boolean;
    isSendDisabled?: boolean;
    isSending?: boolean;
    minHeight?: number;
    zenMode?: boolean;
    /** Tap the status line to see what is running in the background (#646). */
    onStatusPress?: () => void;
    /** Image attachments waiting to be sent (expImageUpload feature). */
    selectedImages?: AttachmentPreview[];
    onPickImages?: () => void;
    /** Estimated cumulative session cost in USD (shown in the info line). */
    costUsd?: number | null;
    onRemoveImage?: (id: string) => void;
    onAddImages?: (images: AttachmentPreview[]) => void;
    /** Stash the current input as an on-device draft (queued at the bottom of the chat). */
    onSaveDraft?: () => void;
}

// Context windows live in their own module so they can be tested without
// pulling in this component (#646). There is deliberately NO default: an
// unknown window shows tokens, never a percentage of a guess.
// (imported below as contextWindowFor / formatTokens)

const stylesheet = StyleSheet.create((theme, runtime) => ({
    container: {
        alignItems: 'center',
        paddingBottom: 8,
        paddingTop: 8,
    },
    innerContainer: {
        width: '100%',
        position: 'relative',
    },
    unifiedPanel: {
        backgroundColor: theme.colors.input.background,
        borderRadius: Platform.select({ default: 16, android: 20 }),
        overflow: 'hidden',
        paddingVertical: 2,
        paddingBottom: 8,
        paddingHorizontal: 8,
    },
    inputContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        borderWidth: 0,
        paddingLeft: 8,
        paddingRight: 8,
        paddingVertical: 4,
        minHeight: 40,
    },

    // Overlay styles
    autocompleteOverlay: {
        position: 'absolute',
        bottom: '100%',
        left: 0,
        right: 0,
        marginBottom: 8,
        zIndex: 1000,
    },
    settingsOverlay: {
        position: 'absolute',
        bottom: '100%',
        left: 0,
        right: 0,
        marginBottom: 8,
        zIndex: 1000,
    },
    overlayBackdrop: {
        position: 'absolute',
        top: -1000,
        left: -1000,
        right: -1000,
        bottom: -1000,
        zIndex: 999,
    },
    overlaySection: {
        paddingVertical: 8,
    },
    overlaySectionTitle: {
        fontSize: 12,
        fontWeight: '600',
        color: theme.colors.textSecondary,
        paddingHorizontal: 16,
        paddingBottom: 4,
        ...Typography.default('semiBold'),
    },

    // Status styles
    statusContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 16,
        paddingBottom: 4,
    },
    statusRow: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    statusText: {
        fontSize: 11,
        ...Typography.default(),
    },
    permissionModeContainer: {
        flexDirection: 'column',
        alignItems: 'flex-end',
    },
    permissionModeText: {
        fontSize: 11,
        ...Typography.default(),
    },
    contextWarningText: {
        fontSize: 11,
        marginLeft: 8,
        ...Typography.default(),
    },

    // Button styles
    actionButtonsContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 0,
    },
    actionButtonsLeft: {
        flexDirection: 'row',
        gap: 1,
        flex: 1,
        overflow: 'hidden',
    },
    actionButton: {
        flexDirection: 'row',
        alignItems: 'center',
        borderRadius: Platform.select({ default: 16, android: 20 }),
        paddingHorizontal: 6,
        paddingVertical: 6,
        justifyContent: 'center',
        height: 32,
    },
    actionButtonPressed: {
        opacity: 0.7,
    },
    actionButtonIcon: {
        color: theme.colors.button.secondary.tint,
    },
    sendButton: {
        width: 32,
        height: 32,
        borderRadius: 16,
        justifyContent: 'center',
        alignItems: 'center',
        flexShrink: 0,
        marginLeft: 8,
    },
    sendButtonActive: {
        backgroundColor: theme.colors.button.primary.background,
    },
    sendButtonInactive: {
        backgroundColor: theme.colors.button.primary.disabled,
    },
    sendButtonLocked: {
        backgroundColor: theme.colors.surfaceHigh,
        borderWidth: 1,
        borderColor: theme.colors.divider,
    },
    sendButtonInner: {
        width: '100%',
        height: '100%',
        alignItems: 'center',
        justifyContent: 'center',
    },
    sendButtonInnerPressed: {
        opacity: 0.7,
    },
    sendButtonIcon: {
        color: theme.colors.button.primary.tint,
    },
}));

const getContextWarning = (
    contextSize: number,
    alwaysShow: boolean = false,
    theme: Theme,
    window: number | null = null,
) => {
    // Unknown window: report what we actually know — how much context is in
    // play — instead of a percentage of a number we invented (#646). Neutral
    // colour, since with no window there is no threshold to warn against.
    if (window === null) {
        return alwaysShow
            ? { text: t('agentInput.context.used_short', { tokens: formatTokens(contextSize) }), color: theme.colors.textSecondary }
            : null;
    }
    const percentageUsed = (contextSize / window) * 100;
    const percentageRemaining = Math.max(0, Math.min(100, 100 - percentageUsed));

    if (percentageRemaining <= 5) {
        return { text: t('agentInput.context.remaining', { percent: Math.round(percentageRemaining) }), color: theme.colors.warningCritical };
    } else if (percentageRemaining <= 10) {
        return { text: t('agentInput.context.remaining', { percent: Math.round(percentageRemaining) }), color: theme.colors.warning };
    } else if (alwaysShow) {
        // Show context remaining in neutral color when not near limit
        return { text: t('agentInput.context.remaining', { percent: Math.round(percentageRemaining) }), color: theme.colors.warning };
    }
    return null; // No display needed
};

// Stable sub-trees extracted from AgentInput so they don't reconcile when
// the input's keystroke-derived state (hasText / inputState) flips. Their
// props are derived from session metadata, not from the textarea content,
// so memo skips re-render on typing entirely.

type StatusRowProps = {
    connectionStatus?: AgentInputProps['connectionStatus'];
    contextWarning: { text: string; color: string } | null;
    displayPermissionMode: ReturnType<typeof hackMode> | null;
    permissionModeKey: string;
    isSandboxedYoloMode: boolean;
    permissionLabel: string | null;
    modelLabel: string | null;
    agentLabel: string | null;
    effortLabel: string | null;
    costUsd?: number | null;
    zenMode?: boolean;
    /** Tapping the status opens the background-work sheet (#646). Absent when
     *  nothing is running, so the text stays inert rather than opening an
     *  empty list. */
    onStatusPress?: () => void;
    /** agent · model · effort · perm opens the same overlay as the cog (#647):
     *  it names exactly what that overlay changes, so it should be the way in. */
    onSettingsPress?: () => void;
    /** The usage segment opens the context breakdown behind the percentage. */
    onUsagePress?: () => void;
};

const AgentInputStatusRow = React.memo(function AgentInputStatusRow(p: StatusRowProps) {
    const { theme } = useUnistyles();
    const showPermission = !!p.displayPermissionMode
        && p.permissionModeKey !== 'default'
        && !!p.permissionLabel;
    const showInfoLine = !p.zenMode && !!(p.agentLabel || p.modelLabel || p.effortLabel || showPermission || p.contextWarning);
    if (!p.connectionStatus && !p.contextWarning && !showInfoLine) {
        return null;
    }
    return (
        <View style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            paddingHorizontal: 16,
            paddingBottom: 4,
            minHeight: 20,
        }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1, gap: 11 }}>
                {p.connectionStatus && (
                    <>
                        <Pressable
                            style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}
                            onPress={p.onStatusPress}
                            disabled={!p.onStatusPress}
                            hitSlop={8}
                            accessibilityRole={p.onStatusPress ? 'button' : undefined}
                            accessibilityLabel={p.onStatusPress ? t('backgroundWork.title') : undefined}
                        >
                            <StatusDot
                                color={p.connectionStatus.dotColor}
                                isPulsing={p.connectionStatus.isPulsing}
                                size={6}
                            />
                            <Text style={{
                                fontSize: 11,
                                color: p.connectionStatus.color,
                                ...Typography.default(),
                                // Underline hints it is tappable without adding
                                // chrome to a line that is mostly read, not used.
                                ...(p.onStatusPress ? { textDecorationLine: 'underline' as const, textDecorationStyle: 'dotted' as const } : {}),
                            }}>
                                {p.connectionStatus.text}
                            </Text>
                        </Pressable>
                        {p.connectionStatus.cliStatus && (
                            <>
                                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                                    <Text style={{
                                        fontSize: 11,
                                        color: p.connectionStatus.cliStatus.claude ? theme.colors.success : theme.colors.textDestructive,
                                        ...Typography.default()
                                    }}>
                                        {p.connectionStatus.cliStatus.claude ? '✓' : '✗'}
                                    </Text>
                                    <Text style={{
                                        fontSize: 11,
                                        color: p.connectionStatus.cliStatus.claude ? theme.colors.success : theme.colors.textDestructive,
                                        ...Typography.default()
                                    }}>
                                        claude
                                    </Text>
                                </View>
                                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                                    <Text style={{
                                        fontSize: 11,
                                        color: p.connectionStatus.cliStatus.codex ? theme.colors.success : theme.colors.textDestructive,
                                        ...Typography.default()
                                    }}>
                                        {p.connectionStatus.cliStatus.codex ? '✓' : '✗'}
                                    </Text>
                                    <Text style={{
                                        fontSize: 11,
                                        color: p.connectionStatus.cliStatus.codex ? theme.colors.success : theme.colors.textDestructive,
                                        ...Typography.default()
                                    }}>
                                        codex
                                    </Text>
                                </View>
                                {p.connectionStatus.cliStatus.gemini !== undefined && (
                                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                                        <Text style={{
                                            fontSize: 11,
                                            color: p.connectionStatus.cliStatus.gemini ? theme.colors.success : theme.colors.textDestructive,
                                            ...Typography.default()
                                        }}>
                                            {p.connectionStatus.cliStatus.gemini ? '✓' : '✗'}
                                        </Text>
                                        <Text style={{
                                            fontSize: 11,
                                            color: p.connectionStatus.cliStatus.gemini ? theme.colors.success : theme.colors.textDestructive,
                                            ...Typography.default()
                                        }}>
                                            gemini
                                        </Text>
                                    </View>
                                )}
                            </>
                        )}
                    </>
                )}
            </View>
            {showInfoLine && (() => {
                const permColor = p.isSandboxedYoloMode ? '#4169E1' :
                    p.permissionModeKey === 'acceptEdits' ? theme.colors.permission.acceptEdits :
                        p.permissionModeKey === 'bypassPermissions' ? theme.colors.permission.bypass :
                            p.permissionModeKey === 'plan' ? theme.colors.permission.plan :
                                p.permissionModeKey === 'read-only' ? theme.colors.permission.readOnly :
                                    p.permissionModeKey === 'safe-yolo' ? theme.colors.permission.safeYolo :
                                        p.permissionModeKey === 'yolo' ? theme.colors.permission.yolo :
                                            theme.colors.textSecondary;
                // agent · model · effort · permission · usage — only segments that exist.
                const dim = { fontSize: 11, color: theme.colors.textSecondary, ...Typography.default() } as const;
                const segments: React.ReactNode[] = [];
                const pushDot = () => segments.push(<Text key={`d${segments.length}`} style={dim}>{' · '}</Text>);
                if (p.agentLabel) segments.push(<Text key="agent" style={dim}>{p.agentLabel}</Text>);
                if (p.modelLabel) { if (segments.length) pushDot(); segments.push(<Text key="model" style={dim}>{p.modelLabel}</Text>); }
                if (p.effortLabel) { if (segments.length) pushDot(); segments.push(<Text key="effort" style={dim}>{p.effortLabel}</Text>); }
                if (p.costUsd != null && p.costUsd > 0) {
                    if (segments.length) pushDot();
                    // Cents precision under $10, whole-dollar-ish above.
                    const cost = p.costUsd < 10 ? p.costUsd.toFixed(2) : p.costUsd.toFixed(p.costUsd < 100 ? 1 : 0);
                    segments.push(<Text key="cost" style={dim}>{`$${cost}`}</Text>);
                }
                if (showPermission) { if (segments.length) pushDot(); segments.push(<Text key="perm" style={{ fontSize: 11, color: permColor, ...Typography.default() }}>{p.permissionLabel}</Text>); }
                // Usage still trails the cluster (#637) but is rendered below as its
                // own press target, so tapping the percentage opens the context
                // breakdown rather than the settings overlay.
                // The label cluster IS the settings overlay's contents in words —
                // tapping what you want to change is the obvious gesture (#647).
                // Usage carries its own press target so the two do not fight.
                return (
                    <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                        <Pressable
                            onPress={p.onSettingsPress}
                            disabled={!p.onSettingsPress}
                            hitSlop={8}
                            accessibilityRole={p.onSettingsPress ? 'button' : undefined}
                            accessibilityLabel={p.onSettingsPress ? t('agentInput.permissionMode.title') : undefined}
                            style={{ flexDirection: 'row', alignItems: 'center' }}
                        >
                            {segments}
                        </Pressable>
                        {p.contextWarning && (
                            <Pressable
                                onPress={p.onUsagePress}
                                disabled={!p.onUsagePress}
                                hitSlop={8}
                                accessibilityRole={p.onUsagePress ? 'button' : undefined}
                                accessibilityLabel={p.onUsagePress ? t('agentInput.context.title') : undefined}
                                style={{ flexDirection: 'row', alignItems: 'center' }}
                            >
                                {segments.length > 0 && <Text style={dim}>{' · '}</Text>}
                                <Text style={{ fontSize: 11, color: p.contextWarning.color, ...Typography.default() }}>
                                    {p.contextWarning.text}
                                </Text>
                            </Pressable>
                        )}
                    </View>
                );
            })()}
        </View>
    );
});

type ContextChipsProps = {
    machineName?: string | null;
    onMachineClick?: () => void;
    currentPath?: string | null;
    onPathClick?: () => void;
};

const AgentInputContextChips = React.memo(function AgentInputContextChips(p: ContextChipsProps) {
    const { theme } = useUnistyles();
    if (p.machineName === undefined && !p.currentPath) {
        return null;
    }
    return (
        <View style={{
            backgroundColor: theme.colors.surfacePressed,
            borderRadius: 12,
            padding: 8,
            marginBottom: 8,
            gap: 4,
        }}>
            {p.machineName !== undefined && p.onMachineClick && (
                <Pressable
                    onPress={() => {
                        hapticsLight();
                        p.onMachineClick?.();
                    }}
                    hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
                    style={(s) => ({
                        flexDirection: 'row',
                        alignItems: 'center',
                        borderRadius: Platform.select({ default: 16, android: 20 }),
                        paddingHorizontal: 10,
                        paddingVertical: 6,
                        height: 32,
                        opacity: s.pressed ? 0.7 : 1,
                        gap: 6,
                    })}
                >
                    <Ionicons name="desktop-outline" size={14} color={theme.colors.textSecondary} />
                    <Text style={{
                        fontSize: 13,
                        color: theme.colors.text,
                        fontWeight: '600',
                        ...Typography.default('semiBold'),
                    }}>
                        {p.machineName === null ? t('agentInput.noMachinesAvailable') : p.machineName}
                    </Text>
                </Pressable>
            )}
            {p.currentPath && p.onPathClick && (
                <Pressable
                    onPress={() => {
                        hapticsLight();
                        p.onPathClick?.();
                    }}
                    hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
                    style={(s) => ({
                        flexDirection: 'row',
                        alignItems: 'center',
                        borderRadius: Platform.select({ default: 16, android: 20 }),
                        paddingHorizontal: 10,
                        paddingVertical: 6,
                        height: 32,
                        opacity: s.pressed ? 0.7 : 1,
                        gap: 6,
                    })}
                >
                    <Ionicons name="folder-outline" size={14} color={theme.colors.textSecondary} />
                    <Text style={{
                        fontSize: 13,
                        color: theme.colors.text,
                        fontWeight: '600',
                        ...Typography.default('semiBold'),
                    }}>
                        {p.currentPath}
                    </Text>
                </Pressable>
            )}
        </View>
    );
});

export const AgentInput = React.memo(React.forwardRef<MultiTextInputHandle, AgentInputProps>((props, ref) => {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const { width: screenWidth, height: screenHeight } = useWindowDimensions();
    const isSendBlocked = props.blockSend ?? false;

    // Chat font size setting: the composer text mirrors the chat scale so
    // typed text matches how it will render once sent. The max height scales
    // with the line height so the maximum VISIBLE LINE COUNT stays constant
    // (on web MultiTextInput also derives maxRows from maxHeight/lineHeight,
    // which stays consistent because both are scaled together). Status pills,
    // chips and action buttons keep their fixed metrics.
    const chatFontScale = useChatFontScale();
    const inputFontSize = MULTI_TEXT_INPUT_FONT_SIZE * chatFontScale;
    const inputLineHeight = Math.round(MULTI_TEXT_INPUT_LINE_HEIGHT * chatFontScale);
    const inputMaxHeight = Math.round((Platform.OS === 'web' ? 480 : 120) * chatFontScale);

    // `hasText` drives only the send-button appearance/enabled state. It's
    // updated via startTransition from the keystroke handler so a busy reducer
    // never blocks the next character from landing in the textarea.
    const [hasText, setHasText] = React.useState(() => props.initialValue.trim().length > 0);
    const hasImages = (props.selectedImages?.length ?? 0) > 0;
    const showMic = !!props.onMicPress && !props.isMicActive;
    const canPressSendButton = !props.isSending
        && !props.isSendDisabled
        && (isSendBlocked ? (hasText || hasImages) : (hasText || hasImages || showMic));

    // ABORT takes over the send slot while a turn is processing and the box is
    // empty; any typed text flips it back to send so mid-turn queueing/steering
    // stays one tap. Escape still aborts on web regardless.
    const abortMode = !!(props.showAbortButton && props.onAbort && !hasText && !hasImages && !props.isSending && !isSendBlocked);

    // Check if this is a Codex, Gemini, or OpenClaw session
    // Use metadata.flavor for existing sessions, agentType prop for new sessions
    const isCodex = props.metadata?.flavor === 'codex' || props.agentType === 'codex';
    const isGemini = props.metadata?.flavor === 'gemini' || props.agentType === 'gemini';
    const isOpenClaw = props.metadata?.flavor === 'openclaw' || props.agentType === 'openclaw';
    const displayPermissionMode = React.useMemo(() => (
        props.permissionMode ? hackMode(props.permissionMode) : null
    ), [props.permissionMode]);
    // Short model name for the status row ("fable yolo"). currentModelCode is
    // the daemon's mirror of the model actually producing output (it tracks
    // /model switches made in the terminal), so it wins over the composer
    // selection; full ids reduce to the family alias (claude-fable-5 → fable).
    const modelLabel = React.useMemo(() => {
        const code = props.metadata?.currentModelCode;
        const m = typeof code === 'string' ? /^claude-([a-z]+)/.exec(code) : null;
        return m?.[1] ?? props.modelMode?.name ?? null;
    }, [props.metadata?.currentModelCode, props.modelMode]);
    const permissionModeKey = displayPermissionMode?.key ?? 'default';
    const availableModes = React.useMemo(() => (
        hackModes(props.availableModes ?? [])
    ), [props.availableModes]);
    const availableModels = props.availableModels ?? [];
    const availableEffortLevels = props.availableEffortLevels ?? [];

    // What the settings panel offers. A setting with no options — or with no
    // handler to apply one — is not a row: the harness capability table means
    // a session can legitimately have no permission surface, and offering an
    // empty list to drill into is worse than offering nothing.
    const settingsSections = React.useMemo<SettingsSection[]>(() => ([
        {
            level: 'permission',
            label: t('agentInput.settingsPanel.permission'),
            title: isCodex ? t('agentInput.codexPermissionMode.title') : isGemini ? t('agentInput.geminiPermissionMode.title') : t('agentInput.permissionMode.title'),
            options: props.onPermissionModeChange ? availableModes : [],
            selectedKey: permissionModeKey,
        },
        {
            level: 'model',
            label: t('agentInput.settingsPanel.model'),
            title: t('agentInput.model.title'),
            options: props.onModelModeChange ? availableModels : [],
            selectedKey: props.modelMode?.key ?? null,
        },
        {
            level: 'effort',
            label: t('agentInput.settingsPanel.effort'),
            title: t('agentInput.effort.title'),
            options: props.onEffortLevelChange ? availableEffortLevels : [],
            selectedKey: props.effortLevel?.key ?? null,
        },
    ]), [
        isCodex, isGemini, availableModes, availableModels, availableEffortLevels,
        permissionModeKey, props.modelMode?.key, props.effortLevel?.key,
        props.onPermissionModeChange, props.onModelModeChange, props.onEffortLevelChange,
    ]);
    const hasSettingsSections = settingsSections.some((s) => s.options.length > 0);
    // The card is pinned above the composer and grows upward, so its ceiling
    // has to clear the keyboard AND the header on the smallest phone. A
    // fraction of the screen rather than the old flat 400pt, which on a short
    // device could push the top of the panel off-screen — and the top is
    // where the back chevron lives. Measuring the real available space is the
    // better fix; this is the safe bound until then.
    const settingsMaxHeight = Math.min(360, Math.round(screenHeight * 0.4));
    const isSandboxEnabled = React.useMemo(() => {
        const sandbox = props.metadata?.sandbox as unknown;
        if (!sandbox) {
            return false;
        }
        if (typeof sandbox === 'object' && sandbox !== null && 'enabled' in sandbox) {
            return Boolean((sandbox as { enabled?: unknown }).enabled);
        }
        return true;
    }, [props.metadata?.sandbox]);
    const isSandboxedYoloMode = isSandboxEnabled && (
        permissionModeKey === 'bypassPermissions' || permissionModeKey === 'yolo'
    );

    const withSandboxSuffix = React.useCallback((label: string, modeKey?: string) => {
        if (!isSandboxEnabled) {
            return label;
        }
        if (modeKey === 'bypassPermissions' || modeKey === 'yolo') {
            return `${label} (sandboxed)`;
        }
        return label;
    }, [isSandboxEnabled]);

    // Calculate context warning
    const contextWarning = props.usageData?.contextSize
        ? getContextWarning(
            props.usageData.contextSize,
            props.alwaysShowContextSize ?? false,
            theme,
            contextWindowFor(props.metadata?.currentModelCode as string | undefined),
        )
        : null;

    // Account QUOTA is what the segment should report (#646): it is real server
    // truth (the limits page's own source) and it is what actually runs out and
    // stops you working. Context only ever measured this conversation, and
    // against a window the app had to guess. Quota wins when we have it; the
    // context reading stays as the fallback.
    const limits = useMachineLimits(props.machineId);
    const tightest = tightestLimit(limits?.rows);
    const quotaWarning = tightest
        ? {
            text: t('agentInput.context.remaining', { percent: Math.max(0, Math.round(100 - tightest.usedPercent)) }),
            color: tightest.usedPercent >= 90 ? theme.colors.warningCritical
                : tightest.usedPercent >= 80 ? theme.colors.warning
                    : theme.colors.textSecondary,
        }
        : null;

    const agentInputEnterToSend = useSetting('agentInputEnterToSend');


    // Abort button state
    const [isAborting, setIsAborting] = React.useState(false);
    const shakerRef = React.useRef<ShakeInstance>(null);
    const sendBlockShakerRef = React.useRef<ShakeInstance>(null);
    const inputRef = React.useRef<MultiTextInputHandle>(null);

    // Forward ref to the MultiTextInput as STABLE wrappers that read
    // inputRef.current at call time. Forwarding the child's handle object once
    // (empty deps) kept the FIRST handle — MultiTextInput rebuilds its handle
    // whenever onChangeText/onStateChange change, so imperative clears and
    // restores notified the obsolete callbacks and the current parent's draft
    // state went stale (#197).
    React.useImperativeHandle(ref, () => ({
        getText: () => inputRef.current?.getText() ?? '',
        setTextAndSelection: (text, selection) => { inputRef.current?.setTextAndSelection(text, selection); },
        focus: () => { inputRef.current?.focus(); },
        blur: () => { inputRef.current?.blur(); },
    }), []);

    // Web paste/drag — intercept image pastes and file drops for the
    // attachment feature. Both handlers funnel through props.onAddImages.
    React.useEffect(() => {
        if (Platform.OS !== 'web' || !props.onAddImages) return;

        const handlePaste = (e: ClipboardEvent) => {
            // Only handle pastes targeted at a focused text-editable element.
            // The listener is attached to document, so without this guard a
            // paste in the URL bar, another modal, or any focused-elsewhere
            // input would steal images intended for somewhere else.
            const active = document.activeElement;
            const isEditableTarget = active instanceof HTMLInputElement
                || active instanceof HTMLTextAreaElement
                || (active instanceof HTMLElement && active.isContentEditable);
            if (!isEditableTarget) return;

            // Inspect the clipboard and preventDefault SYNCHRONOUSLY. The old
            // handler awaited a dynamic import first; by then the paste's
            // default action had run, so a clipboard carrying an image plus a
            // text/HTML alternative (web page, Slack, Figma) attached the image
            // AND dumped the text into the textarea (#14).
            const files = getImagesFromClipboard(e);
            if (!files.length) return;
            e.preventDefault();
            void (async () => {
                const previews = (await Promise.all(
                    files.map((f) => fileToAttachmentPreview(f, generateThumbhash))
                )).filter(Boolean) as Omit<AttachmentPreview, 'id'>[];
                if (previews.length) {
                    props.onAddImages!(previews.map((p) => ({
                        ...p,
                        id: `paste_${Date.now()}_${Math.random().toString(36).slice(2)}`,
                    })));
                }
            })();
        };

        // dragover must call preventDefault for drop to fire; we gate on
        // `types.includes('Files')` so we don't hijack drag-text/HTML in the
        // rest of the app.
        const isFileDrag = (e: DragEvent) => {
            const types = e.dataTransfer?.types;
            if (!types) return false;
            // DataTransferItemList vs DOMStringList — both expose .includes-ish.
            for (let i = 0; i < types.length; i++) {
                if (types[i] === 'Files') return true;
            }
            return false;
        };

        const handleDragOver = (e: DragEvent) => {
            if (!isFileDrag(e)) return;
            e.preventDefault();
            if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
        };

        const handleDrop = (e: DragEvent) => {
            if (!isFileDrag(e)) return;
            e.preventDefault();
            // Snapshot the File objects BEFORE any await: once the drop event
            // has dispatched the browser protects the drag data store and
            // dataTransfer.files reads empty — the old handler awaited a
            // dynamic import first and attached nothing (#198).
            const files = getImagesFromDrop(e);
            if (!files.length) return;
            void (async () => {
                const previews = (await Promise.all(
                    files.map((f) => fileToAttachmentPreview(f, generateThumbhash))
                )).filter(Boolean) as Omit<AttachmentPreview, 'id'>[];
                if (previews.length) {
                    props.onAddImages!(previews.map((p) => ({
                        ...p,
                        id: `drop_${Date.now()}_${Math.random().toString(36).slice(2)}`,
                    })));
                }
            })();
        };

        document.addEventListener('paste', handlePaste);
        document.addEventListener('dragover', handleDragOver);
        document.addEventListener('drop', handleDrop);
        return () => {
            document.removeEventListener('paste', handlePaste);
            document.removeEventListener('dragover', handleDragOver);
            document.removeEventListener('drop', handleDrop);
        };
    }, [props.onAddImages]);

    // Autocomplete state — text + selection. Updated via startTransition so
    // typing renders the character immediately and the autocomplete pipeline
    // catches up on the next idle frame instead of blocking input.
    const [inputState, setInputState] = React.useState<TextInputState>(() => ({
        text: props.initialValue,
        selection: { start: props.initialValue.length, end: props.initialValue.length }
    }));

    const onChangeTextProp = props.onChangeText;
    const handleTextChange = React.useCallback((text: string) => {
        React.startTransition(() => {
            setHasText(text.trim().length > 0);
        });
        onChangeTextProp?.(text);
    }, [onChangeTextProp]);

    const handleInputStateChange = React.useCallback((newState: TextInputState) => {
        React.startTransition(() => {
            setInputState(newState);
        });
    }, []);

    // Use the tracked selection from inputState
    const activeWord = useActiveWord(inputState.text, inputState.selection, props.autocompletePrefixes);
    // Escape with suggestions open DISMISSES that query: the word stays in the
    // text, but no suggestions are requested for it until the text or the
    // caret changes (typing anywhere, caret move). The old Escape wrote the
    // same text and collapsed selection back, which changed nothing — every
    // further Escape was consumed by the autocomplete branch and never reached
    // Stop (#195). The dismissal is keyed on text + caret, not on the active
    // word string: "/co /co" dismissed at caret 3 reopens at caret 7.
    const [dismissal, setDismissal] = React.useState<AutocompleteDismissal | null>(null);
    const dismissed = isDismissalActive(dismissal, inputState.text, inputState.selection);
    React.useEffect(() => {
        if (dismissal !== null && !dismissed) setDismissal(null);
    }, [dismissal, dismissed]);
    const liveActiveWord = dismissed ? null : activeWord;
    // Using default options: clampSelection=true, autoSelectFirst=true, wrapAround=true
    // To customize: useActiveSuggestions(activeWord, props.autocompleteSuggestions, { clampSelection: false, wrapAround: false })
    const [suggestions, selected, moveUp, moveDown] = useActiveSuggestions(liveActiveWord, props.autocompleteSuggestions, { clampSelection: true, wrapAround: true });

    // Debug logging
    // React.useEffect(() => {
    //     console.log('🔍 Autocomplete Debug:', JSON.stringify({
    //         value: props.value,
    //         inputState,
    //         activeWord,
    //         suggestionsCount: suggestions.length,
    //         selected,
    //         prefixes: props.autocompletePrefixes
    //     }, null, 2));
    // }, [props.value, inputState, activeWord, suggestions.length, selected]);

    // Handle suggestion selection
    const handleSuggestionSelect = React.useCallback((index: number) => {
        if (!suggestions[index] || !inputRef.current) return;

        const suggestion = suggestions[index];

        // Apply the suggestion
        const result = applySuggestion(
            inputState.text,
            inputState.selection,
            suggestion.text,
            props.autocompletePrefixes,
            true // add space after
        );

        // Use imperative API to set text and selection
        inputRef.current.setTextAndSelection(result.text, {
            start: result.cursorPosition,
            end: result.cursorPosition
        });

        // console.log('Selected suggestion:', suggestion.text);

        // Small haptic feedback
        hapticsLight();
    }, [suggestions, inputState, props.autocompletePrefixes]);

    // Settings modal state
    const [showSettings, setShowSettings] = React.useState(false);

    // The context breakdown behind the "% left" segment (#647). Separate state
    // from the settings overlay so the two can never be open at once.
    const [showUsage, setShowUsage] = React.useState(false);
    const handleUsagePress = React.useCallback(() => {
        hapticsLight();
        setShowSettings(false);
        setShowUsage(prev => !prev);
    }, []);

    // Handle settings button press
    const handleSettingsPress = React.useCallback(() => {
        hapticsLight();
        setShowUsage(false);
        setShowSettings(prev => !prev);
    }, []);

    // A choice made in the settings panel. The panel itself decides whether
    // to return to its root or close (settingsPanel.levelAfterSelect); this
    // only applies the value.
    const handleSettingsChoice = React.useCallback((level: SettingsSectionLevel, option: ModeOption) => {
        if (level === 'permission') props.onPermissionModeChange?.(option);
        else if (level === 'model') props.onModelModeChange?.(option);
        else props.onEffortLevelChange?.(option);
    }, [props.onPermissionModeChange, props.onModelModeChange, props.onEffortLevelChange]);

    // Handle abort button press
    const handleAbortPress = React.useCallback(async () => {
        if (!props.onAbort) return;

        hapticsError();
        setIsAborting(true);
        const startTime = Date.now();

        try {
            await props.onAbort?.();

            // Ensure minimum 300ms loading time
            const elapsed = Date.now() - startTime;
            if (elapsed < 300) {
                await new Promise(resolve => setTimeout(resolve, 300 - elapsed));
            }
        } catch (error) {
            // Shake on error
            shakerRef.current?.shake();
            console.error('Abort RPC call failed:', error);
        } finally {
            setIsAborting(false);
        }
    }, [props.onAbort]);

    const handleBlockedSendAttempt = React.useCallback(() => {
        if (!isSendBlocked || !hasText || props.isSending) return;
        hapticsError();
        sendBlockShakerRef.current?.shake();
    }, [hasText, isSendBlocked, props.isSending]);

    const handleSendPress = React.useCallback(() => {
        if (isSendBlocked) {
            handleBlockedSendAttempt();
            return;
        }
        if (props.isSendDisabled || props.isSending) return;

        hapticsLight();
        // Live read avoids stalling behind the transitioned `hasText`.
        const liveHasText = (inputRef.current?.getText() ?? '').trim().length > 0;
        if (liveHasText || hasImages) {
            props.onSend();
        } else if (showMic) {
            props.onMicPress?.();
        }
    }, [handleBlockedSendAttempt, hasImages, isSendBlocked, props.isSendDisabled, props.isSending, props.onSend, props.onMicPress, showMic]);

    // Handle keyboard navigation
    const handleKeyPress = React.useCallback((event: KeyPressEvent): boolean => {
        // Handle autocomplete navigation first
        if (suggestions.length > 0) {
            if (event.key === 'ArrowUp') {
                moveUp();
                return true;
            } else if (event.key === 'ArrowDown') {
                moveDown();
                return true;
            } else if ((event.key === 'Enter' || (event.key === 'Tab' && !event.shiftKey))) {
                // Both Enter and Tab select the current suggestion
                // If none selected (selected === -1), select the first one
                const indexToSelect = selected >= 0 ? selected : 0;
                handleSuggestionSelect(indexToSelect);
                return true;
            } else if (event.key === 'Escape') {
                // Dismiss this query; the next Escape falls through to abort (#195).
                setDismissal(dismissalAt(inputState.text, inputState.selection));
                return true;
            }
        }

        // Handle Escape for abort when no suggestions are visible
        if (event.key === 'Escape' && props.showAbortButton && props.onAbort && !isAborting) {
            handleAbortPress();
            return true;
        }

        // Original key handling
        if (Platform.OS === 'web') {
            // On mobile web (touch devices), Enter should insert a newline since
            // there's no Shift key available. Users send via the send button instead.
            // Use pointer:coarse media query instead of ontouchstart/maxTouchPoints
            // to avoid false positives on Windows touch-screen laptops with keyboards.
            const isTouchDevice = typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches;
            if (agentInputEnterToSend && event.key === 'Enter' && !event.shiftKey && !isTouchDevice) {
                // Read live text from the textarea — `hasText` is debounced via
                // startTransition and would lag behind a quick type-then-Enter.
                const liveText = inputRef.current?.getText() ?? '';
                if (liveText.trim()) {
                    if (isSendBlocked) {
                        handleBlockedSendAttempt();
                    } else if (!props.isSendDisabled) {
                        props.onSend();
                    }
                    return true; // Key was handled
                }
            }
            // Handle Shift+Tab for permission mode switching
            if (event.key === 'Tab' && event.shiftKey && props.onPermissionModeChange && availableModes.length > 0) {
                const currentIndex = availableModes.findIndex((mode) => mode.key === permissionModeKey);
                const nextIndex = ((currentIndex >= 0 ? currentIndex : 0) + 1) % availableModes.length;
                props.onPermissionModeChange(availableModes[nextIndex]);
                hapticsLight();
                return true; // Key was handled, prevent default tab behavior
            }

        }
        return false; // Key was not handled
    }, [suggestions, moveUp, moveDown, selected, handleSuggestionSelect, inputState.text, inputState.selection, props.showAbortButton, props.onAbort, isAborting, handleAbortPress, agentInputEnterToSend, props.onSend, props.onPermissionModeChange, availableModes, permissionModeKey, isSendBlocked, handleBlockedSendAttempt, props.isSendDisabled]);




    return (
        <View style={[
            styles.container,
            { paddingHorizontal: screenWidth > 700 ? 12 : 8 }
        ]}>
            <View style={[
                styles.innerContainer,
                { maxWidth: layout.maxWidth }
            ]}>
                {/* Autocomplete suggestions overlay */}
                {suggestions.length > 0 && (
                    <View style={[
                        styles.autocompleteOverlay,
                        { paddingHorizontal: screenWidth > 700 ? 0 : 8 }
                    ]}>
                        <AgentInputAutocomplete
                            suggestions={suggestions.map(s => {
                                const Component = s.component;
                                return <Component key={s.key} />;
                            })}
                            selectedIndex={selected}
                            onSelect={handleSuggestionSelect}
                            itemHeight={48}
                        />
                    </View>
                )}

                {/* What the "% left" segment measures (#646). Account quota when
                    the daemon can read it — the limits page's own source — and
                    the conversation's context only as a fallback. */}
                {showUsage && (
                    <>
                        <TouchableWithoutFeedback onPress={() => setShowUsage(false)}>
                            <View style={styles.overlayBackdrop} />
                        </TouchableWithoutFeedback>
                        <View style={[
                            styles.settingsOverlay,
                            { paddingHorizontal: screenWidth > 700 ? 0 : 8 }
                        ]}>
                            <FloatingOverlay maxHeight={340} keyboardShouldPersistTaps="always">
                                <View style={styles.overlaySection}>
                                    <Text style={styles.overlaySectionTitle}>
                                        {limits?.rows.length ? t('agentInput.limits.title') : t('agentInput.context.title')}
                                    </Text>
                                    <View style={{ paddingHorizontal: 16, paddingBottom: 8 }}>
                                        {limits?.rows.length ? (
                                            // One row per quota window, worst first — the one about to
                                            // bite is the one you opened this to see.
                                            [...limits.rows]
                                                .sort((a, b) => b.usedPercent - a.usedPercent)
                                                .map((row) => {
                                                    const pct = Math.max(0, Math.min(100, row.usedPercent));
                                                    const resets = limitResetLabel(row.resetsAt);
                                                    const hot = pct >= 90 ? theme.colors.warningCritical : pct >= 80 ? theme.colors.warning : theme.colors.success;
                                                    return (
                                                        <View key={row.id} style={{ paddingVertical: 6 }}>
                                                            <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 }}>
                                                                <Text style={{ fontSize: 13, color: theme.colors.text, ...Typography.default() }}>{limitWindowName(row)}</Text>
                                                                <Text style={{ fontSize: 13, color: theme.colors.text, ...Typography.default() }}>{Math.round(100 - pct)}% left</Text>
                                                            </View>
                                                            <View style={{ height: 6, borderRadius: 3, backgroundColor: theme.colors.divider, overflow: 'hidden' }}>
                                                                <View style={{ width: `${pct}%`, height: '100%', backgroundColor: hot }} />
                                                            </View>
                                                            {!!resets && (
                                                                <Text style={{ fontSize: 11, color: theme.colors.textSecondary, marginTop: 3, ...Typography.default() }}>{resets}</Text>
                                                            )}
                                                        </View>
                                                    );
                                                })
                                        ) : props.usageData ? (
                                            // No quota reading (machine offline, or the daemon could not
                                            // read its credentials): fall back to the context tokens.
                                            <>
                                                <Text style={{ fontSize: 11, color: theme.colors.textSecondary, marginBottom: 8, ...Typography.default() }}>
                                                    {t('agentInput.limits.unavailable')}
                                                </Text>
                                                {([
                                                    [t('agentInput.context.used'), formatTokens(props.usageData.contextSize)],
                                                    [t('agentInput.context.input'), props.usageData.inputTokens.toLocaleString()],
                                                    [t('agentInput.context.output'), props.usageData.outputTokens.toLocaleString()],
                                                    [t('agentInput.context.cacheRead'), props.usageData.cacheRead.toLocaleString()],
                                                    [t('agentInput.context.cacheWrite'), props.usageData.cacheCreation.toLocaleString()],
                                                ] as Array<[string, string]>).map(([label, value]) => (
                                                    <View key={label} style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 3 }}>
                                                        <Text style={{ fontSize: 13, color: theme.colors.textSecondary, ...Typography.default() }}>{label}</Text>
                                                        <Text style={{ fontSize: 13, color: theme.colors.text, ...Typography.default() }}>{value}</Text>
                                                    </View>
                                                ))}
                                            </>
                                        ) : (
                                            <Text style={{ fontSize: 13, color: theme.colors.textSecondary, ...Typography.default() }}>
                                                {t('agentInput.limits.unavailable')}
                                            </Text>
                                        )}
                                    </View>
                                </View>
                            </FloatingOverlay>
                        </View>
                    </>
                )}

                {/* Settings overlay — one list at a time (SessionSettingsPanel). */}
                {showSettings && hasSettingsSections && (
                    <>
                        <TouchableWithoutFeedback onPress={() => setShowSettings(false)}>
                            <View style={styles.overlayBackdrop} />
                        </TouchableWithoutFeedback>
                        <View style={[
                            styles.settingsOverlay,
                            { paddingHorizontal: screenWidth > 700 ? 0 : 8 }
                        ]}>
                            <SessionSettingsPanel
                                sections={settingsSections}
                                onSelect={handleSettingsChoice}
                                onClose={() => setShowSettings(false)}
                                maxHeight={settingsMaxHeight}
                                backLabel={t('common.back')}
                            />
                        </View>
                    </>
                )}

                <AgentInputStatusRow
                    connectionStatus={props.connectionStatus}
                    contextWarning={quotaWarning ?? contextWarning}
                    displayPermissionMode={displayPermissionMode}
                    permissionModeKey={permissionModeKey}
                    isSandboxedYoloMode={isSandboxedYoloMode}
                    permissionLabel={displayPermissionMode ? withSandboxSuffix(displayPermissionMode.name, permissionModeKey) : null}
                    modelLabel={modelLabel}
                    agentLabel={props.metadata?.flavor ?? props.agentType ?? 'claude'}
                    effortLabel={props.effortLevel?.name ?? null}
                    costUsd={props.costUsd}
                    zenMode={props.zenMode}
                    onStatusPress={props.onStatusPress}
                    onSettingsPress={handleSettingsPress}
                    onUsagePress={(limits?.rows.length || props.usageData) ? handleUsagePress : undefined}
                />

                <AgentInputContextChips
                    machineName={props.machineName}
                    onMachineClick={props.onMachineClick}
                    currentPath={props.currentPath}
                    onPathClick={props.onPathClick}
                />

                {/* Box 2: Action Area (Input + Send) */}
                <Shaker ref={sendBlockShakerRef}>
                <View style={styles.unifiedPanel}>
                    {/* Attachment preview strip */}
                    {props.selectedImages && props.selectedImages.length > 0 && (
                        <AgentInputAttachmentStrip
                            images={props.selectedImages}
                            onRemove={props.onRemoveImage ?? (() => {})}
                        />
                    )}
                    {/* Input field */}
                    <View style={[styles.inputContainer, props.minHeight ? { minHeight: props.minHeight } : undefined]}>
                        <MultiTextInput
                            ref={inputRef}
                            defaultValue={props.initialValue}
                            paddingTop={Platform.OS === 'web' ? 10 : 8}
                            paddingBottom={Platform.OS === 'web' ? 10 : 8}
                            fontSize={inputFontSize}
                            lineHeight={inputLineHeight}
                            onChangeText={handleTextChange}
                            placeholder={props.placeholder}
                            onKeyPress={handleKeyPress}
                            onStateChange={handleInputStateChange}
                            maxHeight={inputMaxHeight}
                        />
                    </View>

                    {/* Action buttons below input */}
                    <View style={styles.actionButtonsContainer}>
                        <View style={{ flexDirection: 'column', flex: 1, gap: 2 }}>
                            {/* Row 1: Settings, Profile (FIRST), Agent, Abort, Git Status */}
                            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                                {props.zenMode && <View style={{ flex: 1 }} />}
                                {!props.zenMode && <View style={styles.actionButtonsLeft}>

                                {/* The settings cog lived here. Removed (#649): the
                                    agent · model · effort · permission line right
                                    above opens the same overlay, and it names what
                                    the overlay changes — a second, wordless door to
                                    the same room was just clutter. Both were shown
                                    under identical conditions (not zen mode), so
                                    nothing is stranded by dropping this one. */}

                                {/* Image picker / attach button. NOTE: this group is
                                    overflow:hidden, so on very narrow screens the tail of
                                    the row clips first — order here is deliberate. */}
                                {props.onPickImages && (
                                    <Pressable
                                        onPress={props.onPickImages}
                                        hitSlop={{ top: 5, bottom: 10, left: 4, right: 4 }}
                                        style={(p) => ({
                                            flexDirection: 'row',
                                            alignItems: 'center',
                                            borderRadius: Platform.select({ default: 16, android: 20 }),
                                            paddingHorizontal: 4,
                                            paddingVertical: 6,
                                            justifyContent: 'center',
                                            height: 32,
                                            opacity: p.pressed ? 0.7 : 1,
                                        })}
                                    >
                                        <Ionicons
                                            name="attach-outline"
                                            size={18}
                                            color={theme.colors.button.secondary.tint}
                                        />
                                    </Pressable>
                                )}

                                {/* Agent selector button */}
                                {props.agentType && props.onAgentClick && (
                                    <Pressable
                                        onPress={() => {
                                            hapticsLight();
                                            props.onAgentClick?.();
                                        }}
                                        hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
                                        style={(p) => ({
                                            flexDirection: 'row',
                                            alignItems: 'center',
                                            borderRadius: Platform.select({ default: 16, android: 20 }),
                                            paddingHorizontal: 10,
                                            paddingVertical: 6,
                                            justifyContent: 'center',
                                            height: 32,
                                            opacity: p.pressed ? 0.7 : 1,
                                            gap: 6,
                                        })}
                                    >
                                        <Octicons
                                            name="cpu"
                                            size={14}
                                            color={theme.colors.button.secondary.tint}
                                        />
                                        <Text style={{
                                            fontSize: 13,
                                            color: theme.colors.button.secondary.tint,
                                            fontWeight: '600',
                                            ...Typography.default('semiBold'),
                                        }}>
                                            {props.agentType === 'claude' ? t('agentInput.agent.claude') : props.agentType === 'codex' ? t('agentInput.agent.codex') : props.agentType === 'openclaw' ? t('agentInput.agent.openclaw') : props.agentType === 'opencode' ? t('agentInput.agent.opencode') : t('agentInput.agent.gemini')}
                                        </Text>
                                    </Pressable>
                                )}

                                {/* Git Status Badge */}
                                <GitStatusButton sessionId={props.sessionId} onPress={props.onFileViewerPress} />

                                {/* Stash current input as an on-device draft — lives in the
                                    old abort slot; abort itself now takes over the SEND button
                                    (square icon) while a turn is processing. */}
                                {props.onSaveDraft && hasText && (
                                    <Pressable
                                        onPress={props.onSaveDraft}
                                        hitSlop={{ top: 5, bottom: 10, left: 4, right: 4 }}
                                        accessibilityRole="button"
                                        accessibilityLabel="Save draft"
                                        style={(p) => ({
                                            flexDirection: 'row',
                                            alignItems: 'center',
                                            borderRadius: Platform.select({ default: 16, android: 20 }),
                                            paddingHorizontal: 4,
                                            paddingVertical: 6,
                                            justifyContent: 'center',
                                            height: 32,
                                            opacity: p.pressed ? 0.7 : 1,
                                        })}
                                    >
                                        <Ionicons
                                            name="save-outline"
                                            size={18}
                                            color={theme.colors.button.secondary.tint}
                                        />
                                    </Pressable>
                                )}
                                </View>}

                                {/* Send/Voice button - aligned with first row. While a turn is
                                    processing and the box is empty it becomes the ABORT button
                                    (square icon, ChatGPT-style); typing text flips it back to
                                    send so mid-turn queueing stays one tap. */}
                                <Shaker ref={shakerRef}>
                                <View
                                    style={[
                                        styles.sendButton,
                                        isSendBlocked ? styles.sendButtonLocked :
                                        (abortMode || hasText || hasImages || props.isSending || showMic)
                                            ? styles.sendButtonActive
                                            : styles.sendButtonInactive
                                    ]}
                                >
                                    <Pressable
                                        style={(p) => ({
                                            width: '100%',
                                            height: '100%',
                                            alignItems: 'center',
                                            justifyContent: 'center',
                                            opacity: p.pressed ? 0.7 : 1,
                                        })}
                                        hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
                                        onPress={abortMode ? handleAbortPress : handleSendPress}
                                        disabled={abortMode ? isAborting : !canPressSendButton}
                                        accessibilityLabel={abortMode ? t('common.stop') : undefined}
                                        testID={abortMode ? 'composer-abort-button' : undefined}
                                    >
                                        {abortMode ? (
                                            isAborting ? (
                                                <ActivityIndicator
                                                    size="small"
                                                    color={theme.colors.button.primary.tint}
                                                />
                                            ) : (
                                                <Ionicons
                                                    name="stop"
                                                    size={16}
                                                    color={theme.colors.button.primary.tint}
                                                />
                                            )
                                        ) : props.isSending ? (
                                            <ActivityIndicator
                                                size="small"
                                                color={theme.colors.button.primary.tint}
                                            />
                                        ) : isSendBlocked ? (
                                            <Ionicons
                                                name="lock-closed"
                                                size={15}
                                                color={theme.colors.textSecondary}
                                            />
                                        ) : (hasText || hasImages) ? (
                                            // An attached image with no text is a sendable draft:
                                            // handleSendPress sends it, so the slot must show send,
                                            // not the microphone that would be tapped to start voice
                                            // and send the image instead (#196).
                                            <Octicons
                                                name="arrow-up"
                                                size={16}
                                                color={theme.colors.button.primary.tint}
                                                style={[
                                                    styles.sendButtonIcon,
                                                    { marginTop: Platform.OS === 'web' ? 2 : 0 }
                                                ]}
                                            />
                                        ) : showMic ? (
                                            <Image
                                                source={require('@/assets/images/icon-voice-white.png')}
                                                style={{ width: 24, height: 24 }}
                                                tintColor={theme.colors.button.primary.tint}
                                            />
                                        ) : (
                                            <Octicons
                                                name="arrow-up"
                                                size={16}
                                                color={theme.colors.button.primary.tint}
                                                style={[
                                                    styles.sendButtonIcon,
                                                    { marginTop: Platform.OS === 'web' ? 2 : 0 }
                                                ]}
                                            />
                                        )}
                                    </Pressable>
                                </View>
                                </Shaker>
                            </View>
                        </View>
                    </View>
                </View>
                </Shaker>
            </View>
        </View>
    );
}));

// Git Status Button Component
function GitStatusButton({ sessionId, onPress }: { sessionId?: string, onPress?: () => void }) {
    const hasMeaningfulGitStatus = useHasMeaningfulGitStatus(sessionId || '');
    const styles = stylesheet;
    const { theme } = useUnistyles();

    if (!sessionId || !onPress) {
        return null;
    }

    return (
        <Pressable
            style={(p) => ({
                flexDirection: 'row',
                alignItems: 'center',
                borderRadius: Platform.select({ default: 16, android: 20 }),
                paddingHorizontal: 8,
                paddingVertical: 6,
                height: 32,
                opacity: p.pressed ? 0.7 : 1,
                flex: 1,
                overflow: 'hidden',
            })}
            hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
            onPress={() => {
                hapticsLight();
                onPress?.();
            }}
        >
            {hasMeaningfulGitStatus ? (
                <GitStatusBadge sessionId={sessionId} />
            ) : (
                <Octicons
                    name="git-branch"
                    size={16}
                    color={theme.colors.button.secondary.tint}
                />
            )}
        </Pressable>
    );
}
