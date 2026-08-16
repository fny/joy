import * as React from 'react';
import { View, Text } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { useMachine } from '@/sync/storage';
import { t } from '@/text';

// Thin warning strip under the session header when the session's machine is
// under resource pressure (RAM or disk ≥ 90% used). Queueing weirdness and
// stray-text symptoms correlate with a starved host — surface it where the
// user is actually working instead of burying it in the machine page.
const HOT_PERCENT = 90;

export const MachineResourceBanner = React.memo(function MachineResourceBanner(props: { machineId?: string | null }) {
    const machine = useMachine(props.machineId ?? '');
    const ds = machine?.daemonState as {
        ram?: number; diskFree?: number; diskTotal?: number;
    } | null | undefined;
    if (!ds) return null;
    const diskPct = ds.diskTotal && ds.diskFree != null
        ? Math.max(0, Math.min(100, Math.round((1 - ds.diskFree / ds.diskTotal) * 100)))
        : null;
    const parts: string[] = [];
    if (ds.ram != null && ds.ram >= HOT_PERCENT) parts.push(t('machine.ramHot', { percent: ds.ram }));
    if (diskPct != null && diskPct >= HOT_PERCENT) parts.push(t('machine.diskHot', { percent: diskPct }));
    if (parts.length === 0) return null;
    return (
        <View style={styles.banner}>
            <Text style={styles.text} numberOfLines={1}>{`⚠ ${parts.join(' · ')}`}</Text>
        </View>
    );
});

const styles = StyleSheet.create(() => ({
    banner: {
        backgroundColor: 'rgba(255, 59, 48, 0.14)',
        borderBottomWidth: 1,
        borderBottomColor: 'rgba(255, 59, 48, 0.35)',
        paddingVertical: 4,
        paddingHorizontal: 12,
    },
    text: {
        color: '#FF3B30',
        fontSize: 12,
        fontWeight: '600',
        textAlign: 'center',
    },
}));
