// Usage menu — pick a target before any data is fetched. Aggregating every
// machine ("All") is slow, so nothing loads here; each row navigates to
// /settings/usage/<id> which fetches only that scope.
//
// Personal-build dev page — plain strings, no i18n (matches the /joy pages).
import * as React from 'react';
import { Stack, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';
import { ItemList } from '@/components/ItemList';
import { ItemGroup } from '@/components/ItemGroup';
import { Item } from '@/components/Item';
import { useAllMachines } from '@/sync/storage';
import { isMachineOnline } from '@/utils/machineUtils';

export default React.memo(function UsageMenuScreen() {
    const { theme } = useUnistyles();
    const router = useRouter();
    const machines = useAllMachines({ includeOffline: false }).filter(isMachineOnline);

    return (
        <ItemList>
            <Stack.Screen options={{ headerTitle: 'Usage' }} />
            <ItemGroup footer="Usage is computed on the machine via the joy-tmux daemon. Aggregating all machines can be slow, so it only runs when you pick a target.">
                <Item
                    title="All machines"
                    subtitle="Aggregate across every machine — can be slow"
                    icon={<Ionicons name="albums-outline" size={29} color={theme.colors.accents.blue} />}
                    onPress={() => router.push('/settings/usage/all' as any)}
                />
            </ItemGroup>

            {machines.length > 0 && (
                <ItemGroup title="Machines">
                    {machines.map(m => (
                        <Item
                            key={m.id}
                            title={m.metadata?.displayName || m.metadata?.host || m.id.slice(0, 8)}
                            subtitle={m.metadata?.host || m.id}
                            icon={<Ionicons name="hardware-chip-outline" size={29} color={theme.colors.status.connected} />}
                            onPress={() => router.push(`/settings/usage/${m.id}` as any)}
                        />
                    ))}
                </ItemGroup>
            )}
        </ItemList>
    );
});
