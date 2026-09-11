// Create OR edit an automation — the app's half of authoring.
//
// One screen for both: an edit is the same seven questions with the answers
// filled in, and two screens would have drifted the moment one gained a field.
// `?id=` selects edit; without it this creates.
//
// The app can do what the CLI cannot: seal for ANY machine. `joy automation
// create` on boite can only ever make an automation that runs on boite,
// because a daemon holds one machine key. The app holds the ACCOUNT key, so
// it can derive every machine's spawn-spec key and author for all of them —
// which is why the machine is the first thing this form asks for.
import * as React from 'react';
import { View, TextInput, ActivityIndicator } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useUnistyles } from 'react-native-unistyles';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { Text } from '@/components/StyledText';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import { useJoyMachines } from '@/hooks/useJoyMachines';
import { isMachineOnline } from '@/utils/machineUtils';
import { createAutomation, updateAutomation, openAutomationSpec } from '@/sync/automations';
import { v2 } from '@/sync/v2/api';
import { HARNESS_IDS, type HarnessId } from '@/sync/harnessCapabilities';

/**
 * What can fire an automation.
 *
 * `turn_done` and `machine_online` were built and then removed: nobody wanted
 * "after any turn on this machine" or "whenever the daemon restarts", and a
 * trigger nobody uses is a code path that rots. `session_state` never shipped
 * — the relay accepted the kind but nothing emitted it, and offering a
 * trigger that never fires is worse than not offering it.
 */
const TRIGGERS: Array<{ kind: string; title: string; subtitle: string }> = [
    { kind: 'manual', title: 'Only when I ask', subtitle: 'From here, or `joy automation run` on any machine' },
    { kind: 'schedule', title: 'On a schedule', subtitle: 'A cron expression, in a time zone you name' },
    { kind: 'automation_done', title: 'After another automation', subtitle: 'Chain one behind another' },
];

export default React.memo(function NewAutomationScreen() {
    const router = useRouter();
    const { theme } = useUnistyles();
    const { id } = useLocalSearchParams<{ id?: string }>();
    const editing = typeof id === 'string' && id.length > 0;
    const machines = useJoyMachines().machines.filter(isMachineOnline);
    // Null until an edit has loaded; the CAS version the save is conditional on.
    const [specVersion, setSpecVersion] = React.useState<number | null>(null);
    const [loading, setLoading] = React.useState(editing);

    const [machineId, setMachineId] = React.useState<string | null>(machines[0]?.id ?? null);
    const [directory, setDirectory] = React.useState('');
    const [prompt, setPrompt] = React.useState('');
    const [name, setName] = React.useState('');
    const [agent, setAgent] = React.useState<HarnessId>('claude');
    const [trigger, setTrigger] = React.useState('manual');
    // A schedule's expression lives in the trigger's filter — a trigger is an
    // event source plus a filter, and for a schedule the filter IS the cron.
    const [cron, setCron] = React.useState('0 2 * * *');
    const [timezone, setTimezone] = React.useState(
        (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } })(),
    );
    const [saving, setSaving] = React.useState(false);

    React.useEffect(() => {
        if (!editing && !machineId && machines.length > 0) setMachineId(machines[0].id);
    }, [editing, machineId, machines]);

    // Load the automation being edited, and open its spec locally — the prompt
    // and the agent live in the sealed blob, not in what the relay returns.
    React.useEffect(() => {
        if (!editing || !id) return;
        let live = true;
        void (async () => {
            try {
                const { automation } = await v2.getAutomation(id);
                const spec = await openAutomationSpec(automation);
                if (!live) return;
                setName(automation.name);
                setMachineId(automation.machineId);
                setDirectory(automation.directory);
                setSpecVersion(automation.specVersion);
                const trig = automation.triggers[0];
                if (trig) {
                    setTrigger(trig.kind);
                    if (trig.kind === 'schedule') {
                        if (trig.filter) setCron(trig.filter);
                        if (trig.timezone) setTimezone(trig.timezone);
                    }
                }
                if (spec) {
                    if (spec.prompt) setPrompt(spec.prompt);
                    if (spec.agent) setAgent(spec.agent as HarnessId);
                } else {
                    // The spec is sealed under a machine key this device has
                    // not decrypted. Saying so beats an empty prompt field
                    // that would overwrite the real one on save.
                    Modal.alert(
                        'Prompt not readable here',
                        "This automation's instructions are sealed with its machine's key, which this device has not decrypted. You can change its name, folder and trigger; saving would replace the prompt with whatever is in the box.",
                        [{ text: 'OK' }],
                    );
                }
            } catch (e) {
                if (live) Modal.alert('Could not load', String((e as Error)?.message ?? e), [{ text: 'OK' }]);
            } finally {
                if (live) setLoading(false);
            }
        })();
        return () => { live = false; };
    }, [editing, id]);

    const input = {
        fontSize: 15,
        paddingVertical: 10,
        paddingHorizontal: 12,
        borderRadius: 8,
        color: theme.colors.text,
        backgroundColor: theme.colors.surfaceHighest,
        ...Typography.default(),
    } as const;

    // The name is required, and first. It is what the list shows, what a
    // failure is reported under, and what you say out loud about the thing —
    // deriving it from the first few words of the prompt gave every automation
    // a name that read like a fragment of a sentence.
    const ready = name.trim().length > 0 && !!machineId
        && directory.trim().length > 0 && prompt.trim().length > 0
        && (trigger !== 'schedule' || cron.trim().split(/\s+/).length === 5);

    const save = React.useCallback(async () => {
        if (!ready || !machineId) return;
        setSaving(true);
        try {
            const payload = {
                machineId,
                directory: directory.trim(),
                name: name.trim(),
                prompt: prompt.trim(),
                agent,
                trigger,
                ...(trigger === 'schedule'
                    ? { triggerFilter: cron.trim(), timezone: timezone.trim() || 'UTC' }
                    : {}),
            };
            if (editing && id) await updateAutomation(id, payload, specVersion ?? 0);
            else await createAutomation(payload);
            router.back();
        } catch (e) {
            // A spec_version_mismatch means somebody else saved first; the
            // relay's message names the version, and re-opening shows theirs.
            Modal.alert(editing ? 'Could not save' : 'Could not create', String((e as Error)?.message ?? e), [{ text: 'OK' }]);
        } finally {
            setSaving(false);
        }
    }, [ready, machineId, directory, name, prompt, agent, trigger, cron, timezone, editing, id, specVersion, router]);

    if (loading) {
        return (
            <ItemList style={{ paddingTop: 0 }}>
                <View style={{ padding: 32, alignItems: 'center' }}><ActivityIndicator /></View>
            </ItemList>
        );
    }

    return (
        <ItemList style={{ paddingTop: 0 }}>
            <ItemGroup title="Name" footer="What you will look for in the list, and what a failure will be reported under.">
                <View style={{ paddingHorizontal: 16, paddingVertical: 10 }}>
                    <TextInput
                        value={name}
                        onChangeText={setName}
                        placeholder="nightly tests"
                        placeholderTextColor={theme.colors.textSecondary}
                        style={input}
                    />
                </View>
            </ItemGroup>

            <ItemGroup
                title="Machine"
                footer="Where it runs. The folder below is a path on THIS machine."
            >
                {machines.length === 0 && (
                    <Item title="No machines connected" subtitle="An automation runs on a machine, so one has to be online to make it." showChevron={false} />
                )}
                {machines.map((m) => (
                    <Item
                        key={m.id}
                        title={m.metadata?.displayName || m.metadata?.host || m.id}
                        icon={<Ionicons name="hardware-chip-outline" size={29} color={theme.colors.status.connected} />}
                        rightElement={machineId === m.id
                            ? <Ionicons name="checkmark" size={18} color={theme.colors.textLink} />
                            : undefined}
                        onPress={() => setMachineId(m.id)}
                        showChevron={false}
                    />
                ))}
            </ItemGroup>

            <ItemGroup title="Folder" footer="An absolute path, or ~/… — the automation's home.">
                <View style={{ paddingHorizontal: 16, paddingVertical: 10 }}>
                    <TextInput
                        value={directory}
                        onChangeText={setDirectory}
                        placeholder="~/Workspace/project"
                        placeholderTextColor={theme.colors.textSecondary}
                        autoCapitalize="none"
                        autoCorrect={false}
                        style={input}
                    />
                </View>
            </ItemGroup>

            <ItemGroup
                title="Prompt"
                footer="What the agent is asked, every time it runs. Write it as you would a first message."
            >
                <View style={{ paddingHorizontal: 16, paddingVertical: 10 }}>
                    <TextInput
                        value={prompt}
                        onChangeText={setPrompt}
                        placeholder="run the tests and fix what breaks"
                        placeholderTextColor={theme.colors.textSecondary}
                        multiline
                        style={{ ...input, minHeight: 90, textAlignVertical: 'top' }}
                    />
                </View>
            </ItemGroup>

            <ItemGroup title="When" footer="Triggers replace schedules: there is no clock, so nothing owes you a backlog of runs after a machine has been offline.">
                {TRIGGERS.map((tr) => (
                    <Item
                        key={tr.kind}
                        title={tr.title}
                        subtitle={tr.subtitle}
                        rightElement={trigger === tr.kind
                            ? <Ionicons name="checkmark" size={18} color={theme.colors.textLink} />
                            : undefined}
                        onPress={() => setTrigger(tr.kind)}
                        showChevron={false}
                    />
                ))}
            </ItemGroup>

            {trigger === 'schedule' && (
                <ItemGroup
                    title="Schedule"
                    footer={'Five fields: minute hour day-of-month month day-of-week.\n\n  0 2 * * *      every day at 2am\n  */15 * * * *   every fifteen minutes\n  0 9 * * 1-5    weekdays at 9am\n\nThe time zone is yours, not the machine\'s — 2am means 2am where you are, across daylight saving.'}
                >
                    <View style={{ paddingHorizontal: 16, paddingVertical: 10 }}>
                        <TextInput
                            value={cron}
                            onChangeText={setCron}
                            placeholder="0 2 * * *"
                            placeholderTextColor={theme.colors.textSecondary}
                            autoCapitalize="none"
                            autoCorrect={false}
                            style={input}
                        />
                    </View>
                    <View style={{ paddingHorizontal: 16, paddingBottom: 10 }}>
                        <TextInput
                            value={timezone}
                            onChangeText={setTimezone}
                            placeholder="UTC"
                            placeholderTextColor={theme.colors.textSecondary}
                            autoCapitalize="none"
                            autoCorrect={false}
                            style={input}
                        />
                    </View>
                </ItemGroup>
            )}

            <ItemGroup title="Agent">
                {HARNESS_IDS.map((h) => (
                    <Item
                        key={h}
                        title={h}
                        rightElement={agent === h
                            ? <Ionicons name="checkmark" size={18} color={theme.colors.textLink} />
                            : undefined}
                        onPress={() => setAgent(h)}
                        showChevron={false}
                    />
                ))}
            </ItemGroup>

            <ItemGroup footer="Every run is headless and starts with prompts off. Both follow from what a run is: nobody is watching it, and one that stops for a human is a failure rather than something to wait on.">
                <Item
                    title={saving ? 'Saving…' : editing ? 'Save changes' : 'Create automation'}
                    icon={saving
                        ? <View style={{ width: 29, alignItems: 'center' }}><ActivityIndicator /></View>
                        : <Ionicons name="checkmark-circle-outline" size={29} color={ready ? theme.colors.textLink : theme.colors.textSecondary} />}
                    onPress={() => void save()}
                    disabled={!ready || saving}
                    showChevron={false}
                />
            </ItemGroup>
        </ItemList>
    );
});
