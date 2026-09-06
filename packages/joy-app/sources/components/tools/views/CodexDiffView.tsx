import * as React from 'react';
import { View, Text } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { ToolCall } from '@/sync/typesMessage';
import { ToolSectionView } from '../ToolSectionView';
import { ToolDiffView } from '@/components/tools/ToolDiffView';
import { Metadata } from '@/sync/storageTypes';
import { getPatchDiffStats } from '@/components/diff/calculateDiff';
import { getToolModel } from '@/sync/toolModel';

interface CodexDiffViewProps {
    tool: ToolCall;
    metadata: Metadata | null;
}

/**
 * Codex "current file changes". The model splits a multi-file unified diff
 * into one patch per file, so each file gets its own header and counts instead
 * of every hunk being labelled with the last filename.
 */
export const CodexDiffView = React.memo<CodexDiffViewProps>(({ tool }) => {
    const model = getToolModel(tool);
    const files = React.useMemo(
        () => (model.fileChanges ?? []).filter((change) => typeof change.patch === 'string' && change.patch.length > 0),
        [model.fileChanges],
    );

    if (files.length === 0) return null;

    return (
        <>
            {files.map((file, index) => (
                <CodexDiffFileView key={`${file.path}-${index}`} path={file.path} patch={file.patch!} />
            ))}
        </>
    );
});

const CodexDiffFileView = React.memo<{ path: string; patch: string }>(({ path, patch }) => {
    const stats = React.useMemo(() => getPatchDiffStats(patch), [patch]);
    const fileName = path ? path.split('/').pop() || path : undefined;
    return (
        <>
            {path ? (
                <View style={styles.fileHeader}>
                    <Text style={styles.fileName} numberOfLines={1}>{path}</Text>
                    {stats.additions > 0 || stats.deletions > 0 ? (
                        <DiffStats additions={stats.additions} deletions={stats.deletions} />
                    ) : null}
                </View>
            ) : null}
            <ToolSectionView fullWidth>
                <ToolDiffView patch={patch} fileName={fileName} />
            </ToolSectionView>
        </>
    );
});

const DiffStats = React.memo<{ additions: number; deletions: number }>(({ additions, deletions }) => (
    <View style={styles.stats}>
        {additions > 0 ? <Text style={styles.added}>+{additions}</Text> : null}
        {deletions > 0 ? <Text style={styles.removed}>-{deletions}</Text> : null}
    </View>
));

const styles = StyleSheet.create((theme) => ({
    fileHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: 16,
        paddingVertical: 8,
        backgroundColor: theme.colors.surfaceHigh,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.divider,
    },
    fileName: {
        flex: 1,
        fontSize: 13,
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
