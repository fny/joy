// Cleanup: every REGISTERED machine (including offline ones the normal lists
// hide) with its "remembered folders" — the distinct folders this machine has
// joy-tmux sessions in — plus per-folder session deletion, a per-machine purge,
// and machine deletion. This is where you retire old machines and tidy up stale
// session records.
//
// Personal-build dev surface — plain strings, no i18n (matches the /joy pages).
import * as React from 'react';
import { Pressable } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useShallow } from 'zustand/react/shallow';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { useAllMachines, storage } from '@/sync/storage';
import { useMachineOnline } from '@/hooks/useMachineOnline';
import { formatLastSeen } from '@/utils/sessionUtils';
import type { Machine } from '@/sync/storageTypes';
import { isJoyDaemonSource } from '@/sync/storageTypes';
import { Modal } from '@/modal';
import { sync } from '@/sync/sync';
import { machineSessionInfo } from '@/sync/v2/machine';
import { joyKillAllSessions, sessionKill, sessionDelete, machineDelete } from '@/sync/ops';
import { planFolderDeletion, recheckDetached, describeFolderDeletion, tallyDeletions, FOLDER_DELETE_IF_STATUS } from '@/utils/cleanupPlan';

function folderName(path: string): string {
    const segs = path.split(/[\\/]/).filter(Boolean);
    return segs.length ? segs[segs.length - 1] : path;
}

/** Deletes each record; reports the ids that failed so callers can stop
 *  (or retry) instead of treating a partial result as done (#175). With
 *  `ifStatus` the relay itself refuses a record whose session is in any
 *  other state at the delete (`live` in the tally, #173). */
async function deleteSessionRecords(ids: string[], opts?: { ifStatus?: string }): Promise<{ deleted: number; failed: string[]; live: string[] }> {
    const results: { id: string; success: boolean; code?: string }[] = [];
    for (const id of ids) {
        try {
            const r = await sessionDelete(id, opts);
            results.push({ id, success: r.success, code: r.code });
        } catch {
            results.push({ id, success: false });
        }
    }
    const t = tallyDeletions(results);
    return { deleted: t.deleted.length, failed: t.failed, live: t.live };
}

const joyStateOf = (id: string) => storage.getState().sessions[id]?.metadata?.joy__state;

/** The daemon's own word, asked right before a kill: is this session's agent
 *  still gone (status "ended" = detached)? False on any doubt — offline
 *  machine, no context, 404, a live status — so the caller skips it. This is
 *  a pre-check only; the kill itself is conditional (`ifStatus: 'ended'`,
 *  409 status_mismatch when the daemon disagrees at the decision) (#174). */
async function daemonSaysDetached(sessionId: string): Promise<boolean> {
    const s = storage.getState().sessions[sessionId];
    const machineId = s?.metadata?.machineId;
    const localId = s?.metadata?.joy__sessionId;
    if (!machineId || !localId) return false;
    const ctx = sync.machineCtxFor(machineId, localId);
    if (!ctx) return false;
    try {
        const r = await Promise.race([
            machineSessionInfo(ctx),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 8000)),
        ]);
        return r.status === 200 && (r.data as { status?: string } | null)?.status === 'ended';
    } catch {
        return false;
    }
}

export default React.memo(function CleanupScreen() {
    const machines = useAllMachines({ includeOffline: true });
    const sessions = storage(useShallow((s) => Object.values(s.sessions)));

    // machineId → (folder → session ids), joy-tmux sessions only.
    const byMachine = React.useMemo(() => {
        const map = new Map<string, Map<string, string[]>>();
        for (const s of sessions) {
            const mid = s.metadata?.machineId;
            if (!mid || !isJoyDaemonSource(s.metadata?.joy__source)) continue;
            const folder = s.metadata?.path || '(unknown)';
            if (!map.has(mid)) map.set(mid, new Map());
            const folders = map.get(mid)!;
            folders.set(folder, [...(folders.get(folder) ?? []), s.id]);
        }
        return map;
    }, [sessions]);

    // machineId → detached session ids (Claude exited, the tmux pane lingers).
    const detachedByMachine = React.useMemo(() => {
        const map = new Map<string, string[]>();
        for (const s of sessions) {
            const mid = s.metadata?.machineId;
            if (!mid || !isJoyDaemonSource(s.metadata?.joy__source)) continue;
            if (s.metadata?.joy__state !== 'detached') continue;
            map.set(mid, [...(map.get(mid) ?? []), s.id]);
        }
        return map;
    }, [sessions]);

    const onCleanDetached = React.useCallback((machineId: string, ids: string[]) => {
        Modal.confirm(
            'Clean up detached sessions?',
            `Ends ${ids.length} detached session${ids.length === 1 ? '' : 's'} (Claude already exited) and closes their lingering tmux panes. Records stay in history. Sessions that have started again since are left alone.`,
            { confirmText: 'Clean up', destructive: true },
        ).then(async (ok) => {
            if (!ok) return;
            // The list was captured before the dialog; a session restarted from
            // another client meanwhile keeps its id. Re-read the cards, then ask
            // the daemon about each one right before its kill (#174).
            await sync.refreshSessions().catch(() => { /* fall back to the cards we have */ });
            const rechecked = recheckDetached(ids, joyStateOf);
            let closed = 0;
            let skipped = rechecked.skip.length;
            let failed = 0;
            for (const id of rechecked.kill) {
                if (!(await daemonSaysDetached(id))) { skipped++; continue; }
                // The GET above is evidence, not a lock: the kill itself is
                // conditional on the daemon still seeing the session ended
                // (409 status_mismatch → skipped, never a live kill; #174).
                const r = await sessionKill(id, { ifStatus: 'ended' });
                if (!r.success && /status_mismatch/.test(r.message)) { skipped++; continue; }
                if (r.success) closed++; else failed++;
            }
            const parts = [`Closed ${closed} detached pane${closed === 1 ? '' : 's'}.`];
            if (skipped) parts.push(`Skipped ${skipped} that ${skipped === 1 ? 'is' : 'are'} no longer detached.`);
            if (failed) parts.push(`${failed} could not be closed.`);
            Modal.alert('Cleaned up', parts.join(' '), [{ text: 'OK' }]);
        });
    }, []);

    const onDeleteFolder = React.useCallback((folder: string, ids: string[]) => {
        // Running sessions must be stopped — and confirmed stopped by the
        // daemon — before their record may go; deleting the record alone left
        // the agent working with no history behind it (#173).
        const plan = planFolderDeletion(ids.map((id) => ({ id, state: joyStateOf(id) })));
        Modal.confirm(
            plan.stopFirst.length ? 'Stop and delete folder sessions?' : 'Delete folder sessions?',
            describeFolderDeletion(plan, folderName(folder)),
            { confirmText: plan.stopFirst.length ? 'Stop and delete' : 'Delete', destructive: true },
        ).then(async (ok) => {
            if (!ok) return;
            // The plan was made before the dialog; a session can change state
            // while it is open. Re-evaluate every candidate now: a card that
            // was detached and is running again is neither deleted nor stopped
            // (the user did not approve stopping it) — it is reported (Astra
            // on 40873bd6, #173). Detached cards need the daemon's word, too.
            await sync.refreshSessions().catch(() => { /* fall back to the cards we have */ });
            const fresh = planFolderDeletion(ids.map((id) => ({ id, state: joyStateOf(id) })));
            const deletable: string[] = [];
            const changed: string[] = [];
            for (const id of fresh.deleteNow) {
                if (joyStateOf(id) === 'archived') { deletable.push(id); continue; }
                // A detached card is deleted only after the daemon itself commits
                // to "ended" at the decision instant: the conditional kill
                // (ifStatus=ended) archives a truly ended session and answers
                // 409 for one that restarted meanwhile — the GET alone left a
                // window between observation and delete (Astra on ffdfc7e3, #173).
                if (!(await daemonSaysDetached(id))) { changed.push(id); continue; }
                const r = await sessionKill(id, { ifStatus: 'ended' });
                if (r.success || /already|not found|404|ended/i.test(r.message)) deletable.push(id); else changed.push(id);
            }
            const kept: string[] = [];
            for (const id of fresh.stopFirst) {
                if (!plan.stopFirst.includes(id)) { changed.push(id); continue; } // started since the dialog: not approved for stopping
                // sessionKill succeeds only once the daemon has archived the
                // session — that IS the shutdown confirmation.
                const r = await sessionKill(id);
                if (r.success) deletable.push(id); else kept.push(id);
            }
            // The delete itself is conditional: the RELAY refuses any record
            // whose session is provisioning, starting or active at that
            // instant (409 status_mismatch), so a kill that reported "not
            // found" or a card that went stale cannot delete a live agent's
            // history out from under it (#173).
            const { deleted: n, failed, live } = await deleteSessionRecords(deletable, { ifStatus: FOLDER_DELETE_IF_STATUS });
            const parts = [`Removed ${n} of ${ids.length} session record${ids.length === 1 ? '' : 's'}.`];
            if (failed.length) parts.push(`${failed.length} record${failed.length === 1 ? '' : 's'} could not be deleted; try again later.`);
            if (live.length) parts.push(`${live.length} ${live.length === 1 ? 'is' : 'are'} still running according to the relay and ${live.length === 1 ? 'was' : 'were'} kept; stop ${live.length === 1 ? 'it' : 'them'} first.`);
            if (kept.length) parts.push(`${kept.length} running session${kept.length === 1 ? '' : 's'} could not be stopped; ${kept.length === 1 ? 'its record was' : 'their records were'} kept.`);
            if (changed.length) parts.push(`${changed.length} changed state while you were deciding and ${changed.length === 1 ? 'was' : 'were'} left alone.`);
            Modal.alert(kept.length || changed.length || failed.length || live.length ? 'Partly deleted' : 'Deleted', parts.join(' '), [{ text: 'OK' }]);
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
                .filter((s) => isJoyDaemonSource(s.metadata?.joy__source) && s.metadata?.machineId === machineId)
                .map((s) => s.id);
            const { deleted: n, failed } = await deleteSessionRecords(ids);
            if (failed.length) {
                Modal.alert('Partly purged', `Removed ${n} session record${n === 1 ? '' : 's'}; ${failed.length} could not be deleted. Try again later.`, [{ text: 'OK' }]);
                return;
            }
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
            // The machine row goes only once EVERY record deletion succeeded:
            // machineDelete preserves sessions, so deleting the machine after a
            // partial failure orphaned the leftover records with no group left
            // here to retry them from (#175).
            const run = async (): Promise<void> => {
                const ids = Object.values(storage.getState().sessions)
                    .filter((s) => s.metadata?.machineId === machineId)
                    .map((s) => s.id);
                const { failed } = await deleteSessionRecords(ids);
                if (failed.length) {
                    Modal.alert(
                        'Machine kept',
                        `${failed.length} of ${ids.length} session record${ids.length === 1 ? '' : 's'} could not be deleted, so "${name}" was not removed. Retry when the relay is reachable.`,
                        [
                            { text: 'Cancel', style: 'cancel' },
                            { text: 'Retry', onPress: () => void run() },
                        ],
                    );
                    return;
                }
                const r = await machineDelete(machineId);
                if (!r.success) Modal.alert('Delete failed', r.message || 'Could not delete machine.', [{ text: 'OK' }]);
            };
            await run();
        });
    }, []);

    return (
        <ItemList>
            {machines.length === 0 ? (
                <ItemGroup>
                    <Item title="No registered machines" showChevron={false} />
                </ItemGroup>
            ) : machines.map((machine) => (
                <MachineCleanupGroup
                    key={machine.id}
                    machine={machine}
                    folders={[...(byMachine.get(machine.id) ?? new Map<string, string[]>()).entries()].sort((a, b) => a[0].localeCompare(b[0]))}
                    detached={detachedByMachine.get(machine.id) ?? []}
                    onDeleteFolder={onDeleteFolder}
                    onCleanDetached={onCleanDetached}
                    onPurgeMachine={onPurgeMachine}
                    onDeleteMachine={onDeleteMachine}
                />
            ))}
        </ItemList>
    );
});

// One machine's cleanup group. Pulled out so it can use useMachineOnline, which
// schedules a re-render when the 60s online window expires (an inline map can't
// call a hook, and would otherwise show a silent machine as "online" forever).
const MachineCleanupGroup = React.memo(function MachineCleanupGroup({
    machine,
    folders,
    detached,
    onDeleteFolder,
    onCleanDetached,
    onPurgeMachine,
    onDeleteMachine,
}: {
    machine: Machine;
    folders: [string, string[]][];
    detached: string[];
    onDeleteFolder: (folder: string, ids: string[]) => void;
    onCleanDetached: (machineId: string, ids: string[]) => void;
    onPurgeMachine: (machineId: string, online: boolean) => void;
    onDeleteMachine: (machineId: string, name: string) => void;
}) {
    const online = useMachineOnline(machine);
    const name = machine.metadata?.displayName || machine.metadata?.host || machine.id.slice(0, 8);
    const status = online ? 'online' : `last seen ${formatLastSeen(machine.activeAt, false)}`;
    return (
        <ItemGroup title={`${name} · ${status}`}>
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
            {detached.length > 0 && (
                <Item
                    title="Clean up detached sessions"
                    subtitle="End sessions whose Claude exited and close their lingering panes"
                    detail={`${detached.length}`}
                    icon={<Ionicons name="unlink-outline" size={29} color="#FF9500" />}
                    onPress={() => onCleanDetached(machine.id, detached)}
                    showChevron={false}
                />
            )}
            <Item
                title="Purge and kill all sessions"
                subtitle="Kill every live session, then permanently delete all records for this machine"
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
});
