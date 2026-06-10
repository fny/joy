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
            {/* joy: machine-local report straight from the machines' own
                transcripts, via the joy-tmux daemon — complements happy's
                server-side panel. */}
            <ItemGroup>
                <Item
                    title="Codeburn"
                    subtitle="All machines, per machine, per session — today to 6 months"
                    icon={<Ionicons name="flame-outline" size={29} color="#FF3B30" />}
                    onPress={() => router.push('/settings/codeburn')}
                />
            </ItemGroup>
            <UsagePanel />
        </ItemList>
    );
}