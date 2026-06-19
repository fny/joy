// Cleanup: every REGISTERED machine (including offline ones the normal lists
// hide) with its "remembered folders" — the distinct folders this machine has
// joy-tmux sessions in — plus per-folder session deletion, a per-machine purge,
// and machine deletion. This is where you retire old machines and tidy up stale
// session records.
//
// Personal-build dev surface — plain strings, no i18n (matches the /joy pages).
import * as React from 'react';
import { Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useShallow } from 'zustand/react/shallow';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { useAllMachines, storage } from '@/sync/storage';
import { isMachineOnline } from '@/utils/machineUtils';
import { formatLastSeen } from '@/utils/sessionUtils';
import { Modal } from '@/modal';
import { joyKillAllSessions, sessionDelete, machineDelete } from '@/sync/ops';

function folderName(path: string): string {
    const segs = path.split(/[\\/]/).filter(Boolean);
    return segs.length ? segs[segs.length - 1] : path;
}

async function deleteSessionRecords(ids: string[]): Promise<number> {
    let n = 0;
    for (const id of ids) {
        const r = await sessionDelete(id);
        if (r.success) n++;
    }
    return n;
}

export default React.memo(function CleanupScreen() {
    const machines = useAllMachines({ includeOffline: true });
    const sessions = storage(useShallow((s) => Object.values(s.sessions)));

    // machineId → (folder → session ids), joy-tmux sessions only.
    const byMachine = React.useMemo(() => {
        const map = new Map<string, Map<string, string[]>>();
        for (const s of sessions) {
            const mid = s.metadata?.machineId;
            if (!mid || s.metadata?.joy__source !== 'joy-tmux') continue;
            const folder = s.metadata?.path || '(unknown)';
            if (!map.has(mid)) map.set(mid, new Map());
            const folders = map.get(mid)!;
            folders.set(folder, [...(folders.get(folder) ?? []), s.id]);
        }
        return map;
    }, [sessions]);

    const onDeleteFolder = React.useCallback((folder: string, ids: string[]) => {
        Modal.confirm(
            'Delete folder sessions?',
            `Permanently deletes ${ids.length} session record${ids.length === 1 ? '' : 's'} for "${folderName(folder)}". Cannot be undone.`,
            { confirmText: 'Delete', destructive: true },
        ).then(async (ok) => {
            if (!ok) return;
            const n = await deleteSessionRecords(ids);
            Modal.alert('Deleted', `Removed ${n} session record${n === 1 ? '' : 's'}.`, [{ text: 'OK' }]);
        });
    }, []);

    const onPurgeMachine = React.useCallback((machineId: string, online: boolean) => {
        Modal.confirm(
            'Purge all sessions?',
            'Permanently deletes every joy-tmux session record for this machine. Live sessions are killed first. Cannot be undone.',
            { confirmText: 'Purge', destructive: true },
        ).then(async (ok) => {
            if (!ok) return;
            if (online) await joyKillAllSessions(machineId).catch(() => { });
            const ids = Object.values(storage.getState().sessions)
                .filter((s) => s.metadata?.joy__source === 'joy-tmux' && s.metadata?.machineId === machineId)
                .map((s) => s.id);
            const n = await deleteSessionRecords(ids);
            Modal.alert('Purged', `Removed ${n} session record${n === 1 ? '' : 's'}.`, [{ text: 'OK' }]);
        });
    }, []);

    const onDeleteMachine = React.useCallback((machineId: string, name: string) => {
        Modal.confirm(
            'Delete this machine?',
            `Removes "${name}" and its joy-tmux session records from your list. Cannot be undone. (A machine that is still running reappears on its next heartbeat.)`,
            { confirmText: 'Delete', destructive: true },
        ).then(async (ok) => {
            if (!ok) return;
            const ids = Object.values(storage.getState().sessions)
                .filter((s) => s.metadata?.machineId === machineId)
                .map((s) => s.id);
            await deleteSessionRecords(ids);
            const r = await machineDelete(machineId);
            if (!r.success) Modal.alert('Delete failed', r.message || 'Could not delete machine.', [{ text: 'OK' }]);
        });
    }, []);

    return (
        <ItemList>
            {machines.length === 0 ? (
                <ItemGroup>
                    <Item title="No registered machines" showChevron={false} />
                </ItemGroup>
            ) : machines.map((machine) => {
                const online = isMachineOnline(machine);
                const name = machine.metadata?.displayName || machine.metadata?.host || machine.id.slice(0, 8);
                const status = online ? 'online' : `last seen ${formatLastSeen(machine.activeAt, false)}`;
                const folders = [...(byMachine.get(machine.id) ?? new Map<string, string[]>()).entries()]
                    .sort((a, b) => a[0].localeCompare(b[0]));
                return (
                    <ItemGroup key={machine.id} title={`${name} · ${status}`}>
                        {folders.length === 0 ? (
                            <Item title="No remembered folders" showChevron={false} />
                        ) : folders.map(([folder, ids]) => (
                            <Item
                                key={folder}
                                title={folderName(folder)}
                                subtitle={folder}
                                detail={`${ids.length}`}
                                icon={<Ionicons name="folder-outline" size={29} color="#5856D6" />}
                                rightElement={
                                    <Pressable onPress={() => onDeleteFolder(folder, ids)} hitSlop={10} style={(p) => [{ padding: 4 }, p.pressed && { opacity: 0.5 }]}>
                                        <Ionicons name="trash-outline" size={20} color="#FF3B30" />
                                    </Pressable>
                                }
                                showChevron={false}
                            />
                        ))}
                        <Item
                            title="Purge all sessions"
                            subtitle="Delete every joy-tmux session record for this machine"
                            icon={<Ionicons name="nuclear-outline" size={29} color="#FF3B30" />}
                            onPress={() => onPurgeMachine(machine.id, online)}
                            showChevron={false}
                        />
                        <Item
                            title="Delete machine"
                            subtitle="Remove this machine from your list"
                            icon={<Ionicons name="close-circle-outline" size={29} color="#FF3B30" />}
                            onPress={() => onDeleteMachine(machine.id, name)}
                            showChevron={false}
                        />
                    </ItemGroup>
                );
            })}
        </ItemList>
    );
});
