/**
 * File view/edit overlay panel.
 * Shown in the main content area when a file is selected from the "All Files" sidebar tab.
 * Uses Pierre for viewing file content, CodeMirror for editing (web only).
 */
import * as React from 'react';
import { View, ScrollView, ActivityIndicator, Pressable, Platform } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { MarkdownView } from '@/components/markdown/MarkdownView';
import { PierreDiffView } from '@/components/diff/PierreDiffView';
import { FileRenderedView, fileRenderKind, isRasterImagePath } from '@/components/FileContentRender';
import { downloadFile } from '@/utils/downloadFile';
import { sessionReadFile, sessionWriteFile } from '@/sync/ops';
import { Modal } from '@/modal';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import { layout } from '@/components/layout';
import { useActiveInterval } from '@/hooks/useActiveInterval';
import { currentGen, isLatest, nextGen, useLatestKey } from '@/utils/latest';
import { guarded, logError, alertError, type ErrorReporter } from '@/utils/guardAsync';
import { noteForegroundFileWrite } from '@/hooks/usePrefetchFileContents';

interface FileViewPanelProps {
    sessionId: string;
    filePath: string;
    /** Publishes the right-side controls (edit/preview toggle, save button) into the chat header. */
    onHeaderRightSlotChange: (slot: React.ReactNode) => void;
}

type FileState =
    | { kind: 'loading' }
    | { kind: 'error'; message: string }
    | { kind: 'binary' }
    | { kind: 'loaded'; content: string; originalHash: string | null };

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

function isBinaryExtension(path: string): boolean {
    const ext = path.split('.').pop()?.toLowerCase();
    const binaryExts = [
        'png', 'jpg', 'jpeg', 'gif', 'bmp', 'svg', 'ico',
        'mp4', 'avi', 'mov', 'wmv', 'flv', 'webm',
        'mp3', 'wav', 'flac', 'aac', 'ogg',
        'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
        'zip', 'tar', 'gz', 'rar', '7z',
        'exe', 'dmg', 'deb', 'rpm',
        'woff', 'woff2', 'ttf', 'otf',
        'db', 'sqlite', 'sqlite3',
    ];
    return ext ? binaryExts.includes(ext) : false;
}

function decodeBase64ToBytes(base64: string): Uint8Array {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}

function decodeUtf8Bytes(bytes: Uint8Array): string {
    return new TextDecoder().decode(bytes);
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

/** Read file and decode to string, returns null on failure */
async function readFileContent(sessionId: string, filePath: string): Promise<string | null> {
    const res = await sessionReadFile(sessionId, filePath);
    if (!res.success || !res.content) return null;
    try {
        return decodeUtf8Bytes(decodeBase64ToBytes(res.content));
    } catch {
        return null;
    }
}

/** Compute SHA-256 hash of a UTF-8 string (matches server's crypto.createHash('sha256').update(str).digest('hex')) */
async function computeSHA256(content: string): Promise<string> {
    const data = new TextEncoder().encode(content);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

export const FileViewPanel = React.memo(function FileViewPanel({
    sessionId,
    filePath,
    onHeaderRightSlotChange,
}: FileViewPanelProps) {
    const { theme } = useUnistyles();
    const [fileState, setFileState] = React.useState<FileState>({ kind: 'loading' });
    const [editContent, setEditContent] = React.useState('');
    const [isSaving, setIsSaving] = React.useState(false);
    const [displayMode, setDisplayMode] = React.useState<'edit' | 'preview'>('edit');

    // External change detection
    const [externalChange, setExternalChange] = React.useState<string | null>(null); // new content from device
    const [showConflictDiff, setShowConflictDiff] = React.useState(false);

    const fileName = filePath.split('/').pop() || filePath;
    const language = getFileLanguage(filePath);
    const isMarkdown = language === 'markdown';
    // Renderable = has a source ⇄ preview toggle (md keeps its dedicated
    // preview; html/csv/tsv go through FileRenderedView). Source (edit) first.
    const renderKind = fileRenderKind(filePath);
    const isRenderable = renderKind !== null && renderKind !== 'image';
    const [imageBase64, setImageBase64] = React.useState<string | null>(null);

    const hasChanges = fileState.kind === 'loaded' && editContent !== fileState.content;

    // Every load, save and reload of THIS panel is a generation. A completion
    // (after the read, after the async hash, after the write) commits only
    // while it is still the newest — a.txt's late hash or save response can no
    // longer replace b.txt's contents or saved baseline (#218, #220).
    const fileKey = useLatestKey('file-view');

    // Load file content
    React.useEffect(() => {
        let cancelled = false;
        const gen = nextGen(fileKey);
        const stale = () => cancelled || !isLatest(fileKey, gen);
        setFileState({ kind: 'loading' });
        setExternalChange(null);
        setShowConflictDiff(false);
        setIsSaving(false); // a save still in flight belongs to the previous file

        // A read that throws (tunnel down, decode failure) shows as an error
        // in the panel instead of a spinner that never clears.
        const showReadFailure: ErrorReporter = (e) => {
            logError(e);
            if (!stale()) setFileState({ kind: 'error', message: t('files.failedToRead') });
        };

        setImageBase64(null);
        if (isBinaryExtension(filePath)) {
            if (isRasterImagePath(filePath)) {
                guarded(async () => {
                    const res = await sessionReadFile(sessionId, filePath);
                    if (stale()) return;
                    if (res.success && res.content) {
                        setImageBase64(res.content);
                        setFileState({ kind: 'binary' }); // not editable — rendered below
                    } else {
                        setFileState({ kind: 'error', message: res.error || t('files.failedToRead') });
                    }
                }, showReadFailure)();
                return () => { cancelled = true; };
            }
            setFileState({ kind: 'binary' });
            return;
        }

        guarded(async () => {
            try {
                const fileResponse = await sessionReadFile(sessionId, filePath);

                if (stale()) return;

                if (!fileResponse.success || !fileResponse.content) {
                    setFileState({ kind: 'error', message: fileResponse.error || t('files.failedToRead') });
                    return;
                }

                let rawBytes: Uint8Array;
                let decodedContent: string;
                try {
                    rawBytes = decodeBase64ToBytes(fileResponse.content);
                    decodedContent = decodeUtf8Bytes(rawBytes);
                } catch {
                    setFileState({ kind: 'binary' });
                    return;
                }

                const hasNullBytes = rawBytes.some((byte) => byte === 0);
                const nonPrintableCount = decodedContent.split('').filter(char => {
                    const code = char.charCodeAt(0);
                    return code < 32 && code !== 9 && code !== 10 && code !== 13;
                }).length;
                if (hasNullBytes || (nonPrintableCount / decodedContent.length > 0.1)) {
                    setFileState({ kind: 'binary' });
                    return;
                }

                const hash = await computeSHA256(decodedContent);
                if (stale()) return; // the hash is async too: re-check before committing
                setFileState({ kind: 'loaded', content: decodedContent, originalHash: hash });
                setEditContent(decodedContent);
            } catch {
                if (!stale()) {
                    setFileState({ kind: 'error', message: t('files.failedToRead') });
                }
            }
        }, showReadFailure)();

        return () => { cancelled = true; };
    }, [sessionId, filePath, fileKey]);

    // Poll for external changes every 5s — but ONLY while the screen is focused
    // and the app is foregrounded (useActiveInterval), so a backgrounded/locked
    // device isn't re-reading the file + hashing it every 5s (battery).
    const originalHash = fileState.kind === 'loaded' ? fileState.originalHash : null;
    useActiveInterval(() => {
        if (!originalHash) return;
        // A poll peeks at the generation without minting one: it must not
        // supersede a save in flight, but its content is dropped if a load,
        // save or reload happened while it was out.
        const gen = currentGen(fileKey);
        void (async () => {
            try {
                const content = await readFileContent(sessionId, filePath);
                if (!content || !isLatest(fileKey, gen)) return;
                const currentHash = await computeSHA256(content);
                if (!isLatest(fileKey, gen)) return;
                if (currentHash !== originalHash) {
                    setExternalChange(content);
                }
            } catch (e) {
                logError(e); // best-effort poll; the next tick retries
            }
        })();
    }, 5000, !!originalHash);

    const handleReload = React.useCallback(() => {
        if (!externalChange) return;
        const reloaded = externalChange;
        setExternalChange(null);
        setShowConflictDiff(false);
        const gen = nextGen(fileKey);
        guarded(async () => {
            const hash = await computeSHA256(reloaded);
            if (!isLatest(fileKey, gen)) return;
            setFileState({ kind: 'loaded', content: reloaded, originalHash: hash });
            setEditContent(reloaded);
        }, (e) => {
            // The warning bar comes back so the reload can be retried.
            if (isLatest(fileKey, gen)) setExternalChange(reloaded);
            alertError()(e);
        })();
    }, [externalChange, fileKey]);

    const handleDismissWarning = React.useCallback(() => {
        setExternalChange(null);
    }, []);

    const handleShowDiff = React.useCallback(() => {
        setShowConflictDiff(true);
    }, []);

    const handleSave = React.useCallback(async () => {
        if (fileState.kind !== 'loaded' || !hasChanges) return;
        setIsSaving(true);
        const gen = nextGen(fileKey);
        // A prefetch of this file that began before the save must not land
        // its pre-save read over the saved content (#325): once when the
        // write starts, once when it has landed on disk.
        noteForegroundFileWrite(sessionId, filePath);

        try {
            const base64 = encodeStringToBase64(editContent);
            const response = await sessionWriteFile(
                sessionId,
                filePath,
                base64,
                fileState.originalHash,
                'base64',
            );
            noteForegroundFileWrite(sessionId, filePath);
            if (!isLatest(fileKey, gen)) return; // another file is on screen now

            if (!response.success) {
                if (response.error?.includes('hash') || response.error?.includes('mismatch')) {
                    // Fetch the current server content for diff
                    const serverContent = await readFileContent(sessionId, filePath);
                    if (!isLatest(fileKey, gen)) return;
                    if (serverContent) {
                        setExternalChange(serverContent);
                        setShowConflictDiff(true);
                    } else {
                        Modal.alert(t('files.fileConflict'), t('files.fileConflictDescription'));
                    }
                } else {
                    Modal.alert(t('common.error'), response.error || t('files.failedToSave'));
                }
                return;
            }

            // Update original content + hash to match saved state
            setFileState({
                kind: 'loaded',
                content: editContent,
                originalHash: response.hash ?? null,
            });
            setExternalChange(null);
            setShowConflictDiff(false);
        } finally {
            if (isLatest(fileKey, gen)) setIsSaving(false);
        }
    }, [sessionId, filePath, editContent, fileState, hasChanges, fileKey]);

    const handleForceSave = React.useCallback(async () => {
        if (fileState.kind !== 'loaded') return;
        setIsSaving(true);
        const gen = nextGen(fileKey);
        noteForegroundFileWrite(sessionId, filePath); // see handleSave (#325)

        try {
            // Re-read to get current hash, then write
            const serverContent = await readFileContent(sessionId, filePath);
            const currentHash = serverContent ? await computeSHA256(serverContent) : undefined;
            if (!isLatest(fileKey, gen)) return;

            const base64 = encodeStringToBase64(editContent);
            const response = await sessionWriteFile(sessionId, filePath, base64, currentHash, 'base64');
            noteForegroundFileWrite(sessionId, filePath);
            if (!isLatest(fileKey, gen)) return;

            if (!response.success) {
                Modal.alert(t('common.error'), response.error || t('files.failedToSave'));
                return;
            }

            setFileState({
                kind: 'loaded',
                content: editContent,
                originalHash: response.hash ?? null,
            });
            setExternalChange(null);
            setShowConflictDiff(false);
        } finally {
            if (isLatest(fileKey, gen)) setIsSaving(false);
        }
    }, [sessionId, filePath, editContent, fileState, fileKey]);

    // Publish right-slot controls (edit/preview toggle, save button) into the chat header.
    const isLoaded = fileState.kind === 'loaded';
    // Download what is on disk: text/images from memory, a non-image binary
    // (never fetched — the panel only shows the notice) by reading its bytes now.
    const downloadCurrent = React.useCallback(async () => {
        if (imageBase64) return downloadFile(fileName, { base64: imageBase64 });
        if (fileState.kind === 'binary') {
            const res = await sessionReadFile(sessionId, filePath);
            if (!res.success || !res.content) throw new Error(res.error || 'read failed');
            return downloadFile(fileName, { base64: res.content });
        }
        return downloadFile(fileName, { utf8: editContent });
    }, [imageBase64, fileState.kind, sessionId, filePath, fileName, editContent]);

    React.useEffect(() => {
        onHeaderRightSlotChange(
            <FileHeaderRight
                showToggle={isMarkdown || isRenderable}
                isLoaded={isLoaded}
                displayMode={displayMode}
                onDisplayModeChange={setDisplayMode}
                hasChanges={hasChanges}
                isSaving={isSaving}
                onSave={handleSave}
                onDownload={() => { void downloadCurrent().catch(() => Modal.alert(t('common.error'), t('files.failedToRead'))); }}
                canDownload={isLoaded || !!imageBase64 || fileState.kind === 'binary'}
            />
        );
        return () => onHeaderRightSlotChange(null);
    }, [isMarkdown, isRenderable, isLoaded, displayMode, hasChanges, isSaving, handleSave, onHeaderRightSlotChange, imageBase64, fileState.kind, downloadCurrent]);

    return (
        <View style={styles.outer}>
            {/* External change warning bar */}
            {externalChange && !showConflictDiff && (
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
            {showConflictDiff && externalChange && fileState.kind === 'loaded' ? (
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
                        <Pressable onPress={() => setShowConflictDiff(false)} hitSlop={8} style={{ padding: 4 }}>
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
            ) : fileState.kind === 'loading' ? (
                <View style={styles.centered}>
                    <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                </View>
            ) : fileState.kind === 'error' ? (
                <View style={styles.centered}>
                    <Ionicons name="alert-circle-outline" size={32} color={theme.colors.textDestructive} />
                    <Text style={{ color: theme.colors.textSecondary, marginTop: 8, ...Typography.default() }}>
                        {fileState.message}
                    </Text>
                </View>
            ) : imageBase64 ? (
                <FileRenderedView filePath={filePath} base64={imageBase64} />
            ) : fileState.kind === 'binary' ? (
                <View style={styles.centered}>
                    <Ionicons name="document-outline" size={32} color={theme.colors.textSecondary} />
                    <Text style={{ color: theme.colors.textSecondary, marginTop: 8, ...Typography.default() }}>
                        {t('files.binaryFile')}
                    </Text>
                    <Pressable
                        onPress={() => { void downloadCurrent().catch(() => Modal.alert(t('common.error'), t('files.failedToRead'))); }}
                        style={{ marginTop: 16, paddingHorizontal: 16, paddingVertical: 8, borderRadius: 8, backgroundColor: theme.colors.button.primary.background }}
                        accessibilityRole="button"
                    >
                        <Text style={{ color: theme.colors.button.primary.tint, ...Typography.default('semiBold') }}>{t('files.download')}</Text>
                    </Pressable>
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
