import * as React from 'react';
import { View, Text } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { ToolSectionView } from '../../tools/ToolSectionView';
import { ToolViewProps } from './_all';
import { CodeView } from '@/components/CodeView';
import { getToolModel } from '@/sync/toolModel';

/**
 * Gemini Execute View — shell commands from Gemini's `execute` tool. The
 * command model strips only the recognized trailing
 * `[current working directory …] (…)` metadata, so `if [ -f x ]; then …`
 * keeps its brackets.
 */
export const GeminiExecuteView = React.memo<ToolViewProps>(({ tool }) => {
    const command = getToolModel(tool).command;

    if (!command) {
        return null;
    }

    return (
        <>
            <ToolSectionView fullWidth>
                <CodeView code={command.command} />
            </ToolSectionView>
            {(command.description || command.cwd) ? (
                <View style={styles.infoContainer}>
                    {command.cwd ? (
                        <Text style={styles.cwdText}>📁 {command.cwd}</Text>
                    ) : null}
                    {command.description ? (
                        <Text style={styles.descriptionText}>{command.description}</Text>
                    ) : null}
                </View>
            ) : null}
        </>
    );
});

const styles = StyleSheet.create((theme) => ({
    infoContainer: {
        paddingHorizontal: 12,
        paddingBottom: 8,
    },
    cwdText: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        marginBottom: 4,
    },
    descriptionText: {
        fontSize: 13,
        color: theme.colors.textSecondary,
        fontStyle: 'italic',
    },
}));
