// Machine page specific to joy-tmux: the daemon's live status (version, PID,
// uptime, OS, claude CLI) fetched over joy-status, plus links into the joy
// surfaces for this machine. The stock /machine/[id] page stays for
// happy-daemon machines.
//
// Personal-build dev page — plain strings, no i18n (matches the /joy pages).
import * as React from 'react';
import { View, Text, ActivityIndicator } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { useMachine } from '@/sync/storage';
import { isMachineOnline } from '@/utils/machineUtils';
import { formatOSPlatform } from '@/utils/sessionUtils';
import { apiSocket } from '@/sync/apiSocket';
import { Typography } from '@/constants/Typography';
import { useUnistyles } from 'react-native-unistyles';

type JoyStatus = {
    ok?: boolean;
    version?: string;
    uptimeMs?: number;
    sessions?: number;
    messages?: number;
    clients?: number;
    pid?: number;
    os?: { platform?: string; release?: string; arch?: string; hostname?: string };
    claude?: { available: boolean; version: string | null };
};

function formatUptime(ms: number): string {
    const m = Math.floor(ms / 60000);
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ${m % 60}m`;
    return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export default React.memo(function JoyMachineScreen() {
    const { theme } = useUnistyles();
    const router = useRouter();
    const { id } = useLocalSearchParams<{ id: string }>();
    const machine = useMachine(id ?? '');
    const online = machine ? isMachineOnline(machine) : false;

    const [status, setStatus] = React.useState<JoyStatus | null>(null);
    const [failed, setFailed] = React.useState(false);
    React.useEffect(() => {
        if (!id || !online) {
            setFailed(!online);
            return;
        }
        let cancelled = false;
        Promise.race([
            apiSocket.machineRPC<JoyStatus, {}>(id, 'joy-status', {}),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
        ]).then(s => { if (!cancelled) setStatus(s); })
            .catch(() => { if (!cancelled) setFailed(true); });
        return () => { cancelled = true; };
    }, [id, online]);

    const machineName = machine?.metadata?.displayName || machine?.metadata?.host || 'machine';

    if (!status && !failed) {
        return (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 }}>
                <ActivityIndicator />
                <Text style={{ color: theme.colors.textSecondary, fontSize: 14, ...Typography.default() }}>
                    asking the joy-tmux daemon…
                </Text>
            </View>
        );
    }

    return (
        <ItemList style={{ paddingTop: 0 }}>
            <ItemGroup
                title={machineName}
                footer={failed ? (online ? 'The joy-tmux daemon did not respond on this machine.' : 'Machine is offline.') : undefined}
            >
                <Item
                    title="Daemon"
                    detail={status?.ok ? 'running' : 'unreachable'}
                    icon={<Ionicons name="pulse-outline" size={29} color={status?.ok ? '#34C759' : '#FF3B30'} />}
                    showChevron={false}
                />
                {status?.version && (
                    <Item title="joy-tmux Version" detail={status.version} icon={<Ionicons name="pricetag-outline" size={29} color="#FF2D55" />} showChevron={false} />
                )}
                {status?.pid != null && (
                    <Item title="Process ID" detail={String(status.pid)} icon={<Ionicons name="hardware-chip-outline" size={29} color="#FF2D55" />} showChevron={false} />
                )}
                {status?.uptimeMs != null && (
                    <Item title="Uptime" detail={formatUptime(status.uptimeMs)} icon={<Ionicons name="time-outline" size={29} color="#FF2D55" />} showChevron={false} />
                )}
                {status?.os && (
                    <Item
                        title="Operating System"
                        subtitle={`${formatOSPlatform(status.os.platform ?? '')} ${status.os.release ?? ''} (${status.os.arch ?? '?'})`}
                        icon={<Ionicons name="desktop-outline" size={29} color="#5856D6" />}
                        showChevron={false}
                    />
                )}
                {status?.claude && (
                    <Item
                        title="Claude CLI"
                        detail={status.claude.available ? (status.claude.version ?? 'available') : 'not found'}
                        icon={<Ionicons name="sparkles-outline" size={29} color={status.claude.available ? '#9C27B0' : '#FF3B30'} />}
                        showChevron={false}
                    />
                )}
                {status?.sessions != null && (
                    <Item title="Active Sessions" detail={String(status.sessions)} icon={<Ionicons name="layers-outline" size={29} color="#007AFF" />} showChevron={false} />
                )}
            </ItemGroup>

            {machine?.metadata?.homeDir && (
                <ItemGroup title="Machine">
                    <Item title="Host" subtitle={machine.metadata.host} icon={<Ionicons name="server-outline" size={29} color="#5856D6" />} showChevron={false} />
                    <Item title="Home" subtitle={machine.metadata.homeDir} icon={<Ionicons name="home-outline" size={29} color="#5856D6" />} showChevron={false} />
                </ItemGroup>
            )}

            <ItemGroup title="Go to">
                <Item
                    title="Joy Sessions"
                    subtitle="Manage joy-tmux sessions on this machine"
                    icon={<Ionicons name="terminal-outline" size={29} color="#007AFF" />}
                    onPress={() => router.push('/settings/joy-sessions')}
                />
                <Item
                    title="New joy-tmux Session"
                    icon={<Ionicons name="add-circle-outline" size={29} color="#007AFF" />}
                    onPress={() => router.push({ pathname: '/joy/new', params: id ? { machineId: id } : {} })}
                />
                <Item
                    title="Codeburn"
                    subtitle="Usage and cost for this machine"
                    icon={<Ionicons name="flame-outline" size={29} color="#FF6B35" />}
                    onPress={() => router.push('/settings/codeburn')}
                />
                <Item
                    title="Stock Machine Page"
                    subtitle="The happy-daemon view of this machine"
                    icon={<Ionicons name="server-outline" size={29} color="#8E8E93" />}
                    onPress={() => router.push(`/machine/${id}`)}
                />
            </ItemGroup>
        </ItemList>
    );
});
