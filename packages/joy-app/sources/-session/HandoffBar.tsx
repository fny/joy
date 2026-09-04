import * as React from 'react';
import { View, Pressable } from 'react-native';
import { Text } from '@/components/StyledText';
import Ionicons from '@expo/vector-icons/Ionicons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useSession, useAllSessions } from '@/sync/storage';
import { sync } from '@/sync/sync';
import { machineHandback } from '@/sync/v2/machine';
import { useJoyAction } from '@/hooks/useJoyAction';
import { useNavigateToSession } from '@/hooks/useNavigateToSession';
import { JoyError } from '@/utils/errors';
import { t } from '@/text';
import { Typography } from '@/constants/Typography';

// The handoff state of a session, published by the daemon as
// session.metadata.joy__handoff (domain/handoff.ts). One bar, five states:
//   writing     — this session is writing its handoff note (source or target)
//   handed_off  — this session's work went to `peer`; tap to open it
//   picked_up   — this session picked up `peer`'s work; Hand back button
//   handed_back — `peer` handed the work back here
//   returned    — this session handed its work back to `peer`
//   failed      — the note never landed; the error says why
export const HandoffBar = React.memo(function HandoffBar({ sessionId }: { sessionId: string }) {
    const { theme } = useUnistyles();
    const session = useSession(sessionId);
    const navigateToSession = useNavigateToSession();
    const h = session?.metadata?.joy__handoff;

    // Reactive: the peer's card can arrive AFTER this bar first renders.
    const sessions = useAllSessions();
    const peerAppId = React.useMemo(() => {
        if (!h?.peer) return null;
        const hit = sessions.find((s) => (s.metadata as { joy__sessionId?: string } | undefined)?.joy__sessionId === h.peer);
        return hit?.id ?? null;
    }, [h?.peer, sessions]);

    const [handingBack, handBack] = useJoyAction(async () => {
        const machineId = session?.metadata?.machineId;
        const localId = session?.metadata?.joy__sessionId;
        if (!machineId || !localId) throw new JoyError('No machine context for this session', false);
        const ctx = sync.machineOnlyCtx(machineId);
        if (!ctx) throw new JoyError('Machine is offline', false);
        const r = await machineHandback(ctx, localId);
        if (!r.data?.ok) throw new JoyError(r.data?.error || 'Hand back failed', false);
    });

    if (!h) return null;
    const peer = h.peerLabel ?? h.peer ?? '';
    let icon: keyof typeof Ionicons.glyphMap = 'swap-horizontal';
    let text = '';
    switch (h.state) {
        case 'writing': icon = 'create-outline'; text = t('handoff.writing', { peer }); break;
        case 'handed_off': icon = 'arrow-forward-circle'; text = t('handoff.handedOff', { peer }); break;
        case 'picked_up': icon = 'download-outline'; text = t('handoff.pickedUp', { peer }); break;
        case 'handed_back': icon = 'arrow-back-circle'; text = t('handoff.handedBack', { peer }); break;
        case 'returned': icon = 'checkmark-circle-outline'; text = t('handoff.returned', { peer }); break;
        case 'failed': icon = 'warning-outline'; text = t('handoff.failed', { error: h.error ?? '' }); break;
        default: return null;
    }
    const canOpen = !!peerAppId && (h.state === 'handed_off' || h.state === 'picked_up' || h.state === 'handed_back' || h.state === 'returned');
    return (
        <View style={[styles.bar, { backgroundColor: theme.colors.surface, borderBottomColor: theme.colors.divider }]}>
            <Ionicons name={icon} size={16} color={h.state === 'failed' ? '#FF3B30' : theme.colors.textLink} style={{ marginRight: 8 }} />
            <Pressable style={{ flex: 1 }} disabled={!canOpen} onPress={() => { if (peerAppId) navigateToSession(peerAppId); }} hitSlop={6}>
                <Text style={[styles.label, { color: theme.colors.textSecondary }]}>{t('handoff.label')}</Text>
                <Text style={[styles.text, { color: theme.colors.text }]} numberOfLines={2}>{text}{canOpen ? ` · ${t('handoff.open')}` : ''}</Text>
            </Pressable>
            {h.state === 'picked_up' && (
                <Pressable onPress={handBack} disabled={handingBack} hitSlop={8} style={(p) => [styles.action, { opacity: p.pressed || handingBack ? 0.6 : 1, borderColor: theme.colors.textLink }]}>
                    <Text style={[styles.actionText, { color: theme.colors.textLink }]}>{t('handoff.handBack')}</Text>
                </Pressable>
            )}
        </View>
    );
});

const styles = StyleSheet.create(() => ({
    bar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth },
    label: { fontSize: 11, letterSpacing: 0.4, textTransform: 'uppercase', ...Typography.default('semiBold') },
    text: { fontSize: 14, ...Typography.default() },
    action: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 4, marginLeft: 8 },
    actionText: { fontSize: 13, ...Typography.default('semiBold') },
}));
