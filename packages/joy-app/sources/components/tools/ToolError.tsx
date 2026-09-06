import { Text, View } from "react-native";
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import Ionicons from '@expo/vector-icons/Ionicons';
import { parseToolUseError } from '@/utils/toolErrorParser';

interface ToolErrorProps {
    message: string;
    /** `error` for a failure (red), `muted` for a denial / interruption. */
    tone?: 'error' | 'muted';
    /** Short label shown before the reason (e.g. "Cancelled"). */
    label?: string | null;
}

export function ToolError(props: ToolErrorProps) {
    const { theme } = useUnistyles();
    const tone = props.tone ?? 'error';
    const { isToolUseError, errorMessage } = parseToolUseError(props.message);
    const displayMessage = isToolUseError && errorMessage ? errorMessage : props.message;
    const muted = tone === 'muted';

    return (
        <View style={[styles.errorContainer, muted && styles.mutedContainer]}>
            <Ionicons
                name={muted ? 'remove-circle-outline' : 'warning'}
                size={16}
                color={muted ? theme.colors.textSecondary : theme.colors.box.warning.text}
            />
            <Text style={[styles.errorText, muted && styles.mutedText]}>
                {props.label ? <Text style={styles.label}>{props.label}{displayMessage ? ' — ' : ''}</Text> : null}
                {displayMessage}
            </Text>
        </View>
    )
}

const styles = StyleSheet.create((theme) => ({
    errorContainer: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 8,
        backgroundColor: theme.colors.box.error.background,
        borderRadius: 6,
        padding: 12,
        borderWidth: 1,
        borderColor: theme.colors.box.error.border,
        marginBottom: 12,
        maxHeight: 115,
        overflow: 'hidden',
    },
    mutedContainer: {
        backgroundColor: theme.colors.surfaceHigh,
        borderColor: theme.colors.divider,
    },
    errorText: {
        fontSize: 13,
        color: theme.colors.box.error.text,
        flex: 1,
    },
    mutedText: {
        color: theme.colors.textSecondary,
    },
    label: {
        fontWeight: '600',
    },
}));
