import * as React from 'react';
import { ActivityIndicator, View, Pressable } from 'react-native';
import { Text } from '@/components/StyledText';
import { useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { ItemList } from '@/components/ItemList';
import { Modal } from '@/modal';
import { machineReadLog, type JoyLogMessage } from '@/sync/ops';
import { Typography } from '@/constants/Typography';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

const PREVIEW_LIMIT = 10;

// Preview the last few back-and-forth messages of a single transcript log.
export default React.memo(function JoyLogViewScreen() {
    const { machine, dir, sessionId } = useLocalSearchParams<{ machine: string; dir: string; sessionId: string }>();
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const [messages, setMessages] = React.useState<JoyLogMessage[] | null>(null);
    const [error, setError] = React.useState<string | null>(null);

    React.useEffect(() => {
        let cancelled = false;
        if (!machine || !dir || !sessionId) { setError('Missing parameters'); return; }
        setMessages(null);
        setError(null);
        machineReadLog(machine, dir, sessionId, PREVIEW_LIMIT)
            .then((r) => { if (!cancelled) setMessages(r); })
            .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); });
        return () => { cancelled = true; };
    }, [machine, dir, sessionId]);

    const copyId = React.useCallback(async () => {
        if (!sessionId) return;
        await Clipboard.setStringAsync(sessionId);
        Modal.alert('Copied', 'Session ID copied to clipboard');
    }, [sessionId]);

    return (
        <ItemList>
            <Pressable style={styles.idCard} onPress={copyId}>
                <View style={{ flex: 1 }}>
                    <Text style={styles.idLabel}>SESSION ID</Text>
                    <Text style={styles.idValue} numberOfLines={1}>{sessionId}</Text>
                </View>
                <Ionicons name="copy-outline" size={20} color={theme.colors.textSecondary} />
            </Pressable>

            <Text style={styles.sectionTitle}>{`LAST ${PREVIEW_LIMIT} MESSAGES`}</Text>

            {error ? (
                <Text style={styles.errorText}>{error}</Text>
            ) : messages === null ? (
                <View style={{ paddingVertical: 32, alignItems: 'center' }}>
                    <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                </View>
            ) : messages.length === 0 ? (
                <Text style={styles.emptyText}>No messages in this log.</Text>
            ) : (
                messages.map((m, i) => (
                    <View key={i} style={styles.message}>
                        <View style={styles.messageHeader}>
                            <Text style={[styles.role, m.role === 'user' ? styles.roleUser : styles.roleAgent]}>
                                {m.role === 'user' ? 'You' : 'Claude'}
                            </Text>
                            {m.ts != null && (
                                <Text style={styles.timestamp}>{new Date(m.ts).toLocaleString()}</Text>
                            )}
                        </View>
                        <Text style={styles.messageText}>{m.text}</Text>
                    </View>
                ))
            )}
        </ItemList>
    );
});

const stylesheet = StyleSheet.create((theme) => ({
    idCard: {
        flexDirection: 'row',
        alignItems: 'center',
        marginHorizontal: 16,
        marginTop: 16,
        paddingHorizontal: 16,
        paddingVertical: 12,
        borderRadius: 12,
        backgroundColor: theme.colors.surface,
    },
    idLabel: {
        fontSize: 11,
        color: theme.colors.textSecondary,
        letterSpacing: 0.5,
        ...Typography.default('semiBold'),
    },
    idValue: {
        fontSize: 14,
        color: theme.colors.text,
        marginTop: 2,
        ...Typography.mono(),
    },
    sectionTitle: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        letterSpacing: 0.5,
        marginTop: 24,
        marginBottom: 8,
        marginHorizontal: 32,
        ...Typography.default('semiBold'),
    },
    message: {
        marginHorizontal: 16,
        marginBottom: 1,
        paddingHorizontal: 16,
        paddingVertical: 12,
        backgroundColor: theme.colors.surface,
    },
    messageHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: 4,
    },
    role: {
        fontSize: 13,
        ...Typography.default('semiBold'),
    },
    roleUser: {
        color: theme.colors.text,
    },
    roleAgent: {
        color: '#34C759',
    },
    timestamp: {
        fontSize: 11,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
    messageText: {
        fontSize: 14,
        lineHeight: 20,
        color: theme.colors.text,
        ...Typography.default(),
    },
    errorText: {
        color: theme.colors.textDestructive,
        fontSize: 14,
        marginHorizontal: 24,
        marginTop: 8,
    },
    emptyText: {
        color: theme.colors.textSecondary,
        fontSize: 14,
        marginHorizontal: 24,
        marginTop: 8,
    },
}));
