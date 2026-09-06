import * as React from 'react';
import { View, Text } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import Octicons from '@expo/vector-icons/Octicons';
import { ToolCall } from '@/sync/typesMessage';
import { ToolSectionView } from '../ToolSectionView';
import { CommandView } from '@/components/CommandView';
import { Metadata } from '@/sync/storageTypes';
import { resolvePath } from '@/utils/pathUtils';
import { t } from '@/text';
import { getToolModel } from '@/sync/toolModel';
import { ToolOutcomeView } from '../ToolOutcomeView';

interface CodexBashViewProps {
    tool: ToolCall;
    metadata: Metadata | null;
    /** Full-detail mode: the stored result is rendered too. */
    full?: boolean;
}

/**
 * Codex terminal card. The single-file read / write presentation is used only
 * when the harness parsed exactly ONE operation; a compound command
 * (`cat a && cat b`) keeps its complete text. Failures render in every branch,
 * and the full-detail mode shows the stored result.
 */
export const CodexBashView = React.memo<CodexBashViewProps>(({ tool, metadata, full }) => {
    const { theme } = useUnistyles();
    const model = getToolModel(tool);
    const command = model.command;
    const failed = model.outcome === 'failed' || model.outcome === 'denied' || model.outcome === 'cancelled';
    const single = command && command.operations.length === 1 ? command.operations[0] : null;

    let icon: React.ReactNode;
    switch (single?.kind) {
        case 'read':
            icon = <Octicons name="eye" size={18} color={theme.colors.textSecondary} />;
            break;
        case 'write':
            icon = <Octicons name="file-diff" size={18} color={theme.colors.textSecondary} />;
            break;
        default:
            icon = <Octicons name="terminal" size={18} color={theme.colors.textSecondary} />;
    }

    if (single && single.path && (single.kind === 'read' || single.kind === 'write')) {
        const resolvedPath = resolvePath(single.path, metadata);
        const label = single.kind === 'read'
            ? t('tools.desc.readingFile', { file: resolvedPath })
            : t('tools.desc.writingFile', { file: resolvedPath });
        return (
            <>
                <ToolSectionView>
                    <View style={styles.readContainer}>
                        <View style={styles.iconRow}>
                            {icon}
                            <Text style={styles.operationText}>{label}</Text>
                        </View>
                        {single.command ? (
                            <Text style={styles.commandText}>{single.command}</Text>
                        ) : null}
                    </View>
                </ToolSectionView>
                {full && !failed && (command?.stdout || model.outputText) ? (
                    <ToolSectionView title={t('toolView.output')}>
                        <CommandView
                            command={single.command ?? command?.command ?? ''}
                            stdout={command?.stdout ?? model.outputText}
                            stderr={command?.stderr ?? null}
                            error={null}
                            fullWidth
                        />
                    </ToolSectionView>
                ) : null}
                {failed ? <ToolOutcomeView model={model} mode="compact" /> : null}
            </>
        );
    }

    const commandDisplay = command?.command ?? '';
    return (
        <ToolSectionView>
            <CommandView
                command={commandDisplay}
                stdout={full ? (command?.stdout ?? (failed ? null : model.outputText)) : null}
                stderr={full ? (command?.stderr ?? null) : null}
                error={failed ? model.errorMessage : null}
                hideEmptyOutput={!full}
                fullWidth={full}
            />
        </ToolSectionView>
    );
});

/** Registry entry for the full-detail screen. */
export const CodexBashViewFull = React.memo<{ tool: ToolCall; metadata: Metadata | null }>(({ tool, metadata }) => (
    <CodexBashView tool={tool} metadata={metadata} full />
));

const styles = StyleSheet.create((theme) => ({
    readContainer: {
        padding: 12,
        backgroundColor: theme.colors.surfaceHigh,
        borderRadius: 8,
    },
    iconRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    operationText: {
        fontSize: 14,
        color: theme.colors.text,
        fontWeight: '500',
    },
    commandText: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        fontFamily: 'monospace',
        marginTop: 8,
    },
}));
