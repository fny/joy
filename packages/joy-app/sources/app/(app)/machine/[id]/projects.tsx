import * as React from 'react';
import { useLocalSearchParams, Stack } from 'expo-router';
import Ionicons from '@expo/vector-icons/Ionicons';
import { ItemList } from '@/components/ItemList';
import { ItemGroup } from '@/components/ItemGroup';
import { Item } from '@/components/Item';
import { useAllSessions, useAllMachines } from '@/sync/storage';
import { ProjectSessionsGroup } from '@/components/ProjectSessionsGroup';
import { useUnistyles } from 'react-native-unistyles';
import { Modal } from '@/modal';
import { sync } from '@/sync/sync';
import { machineRestorable, machineRestore, type RestorableSession } from '@/sync/v2/machine';

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

    // Distinct project dirs this machine has sessions in, MOST RECENT FIRST.
    // Alphabetical buried what you were actually working on under whatever
    // happened to start with an 'a'.
    const dirs = React.useMemo(() => {
        const newest = new Map<string, number>();
        for (const s of sessions) {
            if (s.metadata?.machineId !== id) continue;
            const path = s.metadata?.path;
            if (!path) continue;
            const at = Math.max(s.activeAt ?? 0, s.createdAt ?? 0);
            newest.set(path, Math.max(newest.get(path) ?? 0, at));
        }
        return [...newest.entries()]
            .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
            .map(([path]) => path);
    }, [sessions, id]);

    // What a reboot took, by project. A daemon crash loses nothing — tmux
    // outlives it — so this is empty unless the machine actually restarted.
    const [restorable, setRestorable] = React.useState<RestorableSession[]>([]);
    React.useEffect(() => {
        let live = true;
        void (async () => {
            const ctx = sync.machineOnlyCtx(id);
            if (!ctx) return;
            try {
                const r = await machineRestorable(ctx);
                if (live && r.data?.sessions) setRestorable(r.data.sessions);
            } catch { /* an older daemon has no such route; no rows appear */ }
        })();
        return () => { live = false; };
    }, [id]);

    /** The newest lost session in a project — what "Restore latest" restores. */
    const latestIn = React.useCallback((dir: string): RestorableSession | undefined => {
        let best: RestorableSession | undefined;
        for (const r of restorable) {
            if (r.cwd !== dir) continue;
            if (!best || (r.lastSeenAt ?? 0) > (best.lastSeenAt ?? 0)) best = r;
        }
        return best;
    }, [restorable]);

    const [restoring, setRestoring] = React.useState<string | null>(null);
    const restoreLatest = React.useCallback(async (dir: string) => {
        const target = latestIn(dir);
        if (!target) return;
        const ctx = sync.machineOnlyCtx(id);
        if (!ctx) return;
        setRestoring(dir);
        try {
            const r = await machineRestore(ctx, [target.id]);
            const failed = (r.data?.restored ?? []).find((x) => !x.ok);
            if (failed) Modal.alert('Could not restore', failed.error ?? 'unknown', [{ text: 'OK' }]);
            else setRestorable((prev) => prev.filter((x) => x.id !== target.id));
        } catch (e) {
            Modal.alert('Could not restore', String((e as Error)?.message ?? e), [{ text: 'OK' }]);
        } finally {
            setRestoring(null);
        }
    }, [id, latestIn]);

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
                    dirs.map((dir) => {
                        const lost = latestIn(dir);
                        return (
                            <React.Fragment key={dir}>
                                <ProjectSessionsGroup machineId={id} dir={dir} />
                                {/* Only where the machine actually lost something
                                    here. Restores the NEWEST session in this
                                    project, resuming its conversation rather
                                    than reopening an empty folder. */}
                                {lost && (
                                    <ItemGroup>
                                        <Item
                                            title={restoring === dir ? 'Restoring…' : 'Restore latest session'}
                                            subtitle={lost.resumeId
                                                ? 'Lost when this machine restarted · resumes its conversation'
                                                : 'Lost when this machine restarted · no conversation to resume'}
                                            icon={<Ionicons name="refresh-circle-outline" size={28} color="#34C759" />}
                                            onPress={() => void restoreLatest(dir)}
                                            showChevron={false}
                                        />
                                    </ItemGroup>
                                )}
                            </React.Fragment>
                        );
                    })
                )}
            </ItemList>
        </>
    );
});
