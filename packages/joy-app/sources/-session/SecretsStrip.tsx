import * as React from 'react';
import { View } from 'react-native';
import { Text } from '@/components/StyledText';
import Ionicons from '@expo/vector-icons/Ionicons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { storage } from '@/sync/storage';
import { useResource } from '@/hooks/useResource';
import { sessionSecretsSpec } from '@/sync/machineResources';
import { parseSecretsMessage, secretsPreview } from '@/utils/secretsMessage';

// Above the message box while it holds secrets (```secrets block or /secrets
// line): each name, marked new or replaces against the names already saved
// for the session, and any line that will not parse. The values themselves
// stay in the box; on send they go to the machine and never into the chat.
export const SecretsStrip = React.memo(function SecretsStrip({ sessionId, message }: { sessionId: string; message: string }) {
    const { theme } = useUnistyles();
    const parsed = React.useMemo(() => parseSecretsMessage(message), [message]);
    const machineId = storage((s) => s.sessions[sessionId]?.metadata?.machineId);
    const joySessionId = storage((s) => s.sessions[sessionId]?.metadata?.joy__sessionId);
    // Only asked for while secrets are being typed: an ordinary message never
    // costs a round trip.
    const spec = parsed && machineId && joySessionId ? sessionSecretsSpec(machineId, joySessionId) : null;
    const saved = useResource(spec, { enabled: !!spec });
    if (!parsed) return null;
    const preview = secretsPreview(parsed.secrets, saved.data ?? null);
    if (preview.length === 0 && parsed.invalid.length === 0) return null;
    return (
        <View style={styles.wrap}>
            <View style={styles.header}>
                <Ionicons name="lock-closed" size={12} color={theme.colors.textSecondary} />
                <Text style={styles.headerText}>{t('secrets.stripTitle')}</Text>
            </View>
            <View style={styles.chips}>
                {preview.map((p) => (
                    <View key={p.name} style={styles.chip}>
                        <Text style={styles.chipName}>{p.name}</Text>
                        <Text style={[styles.chipTag, p.replaces ? styles.replaces : styles.isNew]}>
                            {/* Unknown until the saved names load: say nothing rather than guess. */}
                            {saved.data ? (p.replaces ? t('secrets.replaces') : t('secrets.new')) : ''}
                        </Text>
                    </View>
                ))}
            </View>
            {parsed.invalid.length > 0 && (
                <Text style={styles.invalid}>{t('secrets.invalid', { lines: parsed.invalid.join(', ') })}</Text>
            )}
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    wrap: { marginBottom: 8, gap: 6, paddingHorizontal: 8 },
    header: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 20 },
    headerText: { fontSize: 11, letterSpacing: 0.4, color: theme.colors.textSecondary, ...Typography.default('semiBold') },
    chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
    chip: {
        flexDirection: 'row', alignItems: 'center', gap: 6,
        paddingHorizontal: 10, paddingVertical: 4, borderRadius: 10,
        backgroundColor: theme.colors.input.background,
    },
    chipName: { fontSize: 13, color: theme.colors.text, ...Typography.mono() },
    chipTag: { fontSize: 11, ...Typography.default('semiBold') },
    isNew: { color: theme.colors.success },
    replaces: { color: '#FF9500' }, // the theme's warning is a grey: a replaced value should stand out
    invalid: { fontSize: 12, color: theme.colors.textDestructive, ...Typography.default() },
}));
