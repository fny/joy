import * as React from 'react';
import { useLocalSearchParams, Stack } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { ItemList } from '@/components/ItemList';
import { ItemGroup } from '@/components/ItemGroup';
import { Item } from '@/components/Item';
import { useSession } from '@/sync/storage';
import { ProjectSessionsGroup, folderName } from '@/components/ProjectSessionsGroup';
import { useUnistyles } from 'react-native-unistyles';

// Per-session Projects screen — the machine projects browser, filtered to this
// session's ONE project (its cwd). Lists that project's session history (on-disk
// transcript logs), newest first, collapsed to the most recent few.
export default React.memo(function SessionProjectsScreen() {
    const { id } = useLocalSearchParams<{ id: string }>();
    const session = useSession(id);
    const { theme } = useUnistyles();

    const path = session?.metadata?.path;
    const machineId = session?.metadata?.machineId;
    const title = path ? `Projects · ${folderName(path)}` : 'Projects';

    return (
        <>
            <Stack.Screen options={{ headerTitle: title }} />
            <ItemList>
                {!path || !machineId ? (
                    <ItemGroup>
                        <Item
                            title="No project"
                            subtitle="This session has no project directory to browse."
                            icon={<Ionicons name="folder-open-outline" size={28} color={theme.colors.textSecondary} />}
                            showChevron={false}
                        />
                    </ItemGroup>
                ) : (
                    <ProjectSessionsGroup machineId={machineId} dir={path} />
                )}
            </ItemList>
        </>
    );
});
