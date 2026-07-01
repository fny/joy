import * as React from 'react';
import { View, Pressable, TextInput, Linking, Platform } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { Text } from '@/components/StyledText';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useSession } from '@/sync/storage';
import { sync } from '@/sync/sync';
import { Modal } from '@/modal';
import { t } from '@/text';
import { Typography } from '@/constants/Typography';

// joy-tmux surfaces an interactive auth/login URL (e.g. Claude Code's /login
// OAuth box) as session.metadata.joy__login. Shown as a pinned bar at the top of
// the chat: open or copy the URL, then paste the returned code to submit it. The
// code rides a `/login-code <code>` command that the daemon types into the CLI's
// "paste code" field. The bar auto-clears once the daemon sees the prompt gone.
export const LoginBar = React.memo(function LoginBar({ sessionId }: { sessionId: string }) {
    const { theme } = useUnistyles();
    const session = useSession(sessionId);
    const login = session?.metadata?.joy__login;
    const url = login?.url;
    const error = login?.error;
    const [code, setCode] = React.useState('');

    const onOpen = React.useCallback(() => {
        if (url) void Linking.openURL(url).catch(() => { });
    }, [url]);

    const onCopy = React.useCallback(async () => {
        if (!url) return;
        await Clipboard.setStringAsync(url);
        Modal.alert(t('common.copied'), t('joyLogin.urlCopied'));
    }, [url]);

    const onSubmit = React.useCallback(() => {
        const trimmed = code.trim();
        if (!trimmed) return;
        sync.sendMessage(sessionId, `/login-code ${trimmed}`, { source: 'chat' });
        setCode('');
    }, [sessionId, code]);

    if (!url) return null;

    return (
        <View style={[styles.bar, { backgroundColor: theme.colors.surface, borderBottomColor: theme.colors.divider }]}>
            <View style={styles.row}>
                <Ionicons name="key" size={16} color={theme.colors.textLink} style={{ marginRight: 8 }} />
                <Text style={[styles.label, { color: theme.colors.textSecondary }]}>{t('joyLogin.label')}</Text>
                <Pressable style={{ flex: 1, minWidth: 0 }} onPress={onOpen} hitSlop={6} accessibilityRole="link" accessibilityLabel={t('joyLogin.openUrl')}>
                    <Text style={[styles.url, { color: theme.colors.textLink }]} numberOfLines={1}>{url}</Text>
                </Pressable>
                <Pressable onPress={onCopy} hitSlop={8} accessibilityRole="button" accessibilityLabel={t('joyLogin.copyUrl')} style={(p) => [styles.iconBtn, { opacity: p.pressed ? 0.6 : 1 }]}>
                    <Ionicons name="copy-outline" size={18} color={theme.colors.textSecondary} />
                </Pressable>
                <Pressable onPress={onOpen} hitSlop={8} accessibilityRole="button" accessibilityLabel={t('joyLogin.openUrl')} style={(p) => [styles.iconBtn, { opacity: p.pressed ? 0.6 : 1 }]}>
                    <Ionicons name="open-outline" size={18} color={theme.colors.textSecondary} />
                </Pressable>
            </View>
            {!!error && (
                <Text style={[styles.error, { color: theme.colors.textDestructive ?? '#FF453A' }]} numberOfLines={2}>
                    {error}
                </Text>
            )}
            <View style={styles.row}>
                <TextInput
                    value={code}
                    onChangeText={setCode}
                    placeholder={t('joyLogin.codePlaceholder')}
                    placeholderTextColor={theme.colors.textSecondary as string}
                    autoCapitalize="none"
                    autoCorrect={false}
                    spellCheck={false}
                    onSubmitEditing={onSubmit}
                    returnKeyType="send"
                    style={[
                        styles.input,
                        { color: theme.colors.text, backgroundColor: theme.colors.input.background },
                        Platform.OS === 'web' ? ({ outlineStyle: 'none' } as any) : null,
                    ]}
                />
                <Pressable
                    onPress={onSubmit}
                    disabled={!code.trim()}
                    hitSlop={8}
                    accessibilityRole="button"
                    accessibilityLabel={t('joyLogin.submitCode')}
                    style={(p) => [styles.sendBtn, { backgroundColor: theme.colors.button.primary.background, opacity: !code.trim() ? 0.4 : p.pressed ? 0.7 : 1 }]}
                >
                    <Ionicons name="arrow-up" size={16} color={theme.colors.button.primary.tint} />
                </Pressable>
            </View>
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    bar: {
        paddingHorizontal: 14,
        paddingVertical: 8,
        borderBottomWidth: StyleSheet.hairlineWidth,
        gap: 8,
    },
    row: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    label: {
        fontSize: 10,
        marginRight: 8,
        ...Typography.default('semiBold'),
    },
    url: {
        fontSize: 13,
        ...Typography.default(),
    },
    error: {
        fontSize: 12,
        ...Typography.default(),
    },
    iconBtn: {
        width: 28,
        height: 28,
        alignItems: 'center',
        justifyContent: 'center',
        marginLeft: 4,
    },
    input: {
        flex: 1,
        minHeight: 36,
        borderRadius: 10,
        paddingHorizontal: 10,
        paddingVertical: 6,
        fontSize: 14,
        ...Typography.default(),
    },
    sendBtn: {
        width: 32,
        height: 32,
        borderRadius: 16,
        alignItems: 'center',
        justifyContent: 'center',
        marginLeft: 8,
    },
}));
