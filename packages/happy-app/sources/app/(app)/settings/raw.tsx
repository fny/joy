import * as React from 'react';
import { View, TextInput, ScrollView, Pressable } from 'react-native';
import { Text } from '@/components/StyledText';
import { StyleSheet } from 'react-native-unistyles';
import { useRouter } from 'expo-router';
import { useSettings } from '@/sync/storage';
import { sync } from '@/sync/sync';
import { Modal } from '@/modal';
import { layout } from '@/components/layout';

// Mod 13: Raw Settings editor.
//
// Shows the entire settings payload as editable JSON and replaces it wholesale
// on save (sync.replaceSettings → applySettingsRaw, NOT a merge). This lets you
// delete deprecated/unknown keys that normal toggles can't remove — the removed
// keys are dropped locally and the cleaned object is pushed to the server.
//
// Dev/debug page: strings are intentionally not internationalized.
export default React.memo(function RawSettingsScreen() {
    const router = useRouter();
    const settings = useSettings();
    const initial = React.useMemo(() => JSON.stringify(settings, null, 2), [settings]);
    const [text, setText] = React.useState(initial);
    const dirty = text !== initial;

    const onReset = React.useCallback(() => {
        setText(JSON.stringify(settings, null, 2));
    }, [settings]);

    const onSave = React.useCallback(() => {
        let parsed: unknown;
        try {
            parsed = JSON.parse(text);
        } catch (e) {
            Modal.alert('Invalid JSON', String(e instanceof Error ? e.message : e), [{ text: 'OK', style: 'cancel' }]);
            return;
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            Modal.alert('Invalid settings', 'The payload must be a JSON object.', [{ text: 'OK', style: 'cancel' }]);
            return;
        }
        Modal.alert(
            'Replace settings?',
            'This replaces the entire settings payload. Keys you removed will be deleted (locally and on the server). Keys you keep are preserved.',
            [
                { text: 'Cancel', style: 'cancel' },
                {
                    text: 'Replace',
                    style: 'destructive',
                    onPress: () => {
                        sync.replaceSettings(parsed);
                        router.back();
                    },
                },
            ],
        );
    }, [text, router]);

    return (
        <View style={styles.container}>
            <View style={styles.content}>
                <Text style={styles.hint}>
                    Edit the raw settings payload. Removing a key deletes it (including deprecated keys that no toggle controls). Saving replaces the whole object.
                </Text>
                <ScrollView style={styles.editorScroll} contentContainerStyle={styles.editorContent}>
                    <TextInput
                        style={styles.editor}
                        value={text}
                        onChangeText={setText}
                        multiline
                        autoCapitalize="none"
                        autoCorrect={false}
                        spellCheck={false}
                        textAlignVertical="top"
                    />
                </ScrollView>
                <View style={styles.actions}>
                    <Pressable style={[styles.button, styles.secondary]} onPress={onReset} disabled={!dirty}>
                        <Text style={[styles.buttonText, !dirty && styles.disabledText]}>Reset</Text>
                    </Pressable>
                    <Pressable style={[styles.button, styles.primary, !dirty && styles.disabledButton]} onPress={onSave} disabled={!dirty}>
                        <Text style={styles.primaryText}>Save</Text>
                    </Pressable>
                </View>
            </View>
        </View>
    );
});

const styles = StyleSheet.create((theme, runtime) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.groupped.background,
        alignItems: 'center',
    },
    content: {
        flex: 1,
        width: '100%',
        maxWidth: layout.maxWidth,
        padding: 16,
        gap: 12,
    },
    hint: {
        fontSize: 13,
        color: theme.colors.textSecondary,
    },
    editorScroll: {
        flex: 1,
        backgroundColor: theme.colors.surface,
        borderRadius: 12,
    },
    editorContent: {
        padding: 12,
    },
    editor: {
        flex: 1,
        minHeight: 240,
        color: theme.colors.text,
        fontFamily: runtime.fontScale ? 'monospace' : 'monospace',
        fontSize: 13,
        lineHeight: 18,
    },
    actions: {
        flexDirection: 'row',
        justifyContent: 'flex-end',
        gap: 12,
        paddingBottom: runtime.insets.bottom,
    },
    button: {
        paddingHorizontal: 20,
        paddingVertical: 10,
        borderRadius: 10,
    },
    secondary: {
        backgroundColor: theme.colors.surfaceHigh,
    },
    primary: {
        backgroundColor: theme.colors.text,
    },
    disabledButton: {
        opacity: 0.4,
    },
    buttonText: {
        fontSize: 15,
        color: theme.colors.text,
    },
    primaryText: {
        fontSize: 15,
        color: theme.colors.groupped.background,
        fontWeight: '600',
    },
    disabledText: {
        color: theme.colors.textSecondary,
    },
}));
