import * as React from 'react';
import { View, Pressable } from 'react-native';
import { Text } from '@/components/StyledText';
import Ionicons from '@expo/vector-icons/Ionicons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useSession } from '@/sync/storage';
import { sync } from '@/sync/sync';
import { tunnelJson } from '@/sync/v2/tunnel';
import { t } from '@/text';
import { Typography } from '@/constants/Typography';

// joy-tmux surfaces a codex approval request (non-yolo: the agent wants to run
// a command or apply a patch) as session.metadata.joy__codexApproval. Pinned
// bar with Allow / Deny; the answer rides the sealed tunnel to the daemon.
// The daemon holds the codex request open until answered (or a timeout).
export const CodexApprovalBar = React.memo(function CodexApprovalBar({ sessionId }: { sessionId: string }) {
    const { theme } = useUnistyles();
    const session = useSession(sessionId);
    const approval = session?.metadata?.joy__codexApproval;
    const machineId = session?.metadata?.machineId;
    const joyId = session?.metadata?.joy__sessionId;
    const [answering, setAnswering] = React.useState(false);

    const answer = React.useCallback((decision: 'allow' | 'deny') => {
        if (!machineId || !joyId || !approval) return;
        setAnswering(true);
        // The answer rides the sealed tunnel to the daemon's approvals route.
        const ctx = sync.machineCtxFor(machineId, joyId);
        if (!ctx) { console.error('[v2] approval dropped: no machine context'); setAnswering(false); return; }
        tunnelJson({
            relayUrl: ctx.relayUrl, accountToken: ctx.accountToken, machineKey: ctx.machineKey,
            machineId: ctx.machineId, method: 'POST', path: `/v2/sessions/${joyId}/approvals`,
            json: { requestId: approval.requestId, decision },
        })
            .catch(() => { /* daemon re-pushes metadata; the bar reflects it */ })
            .finally(() => setAnswering(false));
    }, [machineId, joyId, approval]);

    if (!approval) return null;

    return (
        <View style={[styles.bar, { backgroundColor: theme.colors.surface, borderBottomColor: theme.colors.divider }]}>
            <View style={styles.row}>
                <Ionicons name={approval.kind === 'patch' ? 'git-branch-outline' : 'terminal-outline'} size={16} color="#FF9500" style={{ marginRight: 8 }} />
                <Text style={[styles.label, { color: theme.colors.textSecondary }]}>{t('codexApproval.label')}</Text>
                <Text style={[styles.title, { color: theme.colors.text }]} numberOfLines={2}>{approval.title}</Text>
            </View>
            {!!approval.detail && (
                <Text style={[styles.detail, { color: theme.colors.textSecondary }]} numberOfLines={2}>{approval.detail}</Text>
            )}
            <View style={styles.actions}>
                <Pressable disabled={answering} onPress={() => answer('deny')} style={(p) => [styles.pill, { backgroundColor: 'rgba(255,69,58,0.12)', opacity: p.pressed ? 0.7 : 1 }]}>
                    <Text style={[styles.pillText, { color: theme.colors.deleteAction }]}>{t('codexApproval.deny')}</Text>
                </Pressable>
                <Pressable disabled={answering} onPress={() => answer('allow')} style={(p) => [styles.pill, { backgroundColor: 'rgba(52,199,89,0.14)', opacity: p.pressed ? 0.7 : 1 }]}>
                    <Text style={[styles.pillText, { color: theme.colors.success }]}>{t('codexApproval.allow')}</Text>
                </Pressable>
            </View>
        </View>
    );
});

const styles = StyleSheet.create(() => ({
    bar: { paddingHorizontal: 14, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, gap: 6 },
    row: { flexDirection: 'row', alignItems: 'center' },
    label: { fontSize: 10, marginRight: 8, ...Typography.default('semiBold') },
    title: { flex: 1, fontSize: 13, ...Typography.default('semiBold') },
    detail: { fontSize: 12, ...Typography.default() },
    actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 2 },
    pill: { paddingHorizontal: 16, paddingVertical: 6, borderRadius: 8 },
    pillText: { fontSize: 13, ...Typography.default('semiBold') },
}));
