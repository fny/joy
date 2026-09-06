// Editor for one agent's config file on one machine. Two modes over the same
// daemon ops:
//   Walk — schema-driven rows (when the agent publishes a JSON Schema; claude
//          + opencode do). Each editable leaf applies as a merge via
//          joy-agent-config-set, so unrelated keys survive untouched.
//   Raw  — full-file text editing (joy-agent-config-write; refused daemon-side
//          unless it parses) plus a JSON-path assignment line, e.g.
//          examples[0].title = "this is an example"  (value null deletes).
//
// Personal-build dev page — plain strings, no i18n (matches the /joy pages).
import * as React from 'react';
import { View, Text, TextInput, ScrollView, ActivityIndicator, Pressable, Platform } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import Ionicons from '@expo/vector-icons/Ionicons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Modal } from '@/modal';
import { Typography } from '@/constants/Typography';
import { sync } from '@/sync/sync';
import { useMachine } from '@/sync/storage';
import { machineConfigRead, machineConfigSchema, machineConfigSet, machineConfigWrite } from '@/sync/v2/machine';
import { applyReload, applySaved, configTarget, discardEdits, emptyDraft, isDirty, parkDraft, takeParkedDraft, type RawDraftState } from '@/utils/configRawDraft';

interface ReadReply {
    ok: boolean;
    error?: string;
    path?: string;
    format?: string;
    exists?: boolean;
    raw?: string;
    parsed?: any;
    parseError?: string | null;
}

type SchemaNode = {
    type?: string | string[];
    description?: string;
    properties?: Record<string, SchemaNode>;
    enum?: unknown[];
    default?: unknown;
    $ref?: string;
    items?: SchemaNode;
    additionalProperties?: SchemaNode | boolean;
};

/** Shallow local $ref resolution (#/definitions/x, #/$defs/x). */
function deref(node: SchemaNode | undefined, root: any): SchemaNode | undefined {
    if (!node) return node;
    if (node.$ref && node.$ref.startsWith('#/')) {
        const target = node.$ref.slice(2).split('/').reduce((acc: any, k: string) => acc?.[k], root);
        if (target) return { ...target, ...node, $ref: undefined };
    }
    return node;
}

function typeLabel(node: SchemaNode): string {
    if (node.enum) return node.enum.map(v => JSON.stringify(v)).join(' | ');
    if (Array.isArray(node.type)) return node.type.join(' | ');
    return node.type ?? 'value';
}

function getAt(doc: any, path: string): unknown {
    if (!doc) return undefined;
    return path.split('.').reduce((acc: any, k: string) => acc?.[k], doc);
}

// The editor instance is KEYED by target (machine + agent): a route change to
// another machine's file used to feed that file's disk text into the previous
// file's dirty draft, and Save then wrote machine A's unsaved edits to machine
// B (#169). A new target is a new instance with its own state and its own
// in-flight reads; unsaved edits are parked on the way out and come back only
// for their own file.
export default React.memo(function AgentConfigEditorScreen() {
    const params = useLocalSearchParams<{ machine: string; agent: string }>();
    const machineId = String(params.machine ?? '');
    const agent = String(params.agent ?? '');
    return <AgentConfigEditor key={configTarget(machineId, agent)} machineId={machineId} agent={agent} />;
});

const AgentConfigEditor = React.memo(function AgentConfigEditor({ machineId, agent }: { machineId: string; agent: string }) {
    const { theme } = useUnistyles();
    const target = configTarget(machineId, agent);

    const [mode, setMode] = React.useState<'walk' | 'raw'>('walk');
    const [reply, setReply] = React.useState<ReadReply | null>(null);
    const [schema, setSchema] = React.useState<any | null>(null);
    const [schemaError, setSchemaError] = React.useState<string | null>(null);
    // Raw editor: the file as last read + what the editor shows. A reload only
    // replaces a CLEAN draft; unsaved edits survive path assignments and a
    // Save that finishes while the user keeps typing (#169). Edits parked by
    // a previous visit to THIS target are restored; the first read then
    // reports the file as changed on disk if it moved meanwhile.
    const [raw, setRaw] = React.useState<RawDraftState>(() => takeParkedDraft(target) ?? emptyDraft(target));
    const rawRef = React.useRef(raw);
    rawRef.current = raw;
    React.useEffect(() => () => parkDraft(rawRef.current), []);
    const [staleDisk, setStaleDisk] = React.useState(false);
    const rawDraft = raw.draft;
    const rawDirty = isDirty(raw);
    const setRawDraft = React.useCallback((draft: string) => setRaw((prev) => ({ ...prev, draft })), []);
    const [assignLine, setAssignLine] = React.useState('');
    const [busy, setBusy] = React.useState(false);
    const [expanded, setExpanded] = React.useState<Set<string>>(new Set());
    // The machine key arrives with machine sync; a cold-open before that (or a
    // read during a blip) must not strand the screen on an error with no way
    // back. Reads re-run when the machine record appears and on Retry (#170).
    const machine = useMachine(machineId);
    const machineReady = !!machine && !!sync.machineOnlyCtx(machineId);
    const [attempt, setAttempt] = React.useState(0);
    const retry = React.useCallback(() => setAttempt((n) => n + 1), []);

    const load = React.useCallback(async (afterSave = false) => {
        try {
            const rctx = sync.machineOnlyCtx(machineId);
            if (!rctx) throw new Error('no machine context');
            const r = await machineConfigRead(rctx, agent).then(r => r.data as unknown as ReadReply);
            setReply(r);
            if (r.ok && typeof r.raw === 'string') {
                const disk = r.raw;
                setRaw((prev) => {
                    if (afterSave) return applySaved(prev, disk, target);
                    const out = applyReload(prev, disk, target);
                    setStaleDisk(out.keptEdits);
                    return out.state;
                });
            }
        } catch (e) {
            setReply({ ok: false, error: e instanceof Error ? e.message : String(e) });
        }
    }, [machineId, agent, target]);

    React.useEffect(() => {
        if (!machineReady) {
            // Not an error yet: the key is still on its way (#170).
            setReply(machine ? { ok: false, error: 'Waiting for the machine key…' } : { ok: false, error: 'Machine not found yet — still syncing.' });
            return;
        }
        let cancelled = false;
        void load();
        (async () => {
            try {
                const s = await (function(){ const ctx0 = sync.machineOnlyCtx(machineId); if (!ctx0) return Promise.reject(new Error('no machine context')); return machineConfigSchema(ctx0, agent).then(r => r.data as unknown as { ok: boolean; schema?: unknown; error?: string }); })();
                if (cancelled) return;
                if (s.ok) { setSchema(s.schema); setSchemaError(null); }
                else { setSchemaError(s.error ?? 'no schema'); setMode('raw'); }
            } catch (e) {
                if (cancelled) return;
                setSchemaError(e instanceof Error ? e.message : String(e));
                setMode('raw');
            }
        })();
        return () => { cancelled = true; };
    }, [machineId, agent, load, machineReady, attempt]);

    const applyLines = React.useCallback(async (lines: string[]) => {
        setBusy(true);
        try {
            const r = await (function(){ const ctx0 = sync.machineOnlyCtx(machineId); if (!ctx0) return Promise.reject(new Error('no machine context')); return machineConfigSet(ctx0, agent, lines).then(r => r.data as unknown as { ok: boolean; error?: string; raw?: string }); })();
            if (!r.ok) { Modal.alert('Error', r.error ?? 'apply failed'); return false; }
            await load();
            return true;
        } catch (e) {
            Modal.alert('Error', e instanceof Error ? e.message : String(e));
            return false;
        } finally {
            setBusy(false);
        }
    }, [machineId, agent, load]);

    // A path assignment writes the FILE, not the editor: with unsaved raw edits
    // the two would diverge silently (the assignment lacks the edits; the reload
    // used to wipe them). Ask first (#169).
    const applyAssignment = React.useCallback((line: string) => {
        const run = () => void applyLines([line]).then(ok => ok && setAssignLine(''));
        if (!rawDirty) { run(); return; }
        Modal.alert(
            'Unsaved raw edits',
            'The assignment is applied to the file on disk, not to your unsaved edits. Save the editor first, or discard the edits and apply the assignment.',
            [
                { text: 'Cancel', style: 'cancel' },
                { text: 'Discard edits and apply', style: 'destructive', onPress: () => { setRaw(discardEdits); setStaleDisk(false); run(); } },
            ],
        );
    }, [applyLines, rawDirty]);

    const saveRaw = React.useCallback(async () => {
        const saving = rawDraft; // what the user pressed Save on
        setBusy(true);
        try {
            const r = await (function(){ const ctx0 = sync.machineOnlyCtx(machineId); if (!ctx0) return Promise.reject(new Error('no machine context')); return machineConfigWrite(ctx0, agent, saving).then(r => r.data as unknown as { ok: boolean; error?: string }); })();
            if (!r.ok) { Modal.alert('Error', r.error ?? 'save failed'); return; }
            Modal.alert('Saved', 'Previous file kept as .joy-bak');
            setStaleDisk(false);
            // Text typed while the save was pending is newer than what was
            // saved: the reload must not replace it (#169).
            await load(true);
        } catch (e) {
            Modal.alert('Error', e instanceof Error ? e.message : String(e));
        } finally {
            setBusy(false);
        }
    }, [machineId, agent, rawDraft, load]);

    const editLeaf = React.useCallback((path: string, node: SchemaNode, current: unknown) => {
        const stringify = (v: unknown) => v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v);
        if (node.enum) {
            // Cycle-free picker via buttons in an alert
            Modal.alert(path, `Pick a value (current: ${stringify(current) || 'unset'})`, [
                ...node.enum.slice(0, 6).map(v => ({
                    text: String(v),
                    onPress: () => void applyLines([`${path} = ${JSON.stringify(v)}`]),
                })),
                { text: 'Unset (delete key)', style: 'destructive' as const, onPress: () => void applyLines([`${path} = null`]) },
                { text: 'Cancel', style: 'cancel' as const },
            ]);
            return;
        }
        const t = Array.isArray(node.type) ? node.type[0] : node.type;
        if (t === 'boolean') {
            void applyLines([`${path} = ${current === true ? 'false' : 'true'}`]);
            return;
        }
        Modal.prompt(path, `${node.description ?? ''}\ntype: ${typeLabel(node)} — JSON or bare text; null deletes`, {
            defaultValue: stringify(current),
        }).then((value) => {
            if (value === null || value === undefined) return;
            void applyLines([`${path} = ${value}`]);
        });
    }, [applyLines]);

    const renderSchemaRows = () => {
        const root = schema as SchemaNode;
        const rootProps = deref(root, schema)?.properties;
        if (!rootProps) return <Text style={styles.dim}>Schema has no walkable properties.</Text>;
        const doc = reply?.parsed ?? {};
        const rows: React.ReactNode[] = [];
        const renderProp = (name: string, rawNode: SchemaNode, depth: number, pathPrefix: string) => {
            const node = deref(rawNode, schema) ?? rawNode;
            const path = pathPrefix ? `${pathPrefix}.${name}` : name;
            const t = Array.isArray(node.type) ? node.type[0] : node.type;
            const isObject = t === 'object' && node.properties && Object.keys(node.properties).length > 0;
            const current = getAt(doc, path);
            if (isObject) {
                const open = expanded.has(path);
                rows.push(
                    <Pressable key={path} onPress={() => setExpanded(prev => { const n = new Set(prev); open ? n.delete(path) : n.add(path); return n; })} style={[styles.row, { paddingLeft: 12 + depth * 16 }]}>
                        <Ionicons name={open ? 'chevron-down' : 'chevron-forward'} size={14} color={theme.colors.textSecondary} />
                        <View style={styles.rowBody}>
                            <Text style={styles.rowTitle}>{name}</Text>
                            {node.description ? <Text style={styles.rowSub} numberOfLines={2}>{node.description}</Text> : null}
                        </View>
                    </Pressable>
                );
                if (open) {
                    for (const [childName, childNode] of Object.entries(node.properties!)) {
                        renderProp(childName, childNode, depth + 1, path);
                    }
                }
                return;
            }
            rows.push(
                <Pressable key={path} onPress={() => editLeaf(path, node, current)} style={[styles.row, { paddingLeft: 12 + depth * 16 }]}>
                    <View style={styles.rowBody}>
                        <Text style={styles.rowTitle}>{name}</Text>
                        <Text style={styles.rowSub} numberOfLines={2}>{node.description || typeLabel(node)}</Text>
                    </View>
                    <Text style={[styles.rowValue, current === undefined && styles.dim]} numberOfLines={1}>
                        {current === undefined ? 'unset' : typeof current === 'string' ? current : JSON.stringify(current)}
                    </Text>
                </Pressable>
            );
        };
        for (const [name, node] of Object.entries(rootProps)) renderProp(name, node, 0, '');
        return rows;
    };

    return (
        <ScrollView style={styles.container} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
            <Stack.Screen options={{ headerTitle: `${agent} config` }} />
            {!reply && <ActivityIndicator style={{ paddingVertical: 24 }} />}
            {reply && !reply.ok && (
                <View style={{ gap: 12 }}>
                    <Text style={machineReady ? styles.error : styles.dim}>{reply.error}</Text>
                    {machineReady ? (
                        <Pressable onPress={retry} style={[styles.applyBtn, { alignSelf: 'flex-start' }]}>
                            <Text style={styles.applyBtnText}>Retry</Text>
                        </Pressable>
                    ) : (
                        <ActivityIndicator />
                    )}
                </View>
            )}
            {reply?.ok && (
                <>
                    <Text style={styles.pathNote}>
                        {reply.path}{reply.exists ? '' : ' (will be created)'}
                        {reply.parseError ? `\n⚠ does not parse: ${reply.parseError}` : ''}
                    </Text>
                    <View style={styles.modeRow}>
                        {(['walk', 'raw'] as const).map(m => (
                            <Pressable
                                key={m}
                                onPress={() => m === 'walk' && schemaError ? Modal.alert('No schema', schemaError) : setMode(m)}
                                style={[styles.modeChip, mode === m && styles.modeChipActive]}
                            >
                                <Text style={[styles.modeChipText, mode === m && styles.modeChipTextActive]}>
                                    {m === 'walk' ? 'Walk schema' : 'Raw'}
                                </Text>
                            </Pressable>
                        ))}
                        {busy && <ActivityIndicator size="small" />}
                    </View>

                    {mode === 'walk' && (
                        schema ? <View style={styles.card}>{renderSchemaRows()}</View>
                            : schemaError ? <Text style={styles.dim}>{schemaError} — use Raw mode.</Text>
                                : <ActivityIndicator style={{ paddingVertical: 24 }} />
                    )}

                    {mode === 'raw' && (
                        <>
                            <View style={styles.assignRow}>
                                <TextInput
                                    value={assignLine}
                                    onChangeText={setAssignLine}
                                    placeholder='examples[0].title = "this is an example"'
                                    placeholderTextColor={theme.colors.textSecondary}
                                    style={styles.assignInput}
                                    autoCapitalize="none"
                                    autoCorrect={false}
                                    spellCheck={false}
                                    onSubmitEditing={() => { if (assignLine.trim()) applyAssignment(assignLine); }}
                                />
                                <Pressable
                                    disabled={busy || !assignLine.trim()}
                                    onPress={() => applyAssignment(assignLine)}
                                    style={styles.applyBtn}
                                >
                                    <Text style={styles.applyBtnText}>Apply</Text>
                                </Pressable>
                            </View>
                            {staleDisk && (
                                <View style={styles.assignRow}>
                                    <Text style={[styles.dim, { flex: 1 }]}>The file changed on disk; the editor kept your unsaved edits.</Text>
                                    <Pressable onPress={() => { setRaw(discardEdits); setStaleDisk(false); }} style={styles.applyBtn}>
                                        <Text style={styles.applyBtnText}>Discard edits</Text>
                                    </Pressable>
                                </View>
                            )}
                            <TextInput
                                value={rawDraft}
                                onChangeText={setRawDraft}
                                multiline
                                style={styles.rawEditor}
                                autoCapitalize="none"
                                autoCorrect={false}
                                spellCheck={false}
                            />
                            <Pressable disabled={busy} onPress={() => void saveRaw()} style={styles.saveBtn}>
                                <Text style={styles.applyBtnText}>{rawDirty ? 'Save file (unsaved edits)' : 'Save file'}</Text>
                            </Pressable>
                        </>
                    )}
                </>
            )}
        </ScrollView>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: { flex: 1, backgroundColor: theme.colors.groupped.background },
    content: { padding: 16, gap: 12, maxWidth: 800, width: '100%', alignSelf: 'center', paddingBottom: 48 },
    pathNote: { color: theme.colors.textSecondary, fontSize: 12, fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }) },
    error: { color: '#FF3B30', fontSize: 14 },
    dim: { color: theme.colors.textSecondary, fontSize: 13 },
    modeRow: { flexDirection: 'row', gap: 8, alignItems: 'center' },
    modeChip: {
        paddingHorizontal: 12, paddingVertical: 6, borderRadius: 14,
        backgroundColor: theme.colors.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.divider,
    },
    modeChipActive: { backgroundColor: theme.colors.textLink, borderColor: theme.colors.textLink },
    modeChipText: { fontSize: 13, color: theme.colors.textSecondary, ...Typography.default('semiBold') },
    modeChipTextActive: { color: '#FFFFFF' },
    card: { backgroundColor: theme.colors.surface, borderRadius: 12, overflow: 'hidden' },
    row: {
        flexDirection: 'row', alignItems: 'center', gap: 8,
        paddingRight: 12, paddingVertical: 10,
        borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.divider,
    },
    rowBody: { flex: 1, gap: 1 },
    rowTitle: { color: theme.colors.text, fontSize: 14, ...Typography.default('semiBold') },
    rowSub: { color: theme.colors.textSecondary, fontSize: 12 },
    rowValue: { color: theme.colors.textLink, fontSize: 13, maxWidth: '40%' },
    assignRow: { flexDirection: 'row', gap: 8, alignItems: 'center' },
    assignInput: {
        flex: 1, color: theme.colors.text, fontSize: 13,
        fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }),
        backgroundColor: theme.colors.surface, borderRadius: 8, borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider, paddingHorizontal: 10, paddingVertical: 8,
    },
    applyBtn: { backgroundColor: theme.colors.textLink, borderRadius: 8, paddingHorizontal: 14, paddingVertical: 9 },
    applyBtnText: { color: '#FFFFFF', fontSize: 13, ...Typography.default('semiBold') },
    saveBtn: { backgroundColor: theme.colors.textLink, borderRadius: 8, paddingVertical: 10, alignItems: 'center' },
    rawEditor: {
        minHeight: 320, color: theme.colors.text, fontSize: 12, lineHeight: 17,
        fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }),
        backgroundColor: theme.colors.surface, borderRadius: 8, borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider, padding: 10, textAlignVertical: 'top',
    },
}));
