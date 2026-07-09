import * as React from 'react';
import { Text, View, StyleSheet, Platform, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { useUnistyles } from 'react-native-unistyles';

interface CommandViewProps {
    command: string;
    prompt?: string;
    stdout?: string | null;
    stderr?: string | null;
    error?: string | null;
    // Legacy prop for backward compatibility
    output?: string | null;
    maxHeight?: number;
    fullWidth?: boolean;
    hideEmptyOutput?: boolean;
}

export const CommandView = React.memo<CommandViewProps>(({
    command,
    prompt = '$',
    stdout,
    stderr,
    error,
    output,
    maxHeight,
    fullWidth,
    hideEmptyOutput,
}) => {
    const { theme } = useUnistyles();
    // Use legacy output if new props aren't provided
    const hasNewProps = stdout !== undefined || stderr !== undefined || error !== undefined;

    const styles = StyleSheet.create({
        container: {
            backgroundColor: theme.colors.terminal.background,
            borderRadius: 8,
            overflow: 'hidden',
            padding: 16,
            alignItems: 'flex-start',
            justifyContent: 'flex-start',
        },
        line: {
            alignItems: 'baseline',
            flexDirection: 'row',
            flexWrap: 'wrap',
        },
        promptText: {
            fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' }),
            fontSize: 14,
            lineHeight: 20,
            color: theme.colors.terminal.prompt,
            fontWeight: '600',
        },
        commandText: {
            fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' }),
            fontSize: 14,
            color: theme.colors.terminal.command,
            lineHeight: 20,
            flex: 1,
        },
        stdout: {
            fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' }),
            fontSize: 13,
            color: theme.colors.terminal.stdout,
            lineHeight: 18,
            marginTop: 8,
        },
        stderr: {
            fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' }),
            fontSize: 13,
            color: theme.colors.terminal.stderr,
            lineHeight: 18,
            marginTop: 8,
        },
        error: {
            fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' }),
            fontSize: 13,
            color: theme.colors.terminal.error,
            lineHeight: 18,
            marginTop: 8,
        },
        emptyOutput: {
            fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' }),
            fontSize: 13,
            color: theme.colors.terminal.emptyOutput,
            lineHeight: 18,
            marginTop: 8,
            fontStyle: 'italic',
        },
    });

    const [copied, setCopied] = React.useState(false);
    const copyTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    React.useEffect(() => () => { if (copyTimer.current) clearTimeout(copyTimer.current); }, []);
    const copyCommand = React.useCallback(() => {
        void Clipboard.setStringAsync(command);
        setCopied(true);
        if (copyTimer.current) clearTimeout(copyTimer.current);
        copyTimer.current = setTimeout(() => setCopied(false), 1500);
    }, [command]);

    return (
        <View style={[
            styles.container, 
            maxHeight ? { maxHeight } : undefined,
            fullWidth ? { width: '100%' } : undefined
        ]}>
            {/* Copy-command affordance — full detail view only, inline chat
                rows stay uncluttered (texts are selectable everywhere). */}
            {fullWidth && (
                <Pressable
                    onPress={copyCommand}
                    hitSlop={10}
                    accessibilityRole="button"
                    accessibilityLabel="Copy command"
                    style={{ position: 'absolute', top: 10, right: 10, zIndex: 1, opacity: 0.85 }}
                >
                    <Ionicons name={copied ? 'checkmark' : 'copy-outline'} size={16} color={copied ? theme.colors.terminal.prompt : theme.colors.terminal.stdout} />
                </Pressable>
            )}
            {/* Command Line */}
            <View style={styles.line}>
                <Text style={styles.promptText}>{prompt} </Text>
                <Text style={styles.commandText} selectable>{command}</Text>
            </View>

            {hasNewProps ? (
                <>
                    {/* Standard Output */}
                    {stdout && stdout.trim() && (
                        <Text style={styles.stdout} selectable>{stdout}</Text>
                    )}

                    {/* Standard Error */}
                    {stderr && stderr.trim() && (
                        <Text style={styles.stderr} selectable>{stderr}</Text>
                    )}

                    {/* Error Message */}
                    {error && (
                        <Text style={styles.error} selectable>{error}</Text>
                    )}

                    {/* Empty output indicator */}
                    {!stdout && !stderr && !error && !hideEmptyOutput && (
                        <Text style={styles.emptyOutput}>[Command completed with no output]</Text>
                    )}
                </>
            ) : (
                /* Legacy output format */
                output && (
                    <Text style={styles.commandText}>{'\n---\n' + output}</Text>
                )
            )}
        </View>
    );
});

