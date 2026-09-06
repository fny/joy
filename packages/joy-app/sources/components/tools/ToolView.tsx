import * as React from 'react';
import { encodePathParam } from '@/utils/pathParam';
import { Text, View, TouchableOpacity, ActivityIndicator, Platform } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import Ionicons from '@expo/vector-icons/Ionicons';
import Octicons from '@expo/vector-icons/Octicons';
import { getToolViewComponent } from './views/_all';
import { Message, ToolCall } from '@/sync/typesMessage';
import { CodeView } from '../CodeView';
import { ToolSectionView } from './ToolSectionView';
import { useElapsedTime } from '@/hooks/useElapsedTime';
import { useToolsCollapsed } from '@/hooks/useToolsCollapsed';
import { Metadata } from '@/sync/storageTypes';
import { useRouter } from 'expo-router';
import { PermissionFooter } from './PermissionFooter';
import { t } from '@/text';
import { getTerminalToolCommand, shouldRenderToolCardHeader } from '@/utils/toolDisplay';
import { getToolModel, safeStringify } from '@/sync/toolModel';
import { describeTool, primaryFilePath } from './toolPresentation';
import { ToolOutcomeView } from './ToolOutcomeView';

interface ToolViewProps {
    metadata: Metadata | null;
    tool: ToolCall;
    messages?: Message[];
    onPress?: () => void;
    sessionId?: string;
    messageId?: string;
}

/**
 * Compact tool card. Presentation-only: every fact it shows (title, status
 * icon, failure text, output) comes from the canonical model and the safe
 * `describeTool` facts, so a malformed record renders as a raw fallback and a
 * failure classified by the model shows the same way in every card.
 */
export const ToolView = React.memo<ToolViewProps>((props) => {
    const { tool, onPress, sessionId, messageId } = props;
    const router = useRouter();
    const { theme } = useUnistyles();
    const model = getToolModel(tool);
    const presentation = describeTool(tool, props.metadata, props.messages);

    // Global collapse-all (session header button) + per-card override. The
    // override resets whenever the global toggles (nonce bump) so the button
    // always wins the next round.
    const globalCollapsed = useToolsCollapsed((s) => s.collapsed);
    const collapseNonce = useToolsCollapsed((s) => s.nonce);
    const [collapseOverride, setCollapseOverride] = React.useState<boolean | null>(null);
    React.useEffect(() => { setCollapseOverride(null); }, [collapseNonce]);
    const isCollapsed = collapseOverride ?? globalCollapsed;

    // For file-editing tools, navigate to file route instead of message detail
    const fileEditTools = ['Edit', 'MultiEdit', 'Write'];
    const isFileEditTool = fileEditTools.includes(tool.name);
    const filePath = isFileEditTool ? primaryFilePath(tool) : null;

    // Create default onPress handler for navigation
    const handlePress = React.useCallback(() => {
        if (onPress) {
            onPress();
        } else if (sessionId && filePath) {
            router.push(`/session/${sessionId}/file?path=${encodePathParam(filePath)}`);
        } else if (sessionId && messageId) {
            router.push(`/session/${sessionId}/message/${messageId}`);
        }
    }, [onPress, sessionId, messageId, filePath, router]);

    // joy mod 08 (permanent): "Open file" affordance for Read tools.
    // Read has no SpecificToolView, so this renders in the default content branch.
    const readFilePath = tool.name === 'Read' ? primaryFilePath(tool) : null;
    const handleOpenReadFile = React.useCallback(() => {
        if (!sessionId || !readFilePath) return;
        router.push(`/session/${sessionId}/file?path=${encodePathParam(readFilePath)}`);
    }, [sessionId, readFilePath, router]);

    // Enable pressable if either onPress is provided or we have navigation params
    const isPressable = !!(onPress || (sessionId && filePath) || (sessionId && messageId));

    // Internal Claude Code tools (e.g. ToolSearch) are completely hidden from the UI
    if (presentation.hidden) {
        return null;
    }

    let minimal = presentation.minimal;
    const { status, subtitle: description, noStatus, hideDefaultError } = presentation;
    const toolTitle = presentation.title;

    let icon: React.ReactNode = <Ionicons name="construct-outline" size={18} color={theme.colors.textSecondary} />;
    if (tool.name.startsWith('mcp__')) {
        icon = <Ionicons name="extension-puzzle-outline" size={18} color={theme.colors.textSecondary} />;
    } else if (tool.name === 'CodexBash' && model.command && model.command.operations.length === 1) {
        // A single harness-parsed operation picks the icon for what it does.
        const operation = model.command.operations[0];
        if (operation.kind === 'read') {
            icon = <Octicons name="eye" size={18} color={theme.colors.text} />;
        } else if (operation.kind === 'write') {
            icon = <Octicons name="file-diff" size={18} color={theme.colors.text} />;
        } else {
            icon = <Octicons name="terminal" size={18} color={theme.colors.text} />;
        }
    } else if (presentation.icon) {
        icon = presentation.icon(18, theme.colors.text);
    }

    // The status icon follows the model's OUTCOME. A denial or an interruption
    // is muted; an ordinary failure (Claude wraps those in <tool_use_error>
    // too) is a warning with its reason kept, never a cancellation.
    let statusIcon: React.ReactNode = null;
    switch (model.outcome) {
        case 'pending':
            if (!noStatus) {
                statusIcon = <ActivityIndicator size="small" color={theme.colors.text} style={{ transform: [{ scaleX: 0.8 }, { scaleY: 0.8 }] }} />;
            }
            break;
        case 'failed':
            statusIcon = <Ionicons name="alert-circle-outline" size={20} color={theme.colors.warning} />;
            break;
        case 'cancelled':
        case 'denied':
            statusIcon = <Ionicons name="remove-circle-outline" size={20} color={theme.colors.textSecondary} />;
            break;
        case 'succeeded':
            break;
    }

    const terminalCommand = getTerminalToolCommand(tool);
    const isCompactTerminalTool = terminalCommand !== null;
    const isInlineCodexPatch = Platform.OS === 'web' && tool.name === 'CodexPatch';
    // The inline web patch normally has no card header; while collapsed it
    // needs one, or there is nothing left to expand it with.
    const renderCardHeader = shouldRenderToolCardHeader(tool.name, Platform.OS) || isCollapsed;
    const permissionFooter = tool.permission && sessionId && tool.name !== 'AskUserQuestion'
        ? <PermissionFooter permission={tool.permission} sessionId={sessionId} toolName={tool.name} toolInput={tool.input} metadata={props.metadata} />
        : null;
    // The footer travels into the inline patch view only when that view is
    // shown; a collapsed body must never take the approval controls with it.
    const footerInsidePatch = isInlineCodexPatch && !isCollapsed && !minimal;

    const renderHeaderContent = () => {
        if (isCompactTerminalTool) {
            return (
                <View style={styles.compactHeaderLeft}>
                    <View style={styles.compactIconContainer}>
                        {icon}
                    </View>
                    <Text style={styles.compactToolName} numberOfLines={1}>{toolTitle}</Text>
                    {status ? <Text style={styles.compactStatus} numberOfLines={1}>{status}</Text> : null}
                    <Text style={styles.compactCommandText} numberOfLines={1}>
                        {terminalCommand}
                    </Text>
                    {model.outcome === 'pending' ? (
                        <View style={styles.elapsedContainer}>
                            <ElapsedView from={tool.createdAt} />
                        </View>
                    ) : null}
                    {statusIcon}
                </View>
            );
        }

        return (
            <View style={styles.headerLeft}>
                <View style={styles.iconContainer}>
                    {icon}
                </View>
                <View style={styles.titleContainer}>
                    <Text style={styles.toolName} numberOfLines={1}>{toolTitle}{status ? <Text style={styles.status}>{` ${status}`}</Text> : null}</Text>
                    {description ? (
                        <Text style={styles.toolDescription} numberOfLines={1}>
                            {description}
                        </Text>
                    ) : null}
                </View>
                {model.outcome === 'pending' ? (
                    <View style={styles.elapsedContainer}>
                        <ElapsedView from={tool.createdAt} />
                    </View>
                ) : null}
                {statusIcon}
            </View>
        );
    };

    // Per-card collapse chevron — only where there's content to hide.
    const collapseChevron = (!minimal && !isCompactTerminalTool) ? (
        <TouchableOpacity
            onPress={() => setCollapseOverride(!isCollapsed)}
            hitSlop={10}
            activeOpacity={0.6}
            accessibilityRole="button"
            accessibilityLabel={isCollapsed ? 'Expand tool output' : 'Collapse tool output'}
        >
            <Ionicons name={isCollapsed ? 'chevron-forward' : 'chevron-down'} size={14} color={theme.colors.textSecondary} />
        </TouchableOpacity>
    ) : null;

    const renderBody = () => {
        // A minimal card has no body — unless it failed: the reason must
        // still be visible somewhere.
        if (minimal || isCompactTerminalTool || isCollapsed) {
            if (!hideDefaultError && !isCollapsed && (model.outcome === 'failed')) {
                return (
                    <View style={styles.content}>
                        <ToolOutcomeView model={model} mode="compact" />
                    </View>
                );
            }
            return null;
        }

        // Try to use a specific tool view component first
        const SpecificToolView = getToolViewComponent(tool.name);
        if (SpecificToolView) {
            return (
                <View style={styles.content}>
                    <SpecificToolView
                        tool={tool}
                        metadata={props.metadata}
                        messages={props.messages ?? []}
                        sessionId={sessionId}
                        permissionFooter={footerInsidePatch ? permissionFooter : undefined}
                    />
                    {!hideDefaultError ? <ToolOutcomeView model={model} mode="compact" /> : null}
                </View>
            );
        }

        // Fall back to default view: arguments, then the outcome (failure
        // reason, or every result block).
        const hasInput = model.arguments.ok
            ? Object.keys(model.arguments.value).length > 0
            : (model.raw.input !== undefined && model.raw.input !== null);
        return (
            <View style={styles.content}>
                {hasInput ? (
                    <ToolSectionView title={t('toolView.input')}>
                        <CodeView code={model.arguments.ok ? safeStringify(model.arguments.value) : safeStringify(model.raw.input)} />
                    </ToolSectionView>
                ) : null}

                {readFilePath && sessionId ? (
                    <ToolSectionView>
                        <TouchableOpacity
                            style={styles.openFileButton}
                            onPress={handleOpenReadFile}
                            activeOpacity={0.7}
                        >
                            <Ionicons name="open-outline" size={16} color={theme.colors.button.primary.tint} />
                            <Text style={styles.openFileButtonText}>{t('toolView.openFile')}</Text>
                        </TouchableOpacity>
                    </ToolSectionView>
                ) : null}

                <ToolOutcomeView model={model} mode="full" />
            </View>
        );
    };

    return (
        <View style={isCompactTerminalTool ? styles.compactContainer : isInlineCodexPatch ? styles.inlineContainer : styles.container}>
            {renderCardHeader ? (
                isPressable ? (
                    <TouchableOpacity style={isCompactTerminalTool ? styles.compactHeader : styles.header} onPress={handlePress} activeOpacity={0.8}>
                        {renderHeaderContent()}
                        {collapseChevron}
                    </TouchableOpacity>
                ) : (
                    <View style={isCompactTerminalTool ? styles.compactHeader : styles.header}>
                        {renderHeaderContent()}
                        {collapseChevron}
                    </View>
                )
            ) : null}

            {renderBody()}

            {/* Permission footer - always renders when permission exists to maintain consistent height */}
            {/* AskUserQuestion has its own Submit button UI - no permission footer needed */}
            {!footerInsidePatch ? permissionFooter : null}
        </View>
    );
});

function ElapsedView(props: { from: number }) {
    const { from } = props;
    const elapsed = useElapsedTime(from);
    return <Text style={styles.elapsedText}>{elapsed.toFixed(1)}s</Text>;
}

const styles = StyleSheet.create((theme) => ({
    container: {
        backgroundColor: theme.colors.surfaceHigh,
        borderRadius: 8,
        marginVertical: 4,
        overflow: 'hidden'
    },
    compactContainer: {
        backgroundColor: 'transparent',
        marginVertical: 1,
        overflow: 'visible',
    },
    inlineContainer: {
        backgroundColor: 'transparent',
        marginVertical: 1,
        overflow: 'visible',
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: 12,
        backgroundColor: theme.colors.surfaceHighest,
    },
    compactHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        minHeight: 28,
        paddingHorizontal: 4,
        paddingVertical: 3,
        borderRadius: 4,
        backgroundColor: 'transparent',
    },
    headerLeft: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        flex: 1,
    },
    iconContainer: {
        width: 24,
        height: 24,
        alignItems: 'center',
        justifyContent: 'center',
    },
    compactHeaderLeft: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        flex: 1,
        minWidth: 0,
    },
    compactIconContainer: {
        width: 18,
        height: 18,
        alignItems: 'center',
        justifyContent: 'center',
    },
    titleContainer: {
        flex: 1,
    },
    elapsedContainer: {
        marginLeft: 8,
    },
    elapsedText: {
        fontSize: 13,
        color: theme.colors.textSecondary,
        fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
    },
    toolName: {
        fontSize: 14,
        fontWeight: '500',
        color: theme.colors.text,
    },
    compactToolName: {
        fontSize: 13,
        lineHeight: 18,
        fontWeight: '500',
        color: theme.colors.text,
        flexShrink: 0,
        maxWidth: 150,
    },
    compactStatus: {
        fontSize: 12,
        lineHeight: 18,
        color: theme.colors.textSecondary,
        flexShrink: 0,
    },
    compactCommandText: {
        flex: 1,
        minWidth: 0,
        fontSize: 13,
        lineHeight: 18,
        color: theme.colors.textSecondary,
        fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
    },
    status: {
        fontWeight: '400',
        opacity: 0.3,
        fontSize: 15,
    },
    toolDescription: {
        fontSize: 13,
        color: theme.colors.textSecondary,
        marginTop: 2,
    },
    content: {
        paddingHorizontal: 12,
        paddingTop: 8,
        overflow: 'visible'
    },
    openFileButton: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingHorizontal: 12,
        paddingVertical: 8,
        borderRadius: 6,
        backgroundColor: theme.colors.button.primary.background,
        alignSelf: 'flex-start',
    },
    openFileButtonText: {
        color: theme.colors.button.primary.tint,
        fontSize: 13,
        fontWeight: '600',
    },
}));
