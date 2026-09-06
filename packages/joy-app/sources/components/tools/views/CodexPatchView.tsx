import * as React from 'react';
import { Pressable, View, Text } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import Ionicons from '@expo/vector-icons/Ionicons';
import Octicons from '@expo/vector-icons/Octicons';
import { ToolCall } from '@/sync/typesMessage';
import { ToolSectionView } from '../ToolSectionView';
import { Metadata } from '@/sync/storageTypes';
import { resolvePath } from '@/utils/pathUtils';
import { ToolDiffView } from '@/components/tools/ToolDiffView';
import { getDiffStats, getPatchDiffStats } from '@/components/diff/calculateDiff';
import { t } from '@/text';
import { getToolModel, ToolFileChangeModel, ToolOutcome } from '@/sync/toolModel';
import { ToolOutcomeView } from '../ToolOutcomeView';

interface CodexPatchViewProps {
    tool: ToolCall;
    metadata: Metadata | null;
    permissionFooter?: React.ReactNode;
}

/**
 * Codex / Gemini patch card. Reads the model's file changes (object AND
 * list form, content pairs and rename destinations preserved, null entries
 * isolated), labels a failed or pending patch as a proposal with its reason,
 * and keeps the approval footer OUTSIDE the per-file collapsibles so a
 * pending approval is never hidden inside a collapsed file.
 */
export const CodexPatchView = React.memo<CodexPatchViewProps>(({ tool, metadata, permissionFooter }) => {
    const model = getToolModel(tool);
    const changes = model.fileChanges ?? [];

    if (changes.length === 0 && model.outcome === 'succeeded') {
        return null;
    }

    return (
        <>
            {changes.map((change, index) => (
                <CodexPatchFileView
                    key={`${change.path}-${index}`}
                    change={change}
                    metadata={metadata}
                    outcome={model.outcome}
                />
            ))}
            {model.outcome === 'failed' || model.outcome === 'denied' || model.outcome === 'cancelled' ? (
                <ToolSectionView>
                    <ToolOutcomeView model={model} mode="compact" />
                </ToolSectionView>
            ) : null}
            {permissionFooter ? (
                <View style={styles.permissionFooterContainer}>
                    {permissionFooter}
                </View>
            ) : null}
        </>
    );
});

function kindLabel(change: ToolFileChangeModel): string | null {
    switch (change.kind) {
        case 'add':
            return 'new';
        case 'delete':
            return 'delete';
        case 'move':
            return 'move';
        case 'modify':
            return 'edit';
        default:
            return null;
    }
}

const CodexPatchFileView = React.memo(function CodexPatchFileView(props: {
    change: ToolFileChangeModel;
    metadata: Metadata | null;
    outcome: ToolOutcome;
}) {
    const { change, metadata, outcome } = props;
    const { theme } = useUnistyles();
    const [expanded, setExpanded] = React.useState(false);

    const filePath = resolvePath(change.path, metadata);
    const movePath = change.movePath ? resolvePath(change.movePath, metadata) : null;
    const fileName = change.path.split('/').pop() ?? change.path;
    const hasPair = change.oldText !== null || change.newText !== null;
    const stats = change.patch
        ? getPatchDiffStats(change.patch)
        : hasPair
            ? getDiffStats(change.oldText ?? '', change.newText ?? '')
            : null;
    const label = outcome === 'succeeded'
        ? t('toolGroup.editedFile')
        : t('tools.outcome.proposed');

    return (
        <ToolSectionView fullWidth>
            <View style={styles.editedFileGroup}>
                <Pressable
                    onPress={() => setExpanded((value) => !value)}
                    style={({ pressed }) => [
                        styles.editToggle,
                        pressed && styles.editTogglePressed,
                    ]}
                >
                    <Text style={styles.editToggleText} numberOfLines={1}>
                        {label}{' · '}{fileName}
                    </Text>
                    <Ionicons
                        name={expanded ? 'chevron-down' : 'chevron-forward'}
                        size={14}
                        color={theme.colors.textSecondary}
                    />
                </Pressable>
                {expanded ? (
                    <View style={styles.patchContainer}>
                        <View style={styles.fileHeader}>
                            <View style={styles.fileHeaderMain}>
                                <Octicons name="file-diff" size={16} color={theme.colors.textSecondary} />
                                <Text style={styles.filePath}>{filePath}</Text>
                                {kindLabel(change) ? <Text style={styles.kindLabel}>{kindLabel(change)}</Text> : null}
                                {stats && (stats.additions > 0 || stats.deletions > 0) ? (
                                    <View style={styles.stats}>
                                        {stats.additions > 0 ? <Text style={styles.added}>+{stats.additions}</Text> : null}
                                        {stats.deletions > 0 ? <Text style={styles.removed}>-{stats.deletions}</Text> : null}
                                    </View>
                                ) : null}
                            </View>
                            {movePath ? <Text style={styles.movePath}>{movePath}</Text> : null}
                        </View>
                        {change.patch ? (
                            <ToolDiffView patch={change.patch} fileName={fileName} />
                        ) : hasPair && ((change.oldText ?? '').length > 0 || (change.newText ?? '').length > 0) ? (
                            <ToolDiffView
                                oldText={change.oldText ?? ''}
                                newText={change.newText ?? ''}
                                fileName={fileName}
                            />
                        ) : null}
                    </View>
                ) : null}
            </View>
        </ToolSectionView>
    );
});

const styles = StyleSheet.create((theme) => ({
    editedFileGroup: {
        gap: 6,
    },
    editToggle: {
        flexDirection: 'row',
        alignItems: 'center',
        alignSelf: 'flex-start',
        gap: 4,
        maxWidth: '100%',
        paddingHorizontal: 14,
        paddingTop: 2,
        paddingBottom: 4,
    },
    editTogglePressed: {
        opacity: 0.6,
    },
    editToggleText: {
        flexShrink: 1,
        fontSize: 14,
        color: theme.colors.textSecondary,
    },
    patchContainer: {
        backgroundColor: theme.colors.surface,
        overflow: 'hidden',
        marginHorizontal: 14,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: theme.colors.divider,
    },
    permissionFooterContainer: {
        paddingHorizontal: 12,
        paddingTop: 8,
    },
    fileHeader: {
        paddingHorizontal: 16,
        paddingVertical: 10,
        backgroundColor: theme.colors.surfaceHigh,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.divider,
        gap: 4,
    },
    fileHeaderMain: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    filePath: {
        fontSize: 13,
        color: theme.colors.text,
        fontFamily: 'monospace',
        flex: 1,
    },
    kindLabel: {
        fontSize: 11,
        color: theme.colors.textSecondary,
        textTransform: 'uppercase',
        letterSpacing: 0.6,
    },
    movePath: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        fontFamily: 'monospace',
    },
    stats: {
        flexDirection: 'row',
        gap: 8,
    },
    added: {
        fontSize: 12,
        fontFamily: 'monospace',
        color: '#34C759',
    },
    removed: {
        fontSize: 12,
        fontFamily: 'monospace',
        color: '#FF3B30',
    },
}));
