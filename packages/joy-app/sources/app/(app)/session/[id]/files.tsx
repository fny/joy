import * as React from 'react';
import { encodePathParam } from '@/utils/pathParam';
import { View, ActivityIndicator, Platform, TextInput, Pressable } from 'react-native';
import { t } from '@/text';
import { useRouter, useLocalSearchParams } from 'expo-router';
import Octicons from '@expo/vector-icons/Octicons';
import { Text } from '@/components/StyledText';
import { Item } from '@/components/Item';
import { ItemList } from '@/components/ItemList';
import { Typography } from '@/constants/Typography';
import { GitFileStatus, knownLines } from '@/sync/gitStatusModel';
import { searchFiles, FileItem } from '@/sync/suggestionFile';
import { useSessionGitStatus } from '@/sync/gitStatusResource';
import { useGitStatusFiles } from '@/hooks/useGitStatusFiles';
import { useUnistyles, StyleSheet } from 'react-native-unistyles';
import { layout } from '@/components/layout';
import { FileIcon } from '@/components/FileIcon';
import { Shaker, ShakeInstance } from '@/components/Shaker';
import { usePrefetchFileContents } from '@/hooks/usePrefetchFileContents';
import { AllFilesTab } from '@/components/FilesSidebar';
import { SessionFilesTab } from '@/components/SessionFilesTab';
import { sessionWriteFile } from '@/sync/ops';
import { Modal } from '@/modal';
import Ionicons from '@expo/vector-icons/Ionicons';

/** Shared addressability boundary for every row kind on this screen: a git
 *  identity key for a non-UTF-8 name carries a NUL (gitPathIdentity) and is
 *  never a path the daemon accepts — it must not reach the file route. */
function isAddressablePath(path: string): boolean {
    return !path.includes('\u0000');
}

function isUnavailableRow(file: GitFileStatus | FileItem): boolean {
    if (!isAddressablePath(file.fullPath)) return true;
    return 'status' in file && (file.status === 'deleted' || file.unaddressable);
}

export default React.memo(function FilesScreen() {
    const router = useRouter();
    const { id: sessionId } = useLocalSearchParams<{ id: string }>();

    const { data: gitStatusFiles, isLoading, revision, state: gitState, refresh: refreshGitStatus } = useGitStatusFiles(sessionId!);

    // Prefetch file contents for instant navigation into file view — at the
    // changed list's revision, so a list that changed mid-prefetch is not
    // warmed with the previous list's contents (#325).
    usePrefetchFileContents(sessionId!, gitStatusFiles, revision);
    // Changes (git status, the default) vs All files (the same browsable tree
    // the desktop sidebar shows — AllFilesTab brings its own search + cache).
    const [mode, setMode] = React.useState<'changes' | 'allFiles' | 'session'>('changes');
    // Session files: the directory it lists (for New file) and a token that
    // re-lists it once a file has been created there.
    const [sessionRoot, setSessionRoot] = React.useState<string | null>(null);
    const [sessionReload, setSessionReload] = React.useState(0);
    const [creating, setCreating] = React.useState(false);
    const [searchQuery, setSearchQuery] = React.useState('');
    const [searchResults, setSearchResults] = React.useState<FileItem[]>([]);
    const [isSearching, setIsSearching] = React.useState(false);
    const gitStatus = useSessionGitStatus(sessionId!);
    const { theme } = useUnistyles();

    // Refs for shaking deleted file items
    const shakerRefs = React.useRef(new Map<string, ShakeInstance>());

    // Handle search and file loading
    React.useEffect(() => {
        // latest-wins: a slow round-trip for an OLD query must not overwrite the
        // results of a newer one that already rendered.
        let cancelled = false;
        const loadFiles = async () => {
            if (!sessionId) return;

            try {
                setIsSearching(true);
                const results = await searchFiles(sessionId, searchQuery, { limit: 100 });
                if (!cancelled) setSearchResults(results);
            } catch (error) {
                console.error('Failed to search files:', error);
                if (!cancelled) setSearchResults([]);
            } finally {
                if (!cancelled) setIsSearching(false);
            }
        };

        // Load files when searching or when repo is clean
        const shouldShowAllFiles = searchQuery ||
            (gitStatusFiles?.totalStaged === 0 && gitStatusFiles?.totalUnstaged === 0);

        if (shouldShowAllFiles && !isLoading) {
            loadFiles();
        } else if (!searchQuery) {
            setSearchResults([]);
            setIsSearching(false);
        }
        return () => { cancelled = true; };
    }, [searchQuery, gitStatusFiles, sessionId, isLoading]);

    const handleFilePress = React.useCallback((file: GitFileStatus | FileItem) => {
        // Deleted files, and rows whose name is not valid UTF-8 (no addressable
        // path — shown by display text only): shake and don't navigate.
        if (isUnavailableRow(file)) {
            shakerRefs.current.get(file.fullPath)?.shake();
            return;
        }
        const encodedPath = encodePathParam(file.fullPath);
        router.push(`/session/${sessionId}/file?path=${encodedPath}`);
    }, [router, sessionId]);

    const handleProjectFilePress = React.useCallback((filePath: string) => {
        if (!isAddressablePath(filePath)) return;
        router.push(`/session/${sessionId}/file?path=${encodePathParam(filePath)}`);
    }, [router, sessionId]);

    // New file: named by the user, created EMPTY and create-only (the daemon
    // refuses rather than overwriting), then opened straight in the editor.
    // In Session files it lands in the session's own directory; elsewhere in
    // the project, where a relative path like `src/notes.md` works too.
    const handleNewFile = React.useCallback(async () => {
        if (creating) return;
        const inSession = mode === 'session';
        if (inSession && !sessionRoot) return;
        const entered = await Modal.prompt(
            t('files.newFile'),
            inSession ? t('files.newFileInSession') : t('files.newFileInProject'),
            { placeholder: t('files.newFilePlaceholder'), confirmText: t('common.create') },
        );
        const name = entered?.trim();
        if (!name) return;
        const path = inSession ? `${sessionRoot}/${name}` : name;
        setCreating(true);
        try {
            const res = await sessionWriteFile(sessionId!, path, '', undefined, 'utf8', true);
            if (!res.success) {
                Modal.alert(t('common.error'), res.error === 'file_exists' || /exists/i.test(res.error ?? '')
                    ? t('files.fileExists', { name })
                    : res.error || t('files.failedToSave'));
                return;
            }
            if (inSession) setSessionReload((n) => n + 1);
            router.push(`/session/${sessionId}/file?path=${encodePathParam(path)}&edit=1`);
        } finally {
            setCreating(false);
        }
    }, [creating, mode, sessionRoot, sessionId, router]);

    const renderFileIcon = (file: GitFileStatus) => {
        return <FileIcon fileName={file.fileName} size={32} />;
    };

    const renderStatusIcon = (file: GitFileStatus) => {
        if (file.status === 'deleted') {
            return (
                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                    <Text style={{
                        color: '#FF3B30',
                        fontSize: 12,
                        marginRight: 4,
                        ...Typography.default()
                    }}>
                        {t('files.deleted')}
                    </Text>
                    <Octicons name="diff-removed" size={16} color="#FF3B30" />
                </View>
            );
        }

        let statusColor: string;
        let statusIcon: string;

        switch (file.status) {
            case 'modified':
                statusColor = "#FF9500";
                statusIcon = "diff-modified";
                break;
            case 'added':
                statusColor = "#34C759";
                statusIcon = "diff-added";
                break;
            case 'renamed':
                statusColor = "#007AFF";
                statusIcon = "arrow-right";
                break;
            case 'untracked':
                statusColor = theme.dark ? "#b0b0b0" : "#8E8E93";
                statusIcon = "file";
                break;
            case 'typechange':
                statusColor = "#FF9500";
                statusIcon = "file-symlink-file";
                break;
            case 'conflicted':
                statusColor = "#FF9500";
                statusIcon = "alert";
                break;
            default:
                return null;
        }

        return <Octicons name={statusIcon as any} size={16} color={statusColor} />;
    };

    const renderLineChanges = (file: GitFileStatus) => {
        // Exact counts only; 'unavailable' (binary, untracked, unread) shows nothing.
        const lines = knownLines(file.lines);
        if (!lines) return '';
        const parts = [];
        if (lines.added > 0) {
            parts.push(`+${lines.added}`);
        }
        if (lines.removed > 0) {
            parts.push(`-${lines.removed}`);
        }
        return parts.length > 0 ? parts.join(' ') : '';
    };

    const renderFileSubtitle = (file: GitFileStatus) => {
        const lineChanges = renderLineChanges(file);
        const pathPart = file.filePath || t('files.projectRoot');
        return lineChanges ? `${pathPart} • ${lineChanges}` : pathPart;
    };

    const renderFileIconForSearch = (file: FileItem) => {
        if (file.fileType === 'folder') {
            return <Octicons name="file-directory" size={29} color="#007AFF" />;
        }

        return <FileIcon fileName={file.fileName} size={29} />;
    };

    const renderGitFileItem = (file: GitFileStatus, index: number, prefix: string, isLast: boolean) => {
        // An unaddressable row (non-UTF-8 name) renders an explicit unavailable
        // state: dimmed title, a "no action" mark instead of the status icon,
        // and the same shake-on-press as a deleted row.
        const unavailable = isUnavailableRow(file);
        const unaddressable = unavailable && file.status !== 'deleted';
        const item = (
            <Item
                key={`${prefix}-${file.fullPath}-${index}`}
                title={file.fileName}
                titleStyle={unaddressable ? { color: theme.colors.textSecondary } : undefined}
                subtitle={renderFileSubtitle(file)}
                icon={renderFileIcon(file)}
                rightElement={unaddressable
                    ? <Octicons name="circle-slash" size={16} color={theme.colors.textSecondary} />
                    : renderStatusIcon(file)}
                onPress={() => handleFilePress(file)}
                showDivider={!isLast}
            />
        );

        if (unavailable) {
            return (
                <Shaker
                    key={`shaker-${prefix}-${file.fullPath}-${index}`}
                    ref={(ref) => {
                        if (ref) shakerRefs.current.set(file.fullPath, ref);
                        else shakerRefs.current.delete(file.fullPath);
                    }}
                >
                    {item}
                </Shaker>
            );
        }
        return item;
    };

    const modeToggle = (
        <View style={{ flexDirection: 'row', alignItems: 'center', marginHorizontal: 16, marginTop: 12, gap: 8 }}>
        <View style={{
            flexDirection: 'row',
            flex: 1,
            backgroundColor: theme.colors.surfaceHighest,
            borderRadius: 9,
            padding: 2,
        }}>
            {(['changes', 'allFiles', 'session'] as const).map((m) => (
                <Pressable
                    key={m}
                    onPress={() => setMode(m)}
                    style={{
                        flex: 1,
                        paddingVertical: 6,
                        borderRadius: 7,
                        alignItems: 'center',
                        backgroundColor: mode === m ? theme.colors.surface : 'transparent',
                    }}
                >
                    <Text style={{
                        fontSize: 13,
                        color: mode === m ? theme.colors.text : theme.colors.textSecondary,
                        ...Typography.default('semiBold'),
                    }}>
                        {m === 'changes' ? t('files.changes') : m === 'allFiles' ? t('files.allFiles') : t('files.sessionFiles')}
                    </Text>
                </Pressable>
            ))}
        </View>
        <Pressable
            onPress={() => { void handleNewFile(); }}
            disabled={creating || (mode === 'session' && !sessionRoot)}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={t('files.newFile')}
            style={(p) => ({ padding: 6, opacity: p.pressed || creating ? 0.6 : 1 })}
        >
            <Ionicons name="add" size={22} color={theme.colors.textLink} />
        </Pressable>
        </View>
    );

    if (mode === 'session') {
        return (
            <View style={[styles.container, { backgroundColor: theme.colors.surface }]}>
                {modeToggle}
                <SessionFilesTab sessionId={sessionId!} onFilePress={handleProjectFilePress} onRoot={setSessionRoot} reloadToken={sessionReload} />
            </View>
        );
    }

    if (mode === 'allFiles') {
        return (
            <View style={[styles.container, { backgroundColor: theme.colors.surface }]}>
                {modeToggle}
                <AllFilesTab
                    sessionId={sessionId!}
                    selectedPath={null}
                    onFilePress={handleProjectFilePress}
                />
            </View>
        );
    }

    return (
        <View style={[styles.container, { backgroundColor: theme.colors.surface }]}>
            {modeToggle}

            {/* Search Input - Always Visible */}
            <View style={{
                padding: 16,
                borderBottomWidth: Platform.select({ ios: 0.33, default: 1 }),
                borderBottomColor: theme.colors.divider
            }}>
                <View style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    backgroundColor: theme.colors.input.background,
                    borderRadius: 10,
                    paddingHorizontal: 12,
                    paddingVertical: 8
                }}>
                    <Octicons name="search" size={16} color={theme.colors.textSecondary} style={{ marginRight: 8 }} />
                    <TextInput
                        value={searchQuery}
                        onChangeText={setSearchQuery}
                        placeholder={t('files.searchPlaceholder')}
                        style={{
                            flex: 1,
                            fontSize: 16,
                            ...Typography.default()
                        }}
                        placeholderTextColor={theme.colors.input.placeholder}
                        autoCapitalize="none"
                        autoCorrect={false}
                    />
                </View>
            </View>

            {/* Header with branch info */}
            {!isLoading && gitStatusFiles && (
                <View style={{
                    padding: 16,
                    borderBottomWidth: Platform.select({ ios: 0.33, default: 1 }),
                    borderBottomColor: theme.colors.divider
                }}>
                    <View style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        marginBottom: 8
                    }}>
                        <Octicons name="git-branch" size={16} color={theme.colors.textSecondary} style={{ marginRight: 6 }} />
                        <Text style={{
                            fontSize: 16,
                            fontWeight: '600',
                            color: theme.colors.text,
                            ...Typography.default()
                        }}>
                            {gitStatusFiles.branch || t('files.detachedHead')}
                        </Text>
                    </View>
                    <Text style={{
                        fontSize: 12,
                        color: theme.colors.textSecondary,
                        ...Typography.default()
                    }}>
                        {t('files.summary', { staged: gitStatusFiles.totalStaged, unstaged: gitStatusFiles.totalUnstaged })}
                    </Text>
                </View>
            )}

            {/* The last good list is on screen but the newest check failed: say so, retryably. */}
            {gitState.kind === 'ready' && gitState.stale && (
                <Pressable
                    onPress={() => { void refreshGitStatus(); }}
                    accessibilityRole="button"
                    style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 8, gap: 12 }}
                >
                    <Text numberOfLines={2} style={{ flex: 1, fontSize: 12, color: theme.colors.textSecondary, ...Typography.default() }}>
                        {t('files.statusStale')} · {gitState.stale}
                    </Text>
                    <Text style={{ fontSize: 12, color: theme.colors.textLink, ...Typography.default('semiBold') }}>{t('common.retry')}</Text>
                </Pressable>
            )}

            {/* Git Status List */}
            <ItemList style={{ flex: 1 }}>
                {isLoading || gitState.kind === 'loading' ? (
                    <View style={{
                        flex: 1,
                        justifyContent: 'center',
                        alignItems: 'center',
                        paddingTop: 40
                    }}>
                        <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                    </View>
                ) : gitState.kind === 'failed' ? (
                    // No answer and nothing cached: an error with Retry — never "not a repository".
                    <View style={{
                        flex: 1,
                        justifyContent: 'center',
                        alignItems: 'center',
                        paddingTop: 40,
                        paddingHorizontal: 20
                    }}>
                        <Octicons name="alert" size={48} color={theme.colors.textSecondary} />
                        <Text style={{
                            fontSize: 16,
                            color: theme.colors.textSecondary,
                            textAlign: 'center',
                            marginTop: 16,
                            ...Typography.default()
                        }}>
                            {t('files.statusFailed')}
                        </Text>
                        <Text style={{
                            fontSize: 14,
                            color: theme.colors.textSecondary,
                            textAlign: 'center',
                            marginTop: 8,
                            ...Typography.default()
                        }}>
                            {gitState.reason}
                        </Text>
                        <Pressable onPress={() => { void refreshGitStatus(); }} accessibilityRole="button" style={{ marginTop: 16 }}>
                            <Text style={{ fontSize: 14, color: theme.colors.textLink, ...Typography.default('semiBold') }}>{t('common.retry')}</Text>
                        </Pressable>
                    </View>
                ) : !gitStatusFiles ? (
                    <View style={{
                        flex: 1,
                        justifyContent: 'center',
                        alignItems: 'center',
                        paddingTop: 40,
                        paddingHorizontal: 20
                    }}>
                        <Octicons name="git-branch" size={48} color={theme.colors.textSecondary} />
                        <Text style={{
                            fontSize: 16,
                            color: theme.colors.textSecondary,
                            textAlign: 'center',
                            marginTop: 16,
                            ...Typography.default()
                        }}>
                            {t('files.notRepo')}
                        </Text>
                        <Text style={{
                            fontSize: 14,
                            color: theme.colors.textSecondary,
                            textAlign: 'center',
                            marginTop: 8,
                            ...Typography.default()
                        }}>
                            {t('files.notUnderGit')}
                        </Text>
                    </View>
                ) : searchQuery || (gitStatusFiles.totalStaged === 0 && gitStatusFiles.totalUnstaged === 0) ? (
                    // Show search results or all files when clean repo
                    isSearching ? (
                        <View style={{
                            flex: 1,
                            justifyContent: 'center',
                            alignItems: 'center',
                            paddingTop: 40
                        }}>
                            <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                            <Text style={{
                                fontSize: 16,
                                color: theme.colors.textSecondary,
                                textAlign: 'center',
                                marginTop: 16,
                                ...Typography.default()
                            }}>
                                {t('files.searching')}
                            </Text>
                        </View>
                    ) : searchResults.length === 0 ? (
                        <View style={{
                            flex: 1,
                            justifyContent: 'center',
                            alignItems: 'center',
                            paddingTop: 40,
                            paddingHorizontal: 20
                        }}>
                            <Octicons name={searchQuery ? "search" : "file-directory"} size={48} color={theme.colors.textSecondary} />
                            <Text style={{
                                fontSize: 16,
                                color: theme.colors.textSecondary,
                                textAlign: 'center',
                                marginTop: 16,
                                ...Typography.default()
                            }}>
                                {searchQuery ? t('files.noFilesFound') : t('files.noFilesInProject')}
                            </Text>
                            {searchQuery && (
                                <Text style={{
                                    fontSize: 14,
                                    color: theme.colors.textSecondary,
                                    textAlign: 'center',
                                    marginTop: 8,
                                    ...Typography.default()
                                }}>
                                    {t('files.tryDifferentTerm')}
                                </Text>
                            )}
                        </View>
                    ) : (
                        // Show search results or all files
                        <>
                            {searchQuery && (
                                <View style={{
                                    backgroundColor: theme.colors.surfaceHigh,
                                    paddingHorizontal: 16,
                                    paddingVertical: 12,
                                    borderBottomWidth: Platform.select({ ios: 0.33, default: 1 }),
                                    borderBottomColor: theme.colors.divider
                                }}>
                                    <Text style={{
                                        fontSize: 14,
                                        fontWeight: '600',
                                        color: theme.colors.textLink,
                                        ...Typography.default()
                                    }}>
                                        {t('files.searchResults', { count: searchResults.length })}
                                    </Text>
                                </View>
                            )}
                            {searchResults.map((file, index) => (
                                <Item
                                    key={`file-${file.fullPath}-${index}`}
                                    title={file.fileName}
                                    subtitle={file.filePath || t('files.projectRoot')}
                                    icon={renderFileIconForSearch(file)}
                                    onPress={() => handleFilePress(file)}
                                    showDivider={index < searchResults.length - 1}
                                />
                            ))}
                        </>
                    )
                ) : (
                    <>
                        {/* Staged Changes Section */}
                        {gitStatusFiles.stagedFiles.length > 0 && (
                            <>
                                <View style={{
                                    backgroundColor: theme.colors.surfaceHigh,
                                    paddingHorizontal: 16,
                                    paddingVertical: 12,
                                    borderBottomWidth: Platform.select({ ios: 0.33, default: 1 }),
                                    borderBottomColor: theme.colors.divider
                                }}>
                                    <Text style={{
                                        fontSize: 14,
                                        fontWeight: '600',
                                        color: theme.colors.success,
                                        ...Typography.default()
                                    }}>
                                        {t('files.stagedChanges', { count: gitStatusFiles.stagedFiles.length })}
                                    </Text>
                                </View>
                                {gitStatusFiles.stagedFiles.map((file, index) =>
                                    renderGitFileItem(
                                        file,
                                        index,
                                        'staged',
                                        index === gitStatusFiles.stagedFiles.length - 1 && gitStatusFiles.unstagedFiles.length === 0
                                    )
                                )}
                            </>
                        )}

                        {/* Unstaged Changes Section */}
                        {gitStatusFiles.unstagedFiles.length > 0 && (
                            <>
                                <View style={{
                                    backgroundColor: theme.colors.surfaceHigh,
                                    paddingHorizontal: 16,
                                    paddingVertical: 12,
                                    borderBottomWidth: Platform.select({ ios: 0.33, default: 1 }),
                                    borderBottomColor: theme.colors.divider
                                }}>
                                    <Text style={{
                                        fontSize: 14,
                                        fontWeight: '600',
                                        color: theme.colors.warning,
                                        ...Typography.default()
                                    }}>
                                        {t('files.unstagedChanges', { count: gitStatusFiles.unstagedFiles.length })}
                                    </Text>
                                </View>
                                {gitStatusFiles.unstagedFiles.map((file, index) =>
                                    renderGitFileItem(
                                        file,
                                        index,
                                        'unstaged',
                                        index === gitStatusFiles.unstagedFiles.length - 1
                                    )
                                )}
                            </>
                        )}
                    </>
                )}
            </ItemList>
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        maxWidth: layout.maxWidth,
        alignSelf: 'center',
        width: '100%',
    }
}));
