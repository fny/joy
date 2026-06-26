import * as React from 'react';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { useAllSessions, useAllMachines } from '@/sync/storage';
import { useUnistyles } from 'react-native-unistyles';

// Browse Claude session logs by project. Projects are derived from the synced
// sessions (distinct machine + cwd) — tapping one lists its transcript logs on
// disk. Entry point: the "logs" button in the sessions tab header.
export default React.memo(function JoyLogsProjectsScreen() {
    const sessions = useAllSessions();
    const machines = useAllMachines({ includeOffline: true });
    const { theme } = useUnistyles();

    const machineName = React.useCallback((id: string) => {
        const m = machines.find((x) => x.id === id);
        return m?.metadata?.displayName || m?.metadata?.host || id;
    }, [machines]);

    // Group distinct (machineId, path) projects under each machine.
    const grouped = React.useMemo(() => {
        const byMachine = new Map<string, Set<string>>();
        for (const s of sessions) {
            const path = s.metadata?.path;
            const machineId = s.metadata?.machineId;
            if (!path || !machineId) continue;
            if (!byMachine.has(machineId)) byMachine.set(machineId, new Set());
            byMachine.get(machineId)!.add(path);
        }
        return Array.from(byMachine.entries())
            .map(([machineId, paths]) => ({
                machineId,
                paths: Array.from(paths).sort(),
            }))
            .sort((a, b) => machineName(a.machineId).localeCompare(machineName(b.machineId)));
    }, [sessions, machineName]);

    const openProject = React.useCallback((machineId: string, dir: string) => {
        router.push({ pathname: '/joy/logs/[machine]', params: { machine: machineId, dir } });
    }, []);

    return (
        <ItemList>
            {grouped.length === 0 ? (
                <ItemGroup>
                    <Item
                        title="No projects yet"
                        subtitle="Start a session to see its project logs here."
                        icon={<Ionicons name="folder-open-outline" size={28} color={theme.colors.textSecondary} />}
                        showChevron={false}
                    />
                </ItemGroup>
            ) : (
                grouped.map((g) => (
                    <ItemGroup key={g.machineId} title={machineName(g.machineId)}>
                        {g.paths.map((path) => (
                            <Item
                                key={path}
                                title={path.split(/[/\\]/).filter(Boolean).pop() || path}
                                subtitle={path}
                                subtitleLines={1}
                                icon={<Ionicons name="folder-outline" size={28} color={theme.colors.text} />}
                                onPress={() => openProject(g.machineId, path)}
                            />
                        ))}
                    </ItemGroup>
                ))
            )}
        </ItemList>
    );
});
