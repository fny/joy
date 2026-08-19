import * as React from 'react';
import { useLocalSearchParams, Stack } from 'expo-router';
import Ionicons from '@expo/vector-icons/Ionicons';
import { ItemList } from '@/components/ItemList';
import { ItemGroup } from '@/components/ItemGroup';
import { Item } from '@/components/Item';
import { useAllSessions, useAllMachines } from '@/sync/storage';
import { ProjectSessionsGroup } from '@/components/ProjectSessionsGroup';
import { useUnistyles } from 'react-native-unistyles';

// Per-machine project browser. Lists every project (cwd) the machine has run a
// session in, each with its session logs (transcripts on disk) + an excerpt of
// the most recent one. Tap a session to preview its last 10 messages; right-
// click (web) / long-press (touch) to copy the session id.
export default React.memo(function MachineProjectsScreen() {
    const { id } = useLocalSearchParams<{ id: string }>();
    const sessions = useAllSessions();
    const machines = useAllMachines({ includeOffline: true });
    const { theme } = useUnistyles();

    const machineName = React.useMemo(() => {
        const m = machines.find((x) => x.id === id);
        return m?.metadata?.displayName || m?.metadata?.host || id;
    }, [machines, id]);

    // Distinct project dirs this machine has sessions in.
    const dirs = React.useMemo(() => {
        const set = new Set<string>();
        for (const s of sessions) {
            if (s.metadata?.machineId !== id) continue;
            const path = s.metadata?.path;
            if (path) set.add(path);
        }
        return Array.from(set).sort();
    }, [sessions, id]);

    return (
        <>
            <Stack.Screen options={{ headerTitle: `Projects · ${machineName}` }} />
            <ItemList>
                {dirs.length === 0 ? (
                    <ItemGroup>
                        <Item
                            title="No projects yet"
                            subtitle="Start a session on this machine to see its projects here."
                            icon={<Ionicons name="folder-open-outline" size={28} color={theme.colors.textSecondary} />}
                            showChevron={false}
                        />
                    </ItemGroup>
                ) : (
                    dirs.map((dir) => <ProjectSessionsGroup key={dir} machineId={id} dir={dir} />)
                )}
            </ItemList>
        </>
    );
});
