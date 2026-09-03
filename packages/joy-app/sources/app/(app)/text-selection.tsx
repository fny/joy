import React from 'react';
import { View, Text, ScrollView, TextInput, Pressable } from 'react-native';
import { useRouter, useLocalSearchParams, useNavigation } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { retrieveTempText } from '@/sync/persistence';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import * as Clipboard from 'expo-clipboard';
import { Modal } from '@/modal';
import Ionicons from '@expo/vector-icons/Ionicons';
import { insertIntoComposer } from '@/-session/composerBridge';

export default function TextSelectionScreen() {
    const router = useRouter();
    const navigation = useNavigation();
    const { textId, sessionId } = useLocalSearchParams<{ textId: string; sessionId?: string }>();
    const { theme } = useUnistyles();
    const insets = useSafeAreaInsets();
    const [fullText, setFullText] = React.useState<string>('');
    const [loading, setLoading] = React.useState(true);

    // Copy functionality
    const handleCopyAll = React.useCallback(async () => {
        if (!fullText) {
            Modal.alert(t('common.error'), t('textSelection.noTextToCopy'));
            return;
        }

        try {
            await Clipboard.setStringAsync(fullText);
            Modal.alert(t('textSelection.textCopied'));
        } catch (error) {
            Modal.alert(t('common.error'), t('textSelection.failedToCopy'));
        }
    }, [fullText]);

    // Reuse: put the ORIGINAL markdown (this screen holds it verbatim) back
    // into the session's composer and return to the chat. Only offered when
    // the screen was opened from a session whose composer is mounted.
    const handleReuse = React.useCallback(() => {
        if (!sessionId || !fullText) return;
        if (insertIntoComposer(sessionId, fullText)) router.back();
    }, [sessionId, fullText, router]);

    // Header: Reuse (when it can work) then Copy — the two actions this screen
    // exists for, where the whole message is in view rather than under every
    // bubble in the chat.
    React.useLayoutEffect(() => {
        const disabled = loading || !fullText;
        const tint = disabled ? theme.colors.textSecondary : theme.colors.header.tint;
        navigation.setOptions({
            headerRight: () => (
                <View style={styles.headerActions}>
                    {!!sessionId && (
                        <Pressable
                            onPress={handleReuse}
                            style={({ pressed }) => [styles.copyButton, { opacity: pressed ? 0.7 : 1 }]}
                            disabled={disabled}
                            accessibilityRole="button"
                            accessibilityLabel={t('message.reuse')}
                        >
                            <Ionicons name="create-outline" size={24} color={tint} />
                        </Pressable>
                    )}
                    <Pressable
                        onPress={handleCopyAll}
                        style={({ pressed }) => [styles.copyButton, { opacity: pressed ? 0.7 : 1 }]}
                        disabled={disabled}
                        accessibilityRole="button"
                        accessibilityLabel={t('common.copy')}
                    >
                        <Ionicons name="copy-outline" size={24} color={tint} />
                    </Pressable>
                </View>
            ),
        });
    }, [navigation, handleCopyAll, handleReuse, sessionId, loading, fullText, theme]);

    React.useEffect(() => {
        if (!textId) {
            Modal.alert(t('common.error'), t('textSelection.noTextProvided'), [
                { text: t('common.ok'), onPress: () => router.back() }
            ]);
            return;
        }

        const content = retrieveTempText(textId);
        if (content) {
            setFullText(content);
        } else {
            Modal.alert(t('common.error'), t('textSelection.textNotFound'), [
                { text: t('common.ok'), onPress: () => router.back() }
            ]);
        }
        setLoading(false);
    }, [textId, router]);

    if (loading) {
        return (
            <View style={styles.container}>
                <Text style={[styles.loadingText, { color: theme.colors.textSecondary }]}>
                    {t('common.loading')}
                </Text>
            </View>
        );
    }

    return (
        <View style={[styles.container, { backgroundColor: theme.colors.surface }]}>
            <ScrollView 
                style={styles.textContainer} 
                showsVerticalScrollIndicator={true}
                contentContainerStyle={[
                    styles.scrollContent,
                    { paddingBottom: insets.bottom + 16 }
                ]}
            >
                <TextInput
                    style={[styles.textInput, { 
                        color: theme.colors.text,
                        backgroundColor: 'transparent'
                    }]}
                    value={fullText}
                    multiline={true}
                    editable={false}
                    selectTextOnFocus={false}
                    scrollEnabled={false}
                />
            </ScrollView>
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    headerActions: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
    },
    container: {
        flex: 1,
        backgroundColor: theme.colors.surface,
    },
    loadingText: {
        ...Typography.default(),
        fontSize: 16,
        textAlign: 'center',
        marginTop: 50,
    },
    textContainer: {
        flex: 1,
        padding: 16,
    },
    scrollContent: {
        flexGrow: 1,
    },
    textInput: {
        ...Typography.mono(),
        fontSize: 14,
        lineHeight: 20,
        color: theme.colors.text,
        minHeight: 200,
        textAlignVertical: 'top',
        backgroundColor: 'transparent',
        borderWidth: 0,
        paddingHorizontal: 0,
        paddingVertical: 0,
    },
    copyButton: {
        padding: 8,
        marginRight: 8,
        borderRadius: 8,
    },
}));
