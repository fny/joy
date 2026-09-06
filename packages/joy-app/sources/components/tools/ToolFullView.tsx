import * as React from 'react';
import { encodePathParam } from '@/utils/pathParam';
import { Text, View, ScrollView, Platform, TouchableOpacity, useWindowDimensions } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { ToolCall, Message } from '@/sync/typesMessage';
import { CodeView } from '../CodeView';
import { Metadata } from '@/sync/storageTypes';
import { getToolFullViewComponent } from './views/_all';
import { layout } from '../layout';
import { useLocalSetting } from '@/sync/storage';
import { useRouter } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import { getToolModel, safeStringify } from '@/sync/toolModel';
import { primaryFilePath } from './toolPresentation';
import { ToolOutcomeView } from './ToolOutcomeView';

interface ToolFullViewProps {
    tool: ToolCall;
    metadata?: Metadata | null;
    messages?: Message[];
    sessionId?: string;
}

/**
 * Full-screen tool details. The specialized view (diff, terminal, task) shows
 * the tool's own material; the outcome — failure reason, denial, interruption,
 * or every result block — is ALWAYS rendered here from the canonical model, so
 * a failed Edit or MultiEdit no longer hides why it failed behind its proposed
 * diff, and a structured error never collapses to "[object Object]".
 */
export function ToolFullView({ tool, metadata, messages = [], sessionId }: ToolFullViewProps) {
    // Check if there's a specialized content view for this tool
    const SpecializedFullView = getToolFullViewComponent(tool.name);
    const screenWidth = useWindowDimensions().width;
    const devModeEnabled = (useLocalSetting('devModeEnabled') || __DEV__);
    const { theme } = useUnistyles();
    const router = useRouter();
    const model = getToolModel(tool);
    // Mod 08 (Read → Open file) is permanent — the button always shows for Read calls.
    const readFilePath = tool.name === 'Read' ? primaryFilePath(tool) : null;
    const showOpenFileButton = Boolean(readFilePath && sessionId);
    const handleOpenReadFile = React.useCallback(() => {
        if (!sessionId || !readFilePath) return;
        router.push(`/session/${sessionId}/file?path=${encodePathParam(readFilePath)}`);
    }, [sessionId, readFilePath, router]);

    const hasInput = model.arguments.ok
        ? Object.keys(model.arguments.value).length > 0
        : (model.raw.input !== undefined && model.raw.input !== null);
    const hasFailure = model.outcome === 'failed' || model.outcome === 'denied' || model.outcome === 'cancelled';
    const hasOutput = model.outcome === 'succeeded' && model.blocks.length > 0;
    const isEmptyCompletion = model.outcome === 'succeeded' && model.blocks.length === 0;

    return (
        <ScrollView style={[styles.container, { paddingHorizontal: screenWidth > 700 ? 16 : 0 }]}>
            <View style={styles.contentWrapper}>
                {SpecializedFullView ? (
                    <>
                        <SpecializedFullView tool={tool} metadata={metadata || null} messages={messages} sessionId={sessionId} />
                        {hasFailure ? (
                            <View style={styles.section}>
                                <View style={styles.sectionHeader}>
                                    <Ionicons name="close-circle" size={20} color="#FF3B30" />
                                    <Text style={styles.sectionTitle}>{t('tools.fullView.error')}</Text>
                                </View>
                                <ToolOutcomeView model={model} mode="compact" />
                            </View>
                        ) : null}
                    </>
                ) : (
                    <>
                    {/* Generic fallback for tools without specialized views */}
                    {/* Tool Description */}
                    {tool.description ? (
                        <View style={styles.section}>
                            <View style={styles.sectionHeader}>
                                <Ionicons name="information-circle" size={20} color="#5856D6" />
                                <Text style={styles.sectionTitle}>{t('tools.fullView.description')}</Text>
                            </View>
                            <Text style={styles.description}>{tool.description}</Text>
                        </View>
                    ) : null}
                    {/* Input Parameters */}
                    {hasInput ? (
                        <View style={styles.section}>
                            <View style={styles.sectionHeader}>
                                <Ionicons name="log-in" size={20} color="#5856D6" />
                                <Text style={styles.sectionTitle}>{t('tools.fullView.inputParams')}</Text>
                            </View>
                            <CodeView code={model.arguments.ok ? safeStringify(model.arguments.value) : safeStringify(model.raw.input)} />
                        </View>
                    ) : null}

                    {showOpenFileButton ? (
                        <View style={styles.section}>
                            <TouchableOpacity
                                style={[styles.openFileButton, { backgroundColor: theme.colors.button.primary.background }]}
                                onPress={handleOpenReadFile}
                                activeOpacity={0.7}
                            >
                                <Ionicons name="open-outline" size={16} color={theme.colors.button.primary.tint} />
                                <Text style={[styles.openFileButtonText, { color: theme.colors.button.primary.tint }]}>{t('toolView.openFile')}</Text>
                            </TouchableOpacity>
                        </View>
                    ) : null}

                    {/* Result / Output — every block, including 0 / false / "" */}
                    {hasOutput ? (
                        <View style={styles.section}>
                            <View style={styles.sectionHeader}>
                                <Ionicons name="log-out" size={20} color="#34C759" />
                                <Text style={styles.sectionTitle}>{t('tools.fullView.output')}</Text>
                            </View>
                            <ToolOutcomeView model={model} mode="full" titled={false} />
                        </View>
                    ) : null}

                    {/* Error / denial / interruption details */}
                    {hasFailure ? (
                        <View style={styles.section}>
                            <View style={styles.sectionHeader}>
                                <Ionicons name="close-circle" size={20} color="#FF3B30" />
                                <Text style={styles.sectionTitle}>{t('tools.fullView.error')}</Text>
                            </View>
                            <ToolOutcomeView model={model} mode="compact" />
                        </View>
                    ) : null}

                    {/* No Output Message */}
                    {isEmptyCompletion ? (
                        <View style={styles.section}>
                            <View style={styles.emptyOutputContainer}>
                                <Ionicons name="checkmark-circle-outline" size={48} color="#34C759" />
                                <Text style={styles.emptyOutputText}>{t('tools.fullView.completed')}</Text>
                                <Text style={styles.emptyOutputSubtext}>{t('tools.fullView.noOutput')}</Text>
                            </View>
                        </View>
                    ) : null}

                </>
                )}

                {/* Raw JSON View (Dev Mode Only) */}
                {devModeEnabled ? (
                    <View style={styles.section}>
                        <View style={styles.sectionHeader}>
                            <Ionicons name="code-slash" size={20} color="#FF9500" />
                            <Text style={styles.sectionTitle}>{t('tools.fullView.rawJsonDevMode')}</Text>
                        </View>
                        <CodeView
                            code={safeStringify({
                                name: tool.name,
                                state: tool.state,
                                outcome: model.outcome,
                                identity: model.identity,
                                description: tool.description,
                                input: tool.input,
                                result: tool.result,
                                createdAt: tool.createdAt,
                                startedAt: tool.startedAt,
                                completedAt: tool.completedAt,
                                permission: tool.permission,
                                messages
                            })}
                        />
                    </View>
                ) : null}
            </View>
        </ScrollView>
    );
}

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.surface,
        paddingTop: 12,
    },
    contentWrapper: {
        maxWidth: layout.maxWidth,
        alignSelf: 'center',
        width: '100%',
    },
    section: {
        marginBottom: 28,
        paddingHorizontal: 4,
    },
    sectionFullWidth: {
        marginBottom: 28,
        paddingHorizontal: 0,
    },
    sectionHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        marginBottom: 12,
        gap: 8,
    },
    sectionTitle: {
        fontSize: 17,
        fontWeight: '600',
        color: theme.colors.text,
    },
    description: {
        fontSize: 14,
        lineHeight: 20,
        color: theme.colors.textSecondary,
    },
    toolId: {
        fontSize: 12,
        fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' }),
        color: theme.colors.textSecondary,
    },
    errorContainer: {
        backgroundColor: theme.colors.box.error.background,
        borderRadius: 8,
        padding: 16,
        borderWidth: 1,
        borderColor: theme.colors.box.error.border,
    },
    errorText: {
        fontSize: 14,
        color: theme.colors.box.error.text,
        lineHeight: 20,
    },
    emptyOutputContainer: {
        alignItems: 'center',
        paddingVertical: 48,
        gap: 12,
    },
    emptyOutputText: {
        fontSize: 16,
        fontWeight: '600',
        color: theme.colors.text,
    },
    emptyOutputSubtext: {
        fontSize: 14,
        color: theme.colors.textSecondary,
    },
    openFileButton: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingHorizontal: 14,
        paddingVertical: 10,
        borderRadius: 6,
        alignSelf: 'flex-start',
    },
    openFileButtonText: {
        fontSize: 13,
        fontWeight: '600',
    },
}));

// Export styles for use in specialized views
export const toolFullViewStyles = styles;
