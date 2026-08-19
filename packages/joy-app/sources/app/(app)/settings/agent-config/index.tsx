// Agent config editor — pick machine × agent, then edit that agent's own
// config file (claude settings.json, codex config.toml, opencode
// opencode.json, pi settings.json) via the daemon.
//
// Personal-build dev page — plain strings, no i18n (matches the /joy pages).
import * as React from 'react';
import { Stack, useRouter } from 'expo-router';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useUnistyles } from 'react-native-unistyles';
import { ItemList } from '@/components/ItemList';
import { ItemGroup } from '@/components/ItemGroup';
import { Item } from '@/components/Item';
import { useAllMachines } from '@/sync/storage';
import { isMachineOnline } from '@/utils/machineUtils';

const AGENTS = [
    { key: 'claude', name: 'Claude Code', file: '~/.claude/settings.json' },
    { key: 'codex', name: 'Codex', file: '~/.codex/config.toml' },
    { key: 'opencode', name: 'OpenCode', file: '~/.config/opencode/opencode.json' },
    { key: 'pi', name: 'Pi', file: '~/.pi/agent/settings.json' },
] as const;

export default React.memo(function AgentConfigMenuScreen() {
    const { theme } = useUnistyles();
    const router = useRouter();
    const machines = useAllMachines({ includeOffline: false }).filter(isMachineOnline);

    return (
        <ItemList>
            <Stack.Screen options={{ headerTitle: 'Agent Config' }} />
            {machines.length === 0 && (
                <ItemGroup footer="No online machines — the editor talks to the daemon on the machine that owns the file.">
                    <Item title="No machines online" showChevron={false} />
                </ItemGroup>
            )}
            {machines.map(m => (
                <ItemGroup key={m.id} title={m.metadata?.displayName || m.metadata?.host || m.id.slice(0, 8)}>
                    {AGENTS.map(a => (
                        <Item
                            key={a.key}
                            title={a.name}
                            subtitle={a.file}
                            icon={<Ionicons name="construct-outline" size={29} color={theme.colors.accents.blue} />}
                            onPress={() => router.push(`/settings/agent-config/${m.id}/${a.key}` as any)}
                        />
                    ))}
                </ItemGroup>
            ))}
        </ItemList>
    );
});
