/**
 * File view/edit overlay panel.
 * Shown in the main content area when a file is selected from the "All Files" sidebar tab.
 * Uses Pierre for viewing file content, CodeMirror for editing (web only).
 *
 * What is on disk is a RESOURCE (sync/fileContents, keyed session + path):
 * the panel subscribes to it, polls it while a text file is open, and hands
 * a successful save back to it. Only the editor's text and the baseline it
 * was seeded from live here — unsent user intent stays out of the cache.
 */
import * as React from 'react';
import { View, ScrollView, ActivityIndicator, Pressable, Platform } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { MarkdownView } from '@/components/markdown/MarkdownView';
import { PierreDiffView } from '@/components/diff/PierreDiffView';
import { FileRenderedView, fileRenderKind, isRasterImagePath } from '@/components/FileContentRender';
import { isBinaryPath } from '@/utils/binaryFile';
import { downloadFile } from '@/utils/downloadFile';
import { sessionWriteFile } from '@/sync/ops';
import { Modal } from '@/modal';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import { layout } from '@/components/layout';
import { guarded, logError, alertError } from '@/utils/guardAsync';
import { resources } from '@/sync/resource';
import { fileContentsSpec, type FileContents } from '@/sync/fileContents';
import { useResource } from '@/hooks/useResource';

interface FileViewPanelProps {
    sessionId: string;
    filePath: string;
    /** Publishes the right-side controls (edit/preview toggle, save button) into the chat header. */
    onHeaderRightSlotChange: (slot: React.ReactNode) => void;
}

function getFileLanguage(path: string): string | null {
    const ext = path.split('.').pop()?.toLowerCase();
    const map: Record<string, string> = {
        js: 'javascript', jsx: 'javascript',
        ts: 'typescript', tsx: 'typescript',
        py: 'python',
        html: 'html', htm: 'html',
        css: 'css',
        json: 'json',
        md: 'markdown',
        xml: 'xml',
        yaml: 'yaml', yml: 'yaml',
        sh: 'bash', bash: 'bash',
        sql: 'sql',
        go: 'go',
        rs: 'rust', rust: 'rust',
        java: 'java',
        c: 'c',
        cpp: 'cpp', cc: 'cpp', cxx: 'cpp',
        php: 'php',
        rb: 'ruby',
        swift: 'swift',
        kt: 'kotlin',
        prisma: 'graphql',
        graphql: 'graphql',
        gql: 'graphql',
        toml: 'toml',
        ini: 'ini',
        env: 'bash',
        dockerfile: 'docker',
        tf: 'hcl',
        scss: 'css',
        less: 'css',
        vue: 'markup',
        svelte: 'markup',
    };
    return ext ? (map[ext] ?? null) : null;
}

function encodeStringToBase64(str: string): string {
    const encoder = new TextEncoder();
    const bytes = encoder.encode(str);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

/** Compute SHA-256 hash of a UTF-8 string (matches server's crypto.createHash('sha256').update(str).digest('hex')) */
async function computeSHA256(content: string): Promise<string> {
    const data = new TextEncoder().encode(content);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Text of a loaded resource, or null when it is binary (an empty file is ''). */
function textOf(data: FileContents | undefined): string | null {
    return data && !data.isBinary && data.content !== null ? data.content : null;
}

/** The version of the file the editor was seeded from (a load, a reload, a
 *  save). Keyed by the resource so switching files never carries it over. */
type Baseline = { key: string; content: string };
/** Per-file conflict UI: the diff view toggle and a dismissed on-disk version. */
type ConflictUi = { key: string; showDiff: boolean; dismissed: string | null };

export const FileViewPanel = React.memo(function FileViewPanel({
    sessionId,
    filePath,
    onHeaderRightSlotChange,
}: FileViewPanelProps) {
    const { theme } = useUnistyles();
    const [editContent, setEditContent] = React.useState('');
    const [displayMode, setDisplayMode] = React.useState<'edit' | 'preview'>('edit');

    const fileName = filePath.split('/').pop() || filePath;
    const language = getFileLanguage(filePath);
    const isMarkdown = language === 'markdown';
    // Renderable = has a source ⇄ preview toggle (md keeps its dedicated
    // preview; html/csv/tsv/svg go through FileRenderedView). Source (edit)
    // first. Raster images have no source view — they render from bytes; svg
    // is XML text with an image preview (#217).
    const renderKind = fileRenderKind(filePath);
    const isRaster = isRasterImagePath(filePath);
    const isSvg = renderKind === 'image' && !isRaster;
    const isRenderable = renderKind !== null && (renderKind !== 'image' || isSvg);
    // Images first, then the shared binary gate (utils/binaryFile), then text
    // (#217). A known non-image binary is never read: the panel only shows
    // the notice, and Download fetches its bytes on demand.
    const knownBinary = isBinaryPath(filePath) && !isRaster;

    const spec = React.useMemo(() => fileContentsSpec(sessionId, filePath), [sessionId, filePath]);
    const key = spec.key;
    const keyRef = React.useRef(key);
    keyRef.current = key;

    const [savingKey, setSavingKey] = React.useState<string | null>(null);
    const isSaving = savingKey === key;
    const [baseline, setBaseline] = React.useState<Baseline | null>(null);
    const loaded = baseline !== null && baseline.key === key;

    // The resource: shown from cache at once, revalidated on open, polled
    // every 5s while a text file is open (only while focused and foregrounded
    // — useActiveInterval inside — and never during a save: the save's result
    // is authoritative and enters the cache through setData).
    const file = useResource(spec, {
        enabled: !knownBinary,
        refetchInterval: loaded && !isSaving ? 5000 : 0,
        refetchOnScreenFocus: 'stale',
    });
    const data = file.data;
    const diskText = textOf(data);

    // Seed the editor from the first text version of THIS file. A late
    // response for the previous file lands in its own key, never here.
    React.useEffect(() => {
        if (loaded || diskText === null) return;
        setBaseline({ key, content: diskText });
        setEditContent(diskText);
    }, [key, loaded, diskText]);

    const hasChanges = loaded && editContent !== baseline.content;

    // External change detection is DERIVED: the disk version (polled) differs
    // from the baseline. An older poll can no longer overwrite a newer one
    // (#219 — latest wins in the resource), and a reverted edit clears the
    // warning by itself because disk equals the baseline again (#221).
    const [conflictUi, setConflictUi] = React.useState<ConflictUi>({ key, showDiff: false, dismissed: null });
    const ui = conflictUi.key === key ? conflictUi : { key, showDiff: false, dismissed: null };
    const externalChange = loaded && !isSaving && diskText !== null && diskText !== baseline.content && diskText !== ui.dismissed
        ? diskText
        : null;
    const showConflictDiff = ui.showDiff && externalChange !== null;

    // Reload installs what is on disk NOW (a fresh read), not a snapshot.
    const handleReload = React.useCallback(() => {
        const k = key;
        setConflictUi({ key: k, showDiff: false, dismissed: null });
        guarded(async () => {
            const entry = await resources.refresh(spec);
            if (keyRef.current !== k) return;
            const fresh = entry.error || entry.unavailable ? null : textOf(entry.data);
            if (fresh === null) throw new Error(entry.error ?? entry.unavailable ?? t('files.failedToRead'));
            setBaseline({ key: k, content: fresh });
            setEditContent(fresh);
        }, alertError())();
    }, [key, spec]);

    const handleDismissWarning = React.useCallback(() => {
        setConflictUi({ key, showDiff: false, dismissed: externalChange });
    }, [key, externalChange]);

    const handleShowDiff = React.useCallback(() => {
        setConflictUi({ key, showDiff: true, dismissed: null });
    }, [key]);

    /** Write `content`; on success the resource takes the saved version
     *  (setData supersedes every read that began before the write — a poll
     *  or a prefetch can no longer land pre-save contents over it, #325) and
     *  the baseline follows if this file is still on screen. */
    const commitWrite = React.useCallback(async (k: string, content: string, expectedHash: string | undefined) => {
        const response = await sessionWriteFile(sessionId, filePath, encodeStringToBase64(content), expectedHash, 'base64');
        if (!response.success) return response;
        resources.setData<FileContents>(k, { base64: encodeStringToBase64(content), content, isBinary: false });
        if (keyRef.current === k) {
            setBaseline({ key: k, content });
            setConflictUi({ key: k, showDiff: false, dismissed: null });
        }
        return response;
    }, [sessionId, filePath]);

    const handleSave = React.useCallback(async () => {
        if (!loaded || !hasChanges || isSaving) return;
        const k = key;
        const content = editContent;
        setSavingKey(k);
        try {
            const response = await commitWrite(k, content, await computeSHA256(baseline.content));
            if (response.success || keyRef.current !== k) return;
            if (response.error?.includes('hash') || response.error?.includes('mismatch')) {
                // Disk moved under us: read it and open the conflict view on it.
                const entry = await resources.refresh(spec);
                if (keyRef.current !== k) return;
                if (textOf(entry.data) !== null) setConflictUi({ key: k, showDiff: true, dismissed: null });
                else Modal.alert(t('files.fileConflict'), t('files.fileConflictDescription'));
            } else {
                Modal.alert(t('common.error'), response.error || t('files.failedToSave'));
            }
        } finally {
            setSavingKey((s) => (s === k ? null : s));
        }
    }, [loaded, hasChanges, isSaving, key, editContent, baseline, commitWrite, spec]);

    const handleForceSave = React.useCallback(async () => {
        if (!loaded || isSaving) return;
        const k = key;
        const content = editContent;
        setSavingKey(k);
        try {
            // Re-read for the current hash, then overwrite that version.
            const entry = await resources.refresh(spec);
            if (keyRef.current !== k) return;
            const current = textOf(entry.data);
            const response = await commitWrite(k, content, current !== null ? await computeSHA256(current) : undefined);
            if (!response.success && keyRef.current === k) Modal.alert(t('common.error'), response.error || t('files.failedToSave'));
        } finally {
            setSavingKey((s) => (s === k ? null : s));
        }
    }, [loaded, isSaving, key, editContent, commitWrite, spec]);

    // Download what is on disk: the resource's bytes (a non-image binary is
    // read on demand — the panel never fetched it), or the editor's text.
    const downloadCurrent = React.useCallback(async () => {
        if (loaded && !isRaster) return downloadFile(fileName, { utf8: editContent });
        const entry = data ? file : await resources.ensure(spec, { staleTime: Infinity });
        if (!entry.data) throw new Error(entry.error || entry.unavailable || 'read failed');
        return downloadFile(fileName, { base64: entry.data.base64 });
    }, [loaded, isRaster, fileName, editContent, data, file, spec]);
    const download = React.useCallback(() => {
        void downloadCurrent().catch((e) => { logError(e); Modal.alert(t('common.error'), t('files.failedToRead')); });
    }, [downloadCurrent]);

    const imageBase64 = isRaster && data ? data.base64 : null;
    const isBinary = knownBinary || (data?.isBinary ?? false);
    // A read failure with nothing cached is an error state, not a spinner
    // that never clears; with a last good value on screen it is just a
    // missed revalidation.
    const loadError = !data && !knownBinary ? (file.error ?? file.unavailable) : null;
    const canDownload = loaded || !!imageBase64 || isBinary;

    React.useEffect(() => {
        onHeaderRightSlotChange(
            <FileHeaderRight
                showToggle={isMarkdown || isRenderable}
                isLoaded={loaded}
                displayMode={displayMode}
                onDisplayModeChange={setDisplayMode}
                hasChanges={hasChanges}
                isSaving={isSaving}
                onSave={handleSave}
                onDownload={download}
                canDownload={canDownload}
            />
        );
        return () => onHeaderRightSlotChange(null);
    }, [isMarkdown, isRenderable, loaded, displayMode, hasChanges, isSaving, handleSave, onHeaderRightSlotChange, download, canDownload]);

    return (
        <View style={styles.outer}>
            {/* External change warning bar */}
            {externalChange !== null && !showConflictDiff && (
                <View style={[styles.warningBar, { backgroundColor: theme.colors.warning + '18', borderBottomColor: theme.colors.divider }]}>
                    <Ionicons name="alert-circle" size={16} color={theme.colors.warning} />
                    <Text style={[styles.warningText, { color: theme.colors.text }]}>
                        {t('files.fileConflict')}
                    </Text>
                    <View style={{ flex: 1 }} />
                    <Pressable onPress={handleShowDiff} style={[styles.warningAction, { borderColor: theme.colors.divider }]}>
                        <Text style={[styles.warningActionText, { color: theme.colors.textLink }]}>Diff</Text>
                    </Pressable>
                    <Pressable onPress={handleReload} style={[styles.warningAction, { borderColor: theme.colors.divider }]}>
                        <Text style={[styles.warningActionText, { color: theme.colors.textLink }]}>{t('files.reload')}</Text>
                    </Pressable>
                    <Pressable onPress={handleDismissWarning} hitSlop={8}>
                        <Ionicons name="close" size={16} color={theme.colors.textSecondary} />
                    </Pressable>
                </View>
            )}

            {/* Conflict diff view */}
            {showConflictDiff && externalChange !== null ? (
                <View style={{ flex: 1 }}>
                    <View style={[styles.conflictHeader, { backgroundColor: theme.colors.surfaceHigh, borderBottomColor: theme.colors.divider }]}>
                        <Text style={[styles.conflictTitle, { color: theme.colors.text }]}>
                            {t('files.fileConflictDescription')}
                        </Text>
                        <View style={{ flex: 1 }} />
                        <Pressable
                            onPress={handleForceSave}
                            disabled={isSaving}
                            style={({ pressed }) => [styles.actionButton, { backgroundColor: theme.colors.textDestructive, opacity: isSaving ? 0.6 : pressed ? 0.8 : 1 }]}
                        >
                            <Text style={styles.actionButtonText}>{isSaving ? '...' : t('files.overwrite')}</Text>
                        </Pressable>
                        <Pressable
                            onPress={handleReload}
                            style={({ pressed }) => [styles.actionButton, { backgroundColor: theme.colors.textLink, opacity: pressed ? 0.8 : 1 }]}
                        >
                            <Text style={styles.actionButtonText}>{t('files.reload')}</Text>
                        </Pressable>
                        <Pressable onPress={() => setConflictUi({ key, showDiff: false, dismissed: null })} hitSlop={8} style={{ padding: 4 }}>
                            <Ionicons name="close" size={18} color={theme.colors.textSecondary} />
                        </Pressable>
                    </View>
                    <ScrollView
                        style={{ flex: 1 }}
                        contentContainerStyle={{ maxWidth: layout.maxWidth, alignSelf: 'center', width: '100%' }}
                    >
                        <PierreDiffView
                            oldFile={{ name: fileName + ' (your changes)', contents: editContent }}
                            newFile={{ name: fileName + ' (on device)', contents: externalChange }}
                            diffStyle="unified"
                            disableFileHeader={false}
                        />
                    </ScrollView>
                </View>
            ) : loadError ? (
                <View style={styles.centered}>
                    <Ionicons name="alert-circle-outline" size={32} color={theme.colors.textDestructive} />
                    <Text style={{ color: theme.colors.textSecondary, marginTop: 8, ...Typography.default() }}>
                        {loadError}
                    </Text>
                    <Pressable onPress={() => { void file.refresh(); }} style={{ marginTop: 16, paddingHorizontal: 16, paddingVertical: 8, borderRadius: 8, backgroundColor: theme.colors.button.primary.background }} accessibilityRole="button">
                        <Text style={{ color: theme.colors.button.primary.tint, ...Typography.default('semiBold') }}>{t('common.retry')}</Text>
                    </Pressable>
                </View>
            ) : imageBase64 ? (
                <FileRenderedView filePath={filePath} base64={imageBase64} />
            ) : isBinary ? (
                <View style={styles.centered}>
                    <Ionicons name="document-outline" size={32} color={theme.colors.textSecondary} />
                    <Text style={{ color: theme.colors.textSecondary, marginTop: 8, ...Typography.default() }}>
                        {t('files.binaryFile')}
                    </Text>
                    <Pressable
                        onPress={download}
                        style={{ marginTop: 16, paddingHorizontal: 16, paddingVertical: 8, borderRadius: 8, backgroundColor: theme.colors.button.primary.background }}
                        accessibilityRole="button"
                    >
                        <Text style={{ color: theme.colors.button.primary.tint, ...Typography.default('semiBold') }}>{t('files.download')}</Text>
                    </Pressable>
                </View>
            ) : !loaded ? (
                <View style={styles.centered}>
                    <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                </View>
            ) : isRenderable && !isMarkdown && displayMode === 'preview' ? (
                <FileRenderedView filePath={filePath} content={editContent} />
            ) : isMarkdown && displayMode === 'preview' ? (
                <ScrollView
                    style={{ flex: 1 }}
                    contentContainerStyle={{ padding: 16, maxWidth: layout.maxWidth, alignSelf: 'center', width: '100%' }}
                >
                    {Platform.OS === 'web' && <EditorPreviewStyles />}
                    <View {...(Platform.OS === 'web' ? { className: 'editor-preview-wrap' } as any : {})}>
                        <MarkdownView markdown={editContent} sessionId={sessionId} />
                    </View>
                </ScrollView>
            ) : (
                <View style={{ flex: 1, maxWidth: layout.maxWidth, alignSelf: 'center', width: '100%' }}>
                    <EditorView
                        value={editContent}
                        onChange={setEditContent}
                        language={language}
                    />
                </View>
            )}
        </View>
    );
});


/** Right-side header controls for the file-view overlay. */
const FileHeaderRight = React.memo(function FileHeaderRight({
    showToggle,
    isLoaded,
    displayMode,
    onDisplayModeChange,
    hasChanges,
    isSaving,
    onSave,
    onDownload,
    canDownload,
}: {
    showToggle: boolean;
    isLoaded: boolean;
    displayMode: 'edit' | 'preview';
    onDisplayModeChange: (mode: 'edit' | 'preview') => void;
    hasChanges: boolean;
    isSaving: boolean;
    onSave: () => void;
    onDownload: () => void;
    canDownload: boolean;
}) {
    const { theme } = useUnistyles();
    return (
        <>
            {canDownload && (
                <Pressable onPress={onDownload} hitSlop={8} style={{ paddingHorizontal: 6, justifyContent: 'center' }} accessibilityRole="button" accessibilityLabel="Download file">
                    <Ionicons name="download-outline" size={18} color={theme.colors.textSecondary} />
                </Pressable>
            )}
            {showToggle && isLoaded && (
                <View style={[styles.toggleRow, { backgroundColor: theme.colors.groupped.background, borderColor: theme.colors.divider }]}>
                    <Pressable
                        onPress={() => onDisplayModeChange('edit')}
                        style={[
                            styles.toggleButton,
                            displayMode === 'edit' && { backgroundColor: theme.colors.surface },
                        ]}
                    >
                        <Text style={[
                            styles.toggleText,
                            { color: theme.colors.textSecondary },
                            displayMode === 'edit' && styles.toggleTextActive,
                            displayMode === 'edit' && { color: theme.colors.text },
                        ]}>
                            {t('files.editFile')}
                        </Text>
                    </Pressable>
                    <Pressable
                        onPress={() => onDisplayModeChange('preview')}
                        style={[
                            styles.toggleButton,
                            displayMode === 'preview' && { backgroundColor: theme.colors.surface },
                        ]}
                    >
                        <Text style={[
                            styles.toggleText,
                            { color: theme.colors.textSecondary },
                            displayMode === 'preview' && styles.toggleTextActive,
                            displayMode === 'preview' && { color: theme.colors.text },
                        ]}>
                            Preview
                        </Text>
                    </Pressable>
                </View>
            )}
            {isLoaded && (
                <Pressable
                    onPress={onSave}
                    disabled={!hasChanges || isSaving}
                    style={({ pressed }) => [
                        styles.actionButton,
                        {
                            backgroundColor: hasChanges ? theme.colors.textLink : theme.colors.input.background,
                            opacity: !hasChanges ? 0.4 : isSaving ? 0.6 : pressed ? 0.8 : 1,
                        },
                    ]}
                >
                    {isSaving ? (
                        <ActivityIndicator size="small" color="white" />
                    ) : (
                        <Text style={[
                            hasChanges ? styles.actionButtonText : styles.actionButtonTextSecondary,
                            !hasChanges && { color: theme.colors.textSecondary },
                        ]}>
                            {t('files.saveFile')}
                        </Text>
                    )}
                </Pressable>
            )}
        </>
    );
});

/** CSS overrides to make MarkdownView match the editor look (web only) */
const EditorPreviewStyles = React.memo(function EditorPreviewStyles() {
    React.useEffect(() => {
        const id = 'editor-preview-styles';
        let el = document.getElementById(id);
        if (!el) {
            el = document.createElement('style');
            el.id = id;
            document.head.appendChild(el);
        }
        el.textContent = `
.editor-preview-wrap div[dir] {
    font-family: ui-monospace, "SF Mono", "Cascadia Code", "Segoe UI Mono", Menlo, Monaco, Consolas, monospace !important;
    font-size: 14px !important;
    line-height: 1.5 !important;
}
.editor-preview-wrap div[dir] div[style*="background"] {
    border-radius: 6px;
}
`;
        return () => {
            // Don't remove — other instances might still be mounted
        };
    }, []);
    return null;
});

/**
 * Lazy-loads the CodeEditor (web-only CodeMirror wrapper).
 * On native this renders the fallback stub.
 */
const EditorView = React.memo(function EditorView({
    value,
    onChange,
    language,
}: {
    value: string;
    onChange: (v: string) => void;
    language: string | null;
}) {
    const { theme } = useUnistyles();
    const [EditorComponent, setEditorComponent] = React.useState<React.ComponentType<any> | null>(null);

    React.useEffect(() => {
        if (Platform.OS !== 'web') return;
        // Dynamic import to keep native bundle clean
        import('@/components/CodeEditor').then((mod) => {
            setEditorComponent(() => mod.CodeEditor);
        }, logError);
    }, []);

    if (!EditorComponent) {
        return (
            <View style={styles.centered}>
                <ActivityIndicator size="small" color={theme.colors.textSecondary} />
            </View>
        );
    }

    return (
        <View style={{ flex: 1 }}>
            <EditorComponent
                value={value}
                onChange={onChange}
                language={language}
                darkMode={theme.dark}
            />
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    outer: {
        flex: 1,
    },
    actionButton: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 12,
        paddingVertical: 6,
        borderRadius: 6,
    },
    actionButtonText: {
        fontSize: 13,
        fontWeight: '600',
        color: 'white',
        ...Typography.default('semiBold'),
    },
    actionButtonTextSecondary: {
        fontSize: 13,
        fontWeight: '600',
        ...Typography.default('semiBold'),
    },
    toggleRow: {
        flexDirection: 'row',
        gap: 2,
        padding: 2,
        borderRadius: 8,
        borderWidth: StyleSheet.hairlineWidth,
        marginRight: 4,
    },
    toggleButton: {
        paddingHorizontal: 10,
        paddingVertical: 4,
        borderRadius: 6,
    },
    toggleText: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
    toggleTextActive: {
        fontWeight: '600',
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    warningBar: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: 16,
        paddingVertical: 8,
        borderBottomWidth: 1,
    },
    warningText: {
        fontSize: 13,
        ...Typography.default('semiBold'),
    },
    warningAction: {
        paddingHorizontal: 8,
        paddingVertical: 4,
        borderRadius: 4,
        borderWidth: 1,
        marginLeft: 4,
    },
    warningActionText: {
        fontSize: 12,
        ...Typography.default('semiBold'),
    },
    conflictHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: 16,
        paddingVertical: 10,
        borderBottomWidth: 1,
    },
    conflictTitle: {
        fontSize: 13,
        ...Typography.default(),
        flexShrink: 1,
    },
    centered: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        padding: 20,
    },
}));
