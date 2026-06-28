// Machines settings page — lists every box running the joy-tmux daemon.
// Extracted from the inline list that used to live on the main settings page;
// the main page now links here with a single "Machines" button.
import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';
import { useRouter } from 'expo-router';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { useJoyMachines } from '@/hooks/useJoyMachines';

export default React.memo(function MachinesSettingsScreen() {
    const router = useRouter();
    const { theme } = useUnistyles();
    const { machines: joyMachines } = useJoyMachines();

    return (
        <ItemList style={{ paddingTop: 0 }}>
            {joyMachines.length > 0 ? (
                <ItemGroup>
                    {joyMachines.map((machine) => {
                        const host = machine.metadata?.host || 'Unknown';
                        const displayName = machine.metadata?.displayName;
                        const platform = machine.metadata?.platform || '';
                        const title = displayName || host;
                        let subtitle = displayName && displayName !== host ? host : '';
                        if (platform) subtitle = subtitle ? `${subtitle} • ${platform}` : platform;
                        subtitle = subtitle ? `${subtitle} • joy-tmux` : 'joy-tmux';

                        return (
                            <Item
                                key={machine.id}
                                title={title}
                                subtitle={subtitle}
                                icon={<Ionicons name="terminal-outline" size={29} color={theme.colors.status.connected} />}
                                onPress={() => router.push(`/machine/${machine.id}`)}
                            />
                        );
                    })}
                </ItemGroup>
            ) : (
                <ItemGroup footer="Boxes running the joy-tmux daemon show up here once they connect.">
                    <Item
                        title="No machines connected"
                        icon={<Ionicons name="terminal-outline" size={29} color={theme.colors.textSecondary} />}
                        showChevron={false}
                    />
                </ItemGroup>
            )}

            {/* Manage ALL registered machines (incl. offline) + remembered folders. */}
            <ItemGroup>
                <Item
                    title="Cleanup"
                    subtitle="Manage all registered machines & remembered folders"
                    icon={<Ionicons name="trash-bin-outline" size={29} color={theme.colors.textSecondary} />}
                    onPress={() => router.push('/settings/cleanup')}
                />
            </ItemGroup>
        </ItemList>
    );
});
