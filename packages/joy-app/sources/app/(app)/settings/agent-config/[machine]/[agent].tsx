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
import { machineConfigRead, machineConfigSchema, machineConfigSet, machineConfigWrite } from '@/sync/v2/machine';

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

export default React.memo(function AgentConfigEditorScreen() {
    const { theme } = useUnistyles();
    const params = useLocalSearchParams<{ machine: string; agent: string }>();
    const machineId = String(params.machine ?? '');
    const agent = String(params.agent ?? '');

    const [mode, setMode] = React.useState<'walk' | 'raw'>('walk');
    const [reply, setReply] = React.useState<ReadReply | null>(null);
    const [schema, setSchema] = React.useState<any | null>(null);
    const [schemaError, setSchemaError] = React.useState<string | null>(null);
    const [rawDraft, setRawDraft] = React.useState('');
    const [assignLine, setAssignLine] = React.useState('');
    const [busy, setBusy] = React.useState(false);
    const [expanded, setExpanded] = React.useState<Set<string>>(new Set());

    const load = React.useCallback(async () => {
        try {
            const rctx = sync.machineOnlyCtx(machineId);
            if (!rctx) throw new Error('no machine context');
            const r = await machineConfigRead(rctx, agent).then(r => r.data as unknown as ReadReply);
            setReply(r);
            if (r.ok && typeof r.raw === 'string') setRawDraft(r.raw);
        } catch (e) {
            setReply({ ok: false, error: e instanceof Error ? e.message : String(e) });
        }
    }, [machineId, agent]);

    React.useEffect(() => {
        void load();
        (async () => {
            try {
                const s = await (function(){ const ctx0 = sync.machineOnlyCtx(machineId); if (!ctx0) return Promise.reject(new Error('no machine context')); return machineConfigSchema(ctx0, agent).then(r => r.data as unknown as { ok: boolean; schema?: unknown; error?: string }); })();
                if (s.ok) setSchema(s.schema);
                else { setSchemaError(s.error ?? 'no schema'); setMode('raw'); }
            } catch (e) {
                setSchemaError(e instanceof Error ? e.message : String(e));
                setMode('raw');
            }
        })();
    }, [machineId, agent, load]);

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

    const saveRaw = React.useCallback(async () => {
        setBusy(true);
        try {
            const r = await (function(){ const ctx0 = sync.machineOnlyCtx(machineId); if (!ctx0) return Promise.reject(new Error('no machine context')); return machineConfigWrite(ctx0, agent, rawDraft).then(r => r.data as unknown as { ok: boolean; error?: string }); })();
            if (!r.ok) { Modal.alert('Error', r.error ?? 'save failed'); return; }
            Modal.alert('Saved', 'Previous file kept as .joy-bak');
            await load();
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
            {reply && !reply.ok && <Text style={styles.error}>{reply.error}</Text>}
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
                                    onSubmitEditing={() => { if (assignLine.trim()) void applyLines([assignLine]).then(ok => ok && setAssignLine('')); }}
                                />
                                <Pressable
                                    disabled={busy || !assignLine.trim()}
                                    onPress={() => void applyLines([assignLine]).then(ok => ok && setAssignLine(''))}
                                    style={styles.applyBtn}
                                >
                                    <Text style={styles.applyBtnText}>Apply</Text>
                                </Pressable>
                            </View>
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
                                <Text style={styles.applyBtnText}>Save file</Text>
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
