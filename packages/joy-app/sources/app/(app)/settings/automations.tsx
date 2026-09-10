// Automations — a folder, a prompt and a trigger, and the runs they produce.
//
// A run is an ordinary headless session (relay/automations.mjs), so this page
// is a list of intentions and their outcomes rather than a control panel: the
// work itself is visible in the sidebar while it runs, and openable from the
// history here afterwards.
//
// Authoring a NEW automation is the CLI's job for now (`joy automation create`
// in the folder you want) because the spec must be sealed under the target
// machine's key. This page does everything that does not require sealing:
// see what exists, run one, read its history, enable, disable, delete.
import * as React from 'react';
import { View, ActivityIndicator } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useUnistyles } from 'react-native-unistyles';
import { useRouter } from 'expo-router';
import { Text } from '@/components/StyledText';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { Modal } from '@/modal';
import { v2, type V2Automation, type V2AutomationRun } from '@/sync/v2/api';
import { formatPathRelativeToHome } from '@/utils/pathUtils';

/** The colour a run's outcome carries, from the same family the sidebar uses:
 *  amber wants you, green finished, blue working, grey went nowhere. */
function runTint(run: V2AutomationRun | null | undefined): string {
    if (!run) return '#8B959C';
    if (run.state === 'failed') return '#FFCC00';
    if (run.state === 'succeeded') return '#34C759';
    if (run.state === 'running' || run.state === 'queued') return '#007AFF';
    return '#8B959C';
}

function runSummary(run: V2AutomationRun | null | undefined): string {
    if (!run) return 'never run';
    if (run.state === 'failed') return run.errorCode ? `failed · ${run.errorCode}` : 'failed';
    if (run.state === 'cancelled') return run.errorCode === 'skipped_overlap' ? 'skipped — still running' : 'cancelled';
    return run.state;
}

const when = (ms: number) => new Date(ms).toLocaleString();

export default React.memo(function AutomationsScreen() {
    const router = useRouter();
    const { theme } = useUnistyles();
    const [automations, setAutomations] = React.useState<V2Automation[] | null>(null);
    const [error, setError] = React.useState<string | null>(null);
    const [busy, setBusy] = React.useState<string | null>(null);
    const [runs, setRuns] = React.useState<Record<string, V2AutomationRun[]>>({});
    const [expanded, setExpanded] = React.useState<string | null>(null);

    const load = React.useCallback(async () => {
        try {
            setError(null);
            const { automations: list } = await v2.listAutomations();
            setAutomations(list);
        } catch (e) {
            // An older relay has no /automations at all; say so plainly rather
            // than showing an empty list that looks like "you have none".
            setError(String((e as Error)?.message ?? e));
            setAutomations([]);
        }
    }, []);

    React.useEffect(() => { void load(); }, [load]);

    const openHistory = React.useCallback(async (a: V2Automation) => {
        setExpanded(expanded === a.id ? null : a.id);
        if (runs[a.id]) return;
        try {
            const { runs: list } = await v2.automationRuns(a.id, 50);
            setRuns((prev) => ({ ...prev, [a.id]: list }));
        } catch { /* the row still works without history */ }
    }, [expanded, runs]);

    const runNow = React.useCallback(async (a: V2Automation) => {
        setBusy(a.id);
        try {
            const res = await v2.runAutomation(a.id);
            if (res.skipped) {
                Modal.alert('Already running', res.run.errorMessage ?? 'A run of this automation is still going.', [{ text: 'OK' }]);
            }
            setRuns((prev) => ({ ...prev, [a.id]: [res.run, ...(prev[a.id] ?? [])] }));
            await load();
        } catch (e) {
            Modal.alert('Could not run', String((e as Error)?.message ?? e), [{ text: 'OK' }]);
        } finally {
            setBusy(null);
        }
    }, [load]);

    const toggle = React.useCallback(async (a: V2Automation) => {
        setBusy(a.id);
        try {
            await v2.patchAutomation(a.id, { enabled: !a.enabled });
            await load();
        } finally { setBusy(null); }
    }, [load]);

    const remove = React.useCallback((a: V2Automation) => {
        Modal.alert(
            `Delete “${a.name}”?`,
            'The automation and its run history go. The sessions its runs produced are left alone.',
            [
                { text: 'Cancel', style: 'cancel' },
                {
                    text: 'Delete',
                    style: 'destructive',
                    onPress: async () => {
                        setBusy(a.id);
                        try { await v2.deleteAutomation(a.id); await load(); } finally { setBusy(null); }
                    },
                },
            ],
        );
    }, [load]);

    if (automations === null) {
        return (
            <ItemList style={{ paddingTop: 0 }}>
                <View style={{ padding: 32, alignItems: 'center' }}><ActivityIndicator /></View>
            </ItemList>
        );
    }

    return (
        <ItemList style={{ paddingTop: 0 }}>
            {error && (
                <ItemGroup title="Unavailable" footer="Automations need a relay that serves /automations. Update the relay, or check that this device is paired to the right one.">
                    <Item title="Could not load automations" subtitle={error} showChevron={false} />
                </ItemGroup>
            )}

            {automations.length === 0 && !error && (
                <ItemGroup
                    title="No automations"
                    footer={'Create one from a terminal on the machine that should run it:\n\n  joy automation create -m "run the tests and fix what breaks"\n\nIt runs in the folder you are in. An automation is authored where it runs, because its instructions are sealed with that machine\'s key.'}
                >
                    <Item
                        title="What an automation is"
                        subtitle="A folder, a prompt and a trigger. Each run is a headless session — and it fails loudly the moment it needs a human."
                        icon={<Ionicons name="repeat-outline" size={29} color={theme.colors.textSecondary} />}
                        showChevron={false}
                    />
                </ItemGroup>
            )}

            {automations.map((a) => {
                const history = runs[a.id] ?? [];
                const isOpen = expanded === a.id;
                return (
                    <ItemGroup key={a.id} title={a.name} footer={isOpen ? undefined : 'Tap to see its runs.'}>
                        <Item
                            title={formatPathRelativeToHome(a.directory, undefined)}
                            subtitle={`${a.triggers.map((t) => t.kind).join(', ')} · ${runSummary(a.latestRun)}`}
                            icon={<View style={{ width: 29, alignItems: 'center' }}>
                                <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: runTint(a.latestRun) }} />
                            </View>}
                            onPress={() => void openHistory(a)}
                            showChevron={false}
                        />
                        <Item
                            title={busy === a.id ? 'Working…' : 'Run now'}
                            icon={<Ionicons name="play-outline" size={29} color={theme.colors.textLink} />}
                            onPress={() => void runNow(a)}
                            showChevron={false}
                        />
                        <Item
                            title={a.enabled ? 'Disable' : 'Enable'}
                            subtitle={a.enabled ? 'Stops it firing; runs already going are untouched.' : 'Currently disabled — its triggers fire nothing.'}
                            icon={<Ionicons name={a.enabled ? 'pause-outline' : 'play-circle-outline'} size={29} color={theme.colors.textSecondary} />}
                            onPress={() => void toggle(a)}
                            showChevron={false}
                        />
                        <Item
                            title="Delete"
                            destructive
                            icon={<Ionicons name="trash-outline" size={29} color={theme.colors.textDestructive} />}
                            onPress={() => remove(a)}
                            showChevron={false}
                        />
                        {isOpen && history.length === 0 && (
                            <Item title="No runs yet" showChevron={false} />
                        )}
                        {isOpen && history.map((run) => (
                            <Item
                                key={run.id}
                                title={runSummary(run)}
                                subtitle={`${when(run.createdAt)} · ${run.triggerKind}${run.errorMessage ? ` · ${run.errorMessage}` : ''}`}
                                icon={<View style={{ width: 29, alignItems: 'center' }}>
                                    <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: runTint(run) }} />
                                </View>}
                                // The session a run produced outlives the run row, which is
                                // the point of keeping sessionId: "this ran, here is what
                                // it produced", long after the transcript is gone.
                                onPress={run.sessionId ? () => router.push(`/session/${run.sessionId}`) : undefined}
                                showChevron={!!run.sessionId}
                            />
                        ))}
                    </ItemGroup>
                );
            })}
        </ItemList>
    );
});
