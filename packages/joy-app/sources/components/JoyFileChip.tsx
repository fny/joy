import * as React from 'react';
import { View, Pressable } from 'react-native';
import { Text } from '@/components/StyledText';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useRouter } from 'expo-router';

/**
 * Inline file link for <joy-file/> tags — the agent points the user at a file
 * (optionally a specific line) and tapping opens the session file viewer,
 * which reads the file over the session's readFile RPC. Rendered as a compact
 * chip: icon, basename (+ :line), and the containing directory in secondary.
 */
export const JoyFileChip = React.memo((props: {
    sessionId: string;
    path: string;
    line: number | null;
    name: string | null;
}) => {
    const { theme } = useUnistyles();
    const router = useRouter();
    const basename = props.path.split('/').pop() || props.path;
    const dir = props.path.slice(0, props.path.length - basename.length).replace(/\/$/, '');
    const label = props.name ?? (props.line ? `${basename}:${props.line}` : basename);

    const onPress = React.useCallback(() => {
        const params = new URLSearchParams({ path: props.path });
        if (props.line) params.set('line', String(props.line));
        router.push(`/session/${props.sessionId}/file?${params.toString()}` as never);
    }, [router, props.sessionId, props.path, props.line]);

    return (
        <Pressable
            onPress={onPress}
            accessibilityRole="link"
            accessibilityLabel={label}
            style={(p) => [styles.chip, { borderColor: theme.colors.divider, backgroundColor: theme.colors.surfaceHigh, opacity: p.pressed ? 0.7 : 1 }]}
        >
            <Ionicons name="document-text-outline" size={16} color={theme.colors.textLink} />
            <View style={{ flexShrink: 1 }}>
                <Text style={[styles.name, { color: theme.colors.textLink }]} numberOfLines={1}>{label}</Text>
                {!!dir && (
                    <Text style={[styles.dir, { color: theme.colors.textSecondary }]} numberOfLines={1}>{dir}</Text>
                )}
            </View>
        </Pressable>
    );
});

const styles = StyleSheet.create(() => ({
    chip: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        alignSelf: 'flex-start',
        maxWidth: 320,
        borderWidth: 1,
        borderRadius: 8,
        paddingHorizontal: 10,
        paddingVertical: 6,
        marginVertical: 4,
    },
    name: {
        fontSize: 13,
        fontWeight: '600',
    },
    dir: {
        fontSize: 11,
    },
}));
