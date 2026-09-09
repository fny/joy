/**
 * Settings → Models: which models each harness's pickers offer.
 *
 * Live catalogs are big (an opencode install lists a few hundred models, pi
 * a few dozen) and a picker that cycles through all of them on tap is
 * unusable, so the daemon marks a handful of each `recommended` and this
 * screen lets the user trim or extend that set per harness. The choice is
 * synced settings (`harnessModels`, sync/modelAllowlist.ts) — one list per
 * harness, shared by every machine; the catalogs themselves are per machine,
 * so a machine switcher at the top says whose catalog is being read.
 */
import * as React from 'react';
import { TextInput, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useUnistyles } from 'react-native-unistyles';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { Switch } from '@/components/Switch';
import { useAllMachines, useSettingMutable } from '@/sync/storage';
import { useHarnessModels } from '@/hooks/useHarnessModels';
import { useHarnessCapabilities } from '@/hooks/useHarnessCapabilities';
import { modelKeyOf, type HarnessModel } from '@/sync/machineResources';
import { enabledModels } from '@/sync/modelAllowlist';
import { HARNESS_IDS, type HarnessId } from '@/sync/harnessCapabilities';
import { JOY_CLAUDE_MODELS } from '@/sync/joyModels';
import { isMachineOnline } from '@/utils/machineUtils';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import type { Machine } from '@/sync/storageTypes';

const HARNESS_LABELS: Record<HarnessId, string> = {
    claude: 'Claude Code',
    codex: 'Codex',
    opencode: 'OpenCode',
    pi: 'Pi',
    agy: 'Antigravity',
};

/** Past this many entries a group gets a filter box. */
const FILTER_THRESHOLD = 12;

type Row = { key: string; name: string; detail: string; recommended: boolean; isDefault: boolean };

function machineName(m: Machine): string {
    return m.metadata?.displayName || m.metadata?.host || m.id.slice(0, 8);
}

function rowsOf(harness: HarnessId, catalog: HarnessModel[] | null): Row[] {
    if (harness === 'claude') {
        return JOY_CLAUDE_MODELS.map((m, i) => ({ key: m.key, name: m.name, detail: `claude --model ${m.key}`, recommended: true, isDefault: i === 0 }));
    }
    return (catalog ?? [])
        .map((e) => ({
            key: modelKeyOf(e),
            name: e.displayName || modelKeyOf(e),
            detail: [e.providerID, modelKeyOf(e)].filter(Boolean).join(' · '),
            recommended: e.recommended === true,
            isDefault: e.isDefault === true,
        }))
        .filter((r) => r.key);
}

function HarnessModelsGroup({ machineId, harness, allowlist, onChange }: {
    machineId: string | null;
    harness: HarnessId;
    allowlist: string[] | undefined;
    onChange: (next: string[] | undefined) => void;
}) {
    const { theme } = useUnistyles();
    const caps = useHarnessCapabilities(machineId, harness);
    const live = caps.models.source === 'live';
    const catalog = useHarnessModels(live ? machineId : null, harness);
    const rows = React.useMemo(() => rowsOf(harness, catalog.data ?? null), [harness, catalog.data]);
    const enabled = React.useMemo(() => new Set(enabledModels(rows, allowlist).map((r) => r.key)), [rows, allowlist]);
    const [filter, setFilter] = React.useState('');
    const shown = React.useMemo(() => {
        const q = filter.trim().toLowerCase();
        if (!q) return rows;
        return rows.filter((r) => r.name.toLowerCase().includes(q) || r.key.toLowerCase().includes(q) || r.detail.toLowerCase().includes(q));
    }, [rows, filter]);

    const toggle = React.useCallback((key: string, on: boolean) => {
        const next = new Set(enabled);
        if (on) next.add(key); else next.delete(key);
        // Stored in catalog order, so the picker cycles the way the catalog lists.
        onChange(rows.filter((r) => next.has(r.key)).map((r) => r.key));
    }, [enabled, rows, onChange]);

    if (!caps.models.pick) {
        return (
            <ItemGroup title={HARNESS_LABELS[harness]}>
                <Item title={t('settingsModels.noPicker')} showChevron={false} />
            </ItemGroup>
        );
    }
    const status = live && !catalog.hasData
        ? (catalog.isLoading || catalog.fetching ? t('settingsModels.loading') : catalog.error ? t('settingsModels.error', { error: catalog.error }) : catalog.unavailable ? t('settingsModels.unavailable') : t('settingsModels.empty'))
        : rows.length === 0 ? t('settingsModels.empty') : null;
    return (
        <ItemGroup
            title={HARNESS_LABELS[harness]}
            footer={rows.length > 0 ? t('settingsModels.enabledCount', { enabled: enabled.size, total: rows.length }) : undefined}
        >
            {status && <Item title={status} showChevron={false} />}
            {rows.length > 0 && (
                <>
                    <Item
                        title={t('settingsModels.recommendedOnly')}
                        subtitle={t('settingsModels.recommendedOnlySubtitle')}
                        icon={<Ionicons name="star-outline" size={29} color={theme.colors.accents.orange} />}
                        onPress={() => onChange(undefined)}
                        showChevron={false}
                        disabled={allowlist === undefined}
                    />
                    <Item
                        title={t('settingsModels.enableAll')}
                        icon={<Ionicons name="checkmark-done-outline" size={29} color={theme.colors.accents.green} />}
                        onPress={() => onChange(rows.map((r) => r.key))}
                        showChevron={false}
                        disabled={enabled.size === rows.length}
                    />
                </>
            )}
            {rows.length > FILTER_THRESHOLD && (
                <View style={{ paddingHorizontal: 16, paddingVertical: 8 }}>
                    <TextInput
                        value={filter}
                        onChangeText={setFilter}
                        placeholder={t('settingsModels.filterPlaceholder')}
                        placeholderTextColor={theme.colors.textSecondary}
                        autoCapitalize="none"
                        autoCorrect={false}
                        style={{
                            fontSize: 15,
                            paddingVertical: 8,
                            paddingHorizontal: 12,
                            borderRadius: 8,
                            color: theme.colors.text,
                            backgroundColor: theme.colors.surfaceHighest,
                            ...Typography.default(),
                        }}
                    />
                </View>
            )}
            {shown.map((r) => (
                <Item
                    key={r.key}
                    title={r.name}
                    subtitle={r.detail}
                    subtitleLines={1}
                    detail={r.isDefault ? t('settingsModels.default') : r.recommended ? t('settingsModels.recommended') : undefined}
                    rightElement={<Switch value={enabled.has(r.key)} onValueChange={(on) => toggle(r.key, on)} />}
                    showChevron={false}
                />
            ))}
        </ItemGroup>
    );
}

export default React.memo(function ModelsSettingsScreen() {
    const { theme } = useUnistyles();
    const machines = useAllMachines({ includeOffline: true });
    const [allowlists, setAllowlists] = useSettingMutable('harnessModels');
    const [machineId, setMachineId] = React.useState<string | null>(null);
    const online = React.useMemo(() => machines.filter(isMachineOnline), [machines]);
    const selected = machineId ?? online[0]?.id ?? machines[0]?.id ?? null;

    const setFor = React.useCallback((harness: HarnessId, next: string[] | undefined) => {
        const copy: Record<string, string[]> = { ...allowlists };
        if (next === undefined) delete copy[harness]; else copy[harness] = next;
        setAllowlists(copy);
    }, [allowlists, setAllowlists]);

    return (
        <ItemList style={{ paddingTop: 0 }}>
            <ItemGroup title={t('settingsModels.machine')} footer={t('settingsModels.machineFooter')}>
                {machines.length === 0 && <Item title={t('settingsModels.noMachines')} showChevron={false} />}
                {machines.map((m) => (
                    <Item
                        key={m.id}
                        title={machineName(m)}
                        subtitle={isMachineOnline(m) ? undefined : t('settingsModels.offline')}
                        icon={<Ionicons name="desktop-outline" size={29} color={isMachineOnline(m) ? theme.colors.accents.green : theme.colors.textSecondary} />}
                        rightElement={selected === m.id ? <Ionicons name="checkmark" size={20} color={theme.colors.textLink} /> : undefined}
                        onPress={() => setMachineId(m.id)}
                        showChevron={false}
                    />
                ))}
            </ItemGroup>
            {HARNESS_IDS.map((h) => (
                <HarnessModelsGroup
                    key={h}
                    machineId={selected}
                    harness={h}
                    allowlist={allowlists[h]}
                    onChange={(next) => setFor(h, next)}
                />
            ))}
        </ItemList>
    );
});
