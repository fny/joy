import * as React from 'react';
import { View, ActivityIndicator } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { FileIcon } from '@/components/FileIcon';
import { sync } from '@/sync/sync';
import { machineSessionFiles, type SessionFileEntry } from '@/sync/v2/machine';
import { formatBytes, ageLabel } from '@/utils/storageFormat';
import { t } from '@/text';

/**
 * Files → Session files: what the session keeps OUTSIDE its project, in
 * ~/.joy/sessions/<id>/ on its machine — uploads the app sent (uploads/),
 * images the agent showed (media/) — newest first. Each row opens in the
 * ordinary file viewer (the daemon's file read allows that directory).
 * Never shows a load error: it retries until the machine answers.
 */
export const SessionFilesTab = React.memo(function SessionFilesTab({ sessionId, onFilePress }: {
    sessionId: string;
    onFilePress: (absolutePath: string) => void;
}) {
    const { theme } = useUnistyles();
    const [files, setFiles] = React.useState<SessionFileEntry[] | null>(null);

    React.useEffect(() => {
        let cancelled = false;
        (async () => {
            for (let attempt = 0; !cancelled; attempt++) {
                try {
                    const ctx = await sync.awaitMachineCtx(sessionId);
                    if (!ctx) throw new Error('machine not reachable yet');
                    const { data } = await machineSessionFiles(ctx);
                    if (cancelled) return;
                    if (data?.ok) { setFiles(data.files ?? []); return; }
                } catch { /* retried below */ }
                await new Promise((r) => setTimeout(r, Math.min(1000 * 2 ** attempt, 10_000)));
            }
        })();
        return () => { cancelled = true; };
    }, [sessionId]);

    if (files === null) {
        return (
            <View style={styles.center}>
                <ActivityIndicator color={theme.colors.textSecondary} />
            </View>
        );
    }

    return (
        <ItemList style={styles.list}>
            <ItemGroup footer={files.length === 0 ? t('files.noSessionFiles') : t('files.sessionFilesFooter')}>
                {files.map((f) => {
                    const folder = f.relativePath.includes('/') ? f.relativePath.slice(0, f.relativePath.lastIndexOf('/')) : '';
                    return (
                        <Item
                            key={f.path}
                            title={f.name}
                            subtitle={[folder, formatBytes(f.size), ageLabel(f.mtimeMs)].filter(Boolean).join(' · ')}
                            icon={<FileIcon fileName={f.name} size={32} />}
                            onPress={() => onFilePress(f.path)}
                        />
                    );
                })}
            </ItemGroup>
        </ItemList>
    );
});

const styles = StyleSheet.create(() => ({
    center: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: 48 },
    list: { flex: 1 },
}));
