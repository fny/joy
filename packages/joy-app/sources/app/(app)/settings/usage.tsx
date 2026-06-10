import React from 'react';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { UsagePanel } from '@/components/usage/UsagePanel';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';

export default function UsageSettingsScreen() {
    const router = useRouter();
    return (
        <ItemList style={{ paddingTop: 0 }}>
            {/* joy: machine-local report straight from ~/.claude transcripts,
                via the joy-tmux daemon — complements happy's server-side panel. */}
            <ItemGroup>
                <Item
                    title="Machine usage (ccusage)"
                    subtitle="Daily and monthly cost from the machine's own transcripts"
                    icon={<Ionicons name="analytics-outline" size={29} color="#34C759" />}
                    onPress={() => router.push('/settings/joy-usage')}
                />
            </ItemGroup>
            <UsagePanel />
        </ItemList>
    );
}