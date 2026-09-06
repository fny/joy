import * as React from 'react';
import { ToolViewProps } from './_all';
import { Text, View, ActivityIndicator, Platform } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { ToolCall } from '@/sync/typesMessage';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import { getToolModel, ToolOutcome } from '@/sync/toolModel';
import { describeChildTool } from '../toolPresentation';
import { MarkdownView } from '@/components/markdown/MarkdownView';
import { MessageView } from '@/components/MessageView';
import { ToolResultBlockView } from '../ToolOutcomeView';
import { toolFullViewStyles } from '../ToolFullView';

interface ChildRow {
    tool: ToolCall;
    title: string;
    outcome: ToolOutcome;
}

const PREVIEW_ROWS = 3;

function childRows(messages: ToolViewProps['messages'], metadata: ToolViewProps['metadata']): ChildRow[] {
    const rows: ChildRow[] = [];
    for (const m of messages) {
        if (m.kind !== 'tool-call') continue;
        rows.push({
            tool: m.tool,
            // Safe: a child with `input: null` gets its name, not a thrown card.
            title: describeChildTool(m.tool, metadata),
            outcome: getToolModel(m.tool).outcome,
        });
    }
    return rows;
}

function ChildOutcomeIcon({ outcome }: { outcome: ToolOutcome }) {
    const { theme } = useUnistyles();
    switch (outcome) {
        case 'pending':
            return <ActivityIndicator size={Platform.OS === 'ios' ? "small" : 14 as any} color={theme.colors.warning} />;
        case 'succeeded':
            return <Ionicons name="checkmark-circle" size={16} color={theme.colors.success} />;
        case 'failed':
            return <Ionicons name="close-circle" size={16} color={theme.colors.textDestructive} />;
        case 'cancelled':
        case 'denied':
            return <Ionicons name="remove-circle" size={16} color={theme.colors.textSecondary} />;
    }
}

/**
 * Compact Task / Agent card: the last few sub-tool calls. `slice(max(0, n-3))`
 * — the previous negative slice hid one of two children.
 */
export const TaskView = React.memo<ToolViewProps>(({ metadata, messages }) => {
    const rows = childRows(messages, metadata);

    if (rows.length === 0) {
        return null;
    }

    const visibleRows = rows.slice(Math.max(0, rows.length - PREVIEW_ROWS));
    const remainingCount = Math.max(0, rows.length - PREVIEW_ROWS);

    return (
        <View style={styles.container}>
            {visibleRows.map((item, index) => (
                <View key={`${item.tool.name}-${index}`} style={styles.toolItem}>
                    <Text style={styles.toolTitle}>{item.title}</Text>
                    <View style={styles.statusContainer}>
                        <ChildOutcomeIcon outcome={item.outcome} />
                    </View>
                </View>
            ))}
            {remainingCount > 0 ? (
                <View style={styles.moreToolsItem}>
                    <Text style={styles.moreToolsText}>
                        {t('tools.taskView.moreTools', { count: remainingCount })}
                    </Text>
                </View>
            ) : null}
        </View>
    );
});

/**
 * Full Task / Agent details: the prompt, the subagent's actual conversation —
 * its explanations and every nested tool card with its controls and results,
 * not only title rows (#298) — and its answer, every result block: a mixed
 * text / image answer keeps its image next to its markdown.
 */
export const TaskViewFull = React.memo<ToolViewProps>(({ tool, metadata, messages, sessionId }) => {
    const model = getToolModel(tool);
    const prompt = model.arguments.value.prompt;
    // Thinking rows render as nothing; they must not open an empty section.
    const conversation = messages.filter((m) => !(m.kind === 'agent-text' && (m.isThinking || m.text.trim().length === 0)));
    const answerBlocks = model.outcome === 'succeeded' ? model.blocks : [];

    return (
        <View>
            {typeof prompt === 'string' && prompt.trim().length > 0 ? (
                <View style={toolFullViewStyles.section}>
                    <Text style={styles.sectionTitle}>{t('tools.detail.prompt')}</Text>
                    <MarkdownView markdown={prompt} sessionId={sessionId} />
                </View>
            ) : null}
            {conversation.length > 0 ? (
                <View style={toolFullViewStyles.section}>
                    <Text style={styles.sectionTitle}>{t('tools.detail.subTools')}</Text>
                    <View style={styles.conversation}>
                        {conversation.map((message) => (
                            <MessageView
                                key={message.id}
                                message={message}
                                metadata={metadata}
                                sessionId={sessionId ?? ''}
                            />
                        ))}
                    </View>
                </View>
            ) : null}
            {answerBlocks.length > 0 ? (
                <View style={toolFullViewStyles.section}>
                    <Text style={styles.sectionTitle}>{t('tools.detail.answer')}</Text>
                    <View style={styles.answerBlocks}>
                        {answerBlocks.map((block, index) => (
                            block.kind === 'text'
                                ? <MarkdownView key={index} markdown={block.text} sessionId={sessionId} />
                                : <ToolResultBlockView key={index} block={block} />
                        ))}
                    </View>
                </View>
            ) : null}
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: {
        paddingVertical: 4,
        paddingBottom: 12
    },
    sectionTitle: {
        fontSize: 13,
        fontWeight: '600',
        color: theme.colors.textSecondary,
        marginBottom: 6,
        textTransform: 'uppercase',
    },
    toolItem: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: 4,
        paddingLeft: 4,
        paddingRight: 2
    },
    toolTitle: {
        fontSize: 14,
        fontWeight: '500',
        color: theme.colors.textSecondary,
        fontFamily: 'monospace',
        flex: 1,
    },
    statusContainer: {
        marginLeft: 'auto',
        paddingLeft: 8,
    },
    moreToolsItem: {
        paddingVertical: 4,
        paddingHorizontal: 4,
    },
    conversation: {
        gap: 4,
    },
    answerBlocks: {
        gap: 8,
    },
    moreToolsText: {
        fontSize: 14,
        color: theme.colors.textSecondary,
        fontStyle: 'italic',
        opacity: 0.7,
    },
}));
