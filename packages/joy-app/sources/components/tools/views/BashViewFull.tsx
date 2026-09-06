import * as React from 'react';
import { View, ScrollView, StyleSheet } from 'react-native';
import { ToolCall } from '@/sync/typesMessage';
import { Metadata } from '@/sync/storageTypes';
import { CommandView } from '@/components/CommandView';
import { getToolModel } from '@/sync/toolModel';

interface BashViewFullProps {
    tool: ToolCall;
    metadata: Metadata | null;
}

/**
 * Full terminal details. Reads the command model, so a FAILED command with a
 * structured `{stdout, stderr}` result shows both streams plus the failure
 * instead of "[Command completed with no output]".
 */
export const BashViewFull = React.memo<BashViewFullProps>(({ tool }) => {
    const model = getToolModel(tool);
    const command = model.command;
    const failed = model.outcome === 'failed' || model.outcome === 'denied' || model.outcome === 'cancelled';
    const stdout = command?.stdout ?? (failed ? null : model.outputText);
    const stderr = command?.stderr ?? null;
    // The failure reason is shown once: when it is already the stderr text,
    // CommandView's error line would only repeat it.
    const error = failed && model.errorMessage !== stderr ? model.errorMessage : (failed && !stderr ? model.errorMessage : null);

    return (
        <View style={styles.container}>
            <View style={styles.terminalContainer}>
                <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={true}
                    contentContainerStyle={styles.scrollContent}
                >
                    <View style={styles.commandWrapper}>
                        <CommandView
                            command={command?.command ?? ''}
                            stdout={stdout}
                            stderr={stderr}
                            error={error}
                            fullWidth
                        />
                    </View>
                </ScrollView>
            </View>
        </View>
    );
});

const styles = StyleSheet.create({
    container: {
        paddingHorizontal: 0,
        paddingTop: 32,
        paddingBottom: 64,
        marginBottom: 0,
        flex: 1,
    },
    terminalContainer: {
        flex: 1,
    },
    scrollContent: {
        flexGrow: 1,
    },
    commandWrapper: {
        flex: 1,
        minWidth: '100%',
    },
});
