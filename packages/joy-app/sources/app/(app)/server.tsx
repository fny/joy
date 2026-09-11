import React, { useState } from 'react';
import { View, TextInput, KeyboardAvoidingView, Platform } from 'react-native';
import { Stack } from 'expo-router';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { ItemGroup } from '@/components/ItemGroup';
import { Item } from '@/components/Item';
import Ionicons from '@expo/vector-icons/Ionicons';
import { ItemList } from '@/components/ItemList';
import { RoundButton } from '@/components/RoundButton';
import { Modal } from '@/modal';
import { sync } from '@/sync/sync';
import { layout } from '@/components/layout';
import { t } from '@/text';
import { getServerUrl, getRelayAccessKey, setRelayAccessKey, getDerivedRelayPerimeterKey, relayNameForUrl } from '@/sync/serverConfig';
import { copyToClipboard } from '@/utils/clipboard';
import { switchRelayAndReload } from '@/sync/relaySwitch';
import { useAuth } from '@/auth/AuthContext';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

// The relay screen: which relay this device talks to, its perimeter key, and
// the way to change relay. There is one relay — changing it signs this device
// out first (the account stays on the old relay; the backup code restores it
// there), then the welcome screen asks for the new one.

const stylesheet = StyleSheet.create((theme) => ({
    keyboardAvoidingView: {
        flex: 1,
    },
    itemListContainer: {
        flex: 1,
    },
    contentContainer: {
        backgroundColor: theme.colors.surface,
        paddingHorizontal: 16,
        paddingVertical: 12,
        width: '100%',
        maxWidth: layout.maxWidth,
        alignSelf: 'center',
    },
    labelText: {
        ...Typography.default('semiBold'),
        fontSize: 12,
        color: theme.colors.textSecondary,
        textTransform: 'uppercase',
        letterSpacing: 0.5,
        marginBottom: 8,
    },
    textInput: {
        backgroundColor: theme.colors.input.background,
        padding: 12,
        borderRadius: 8,
        marginBottom: 8,
        ...Typography.mono(),
        fontSize: 14,
        color: theme.colors.input.text,
    },
    textInputValidating: {
        opacity: 0.6,
    },
    errorText: {
        ...Typography.default(),
        fontSize: 12,
        color: theme.colors.textDestructive,
        marginBottom: 12,
    },
    validatingText: {
        ...Typography.default(),
        fontSize: 12,
        color: theme.colors.status.connecting,
        marginBottom: 12,
    },
    buttonRow: {
        flexDirection: 'row',
        gap: 12,
        marginBottom: 12,
    },
    buttonWrapper: {
        flex: 1,
    },
    statusText: {
        ...Typography.default(),
        fontSize: 12,
        color: theme.colors.textSecondary,
        textAlign: 'center',
    },
}));

export default function ServerConfigScreen() {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const auth = useAuth();
    const url = getServerUrl();
    // Perimeter key for the relay (joy-relay gate). The fetch interceptor
    // reads it live; the v2 stream is bounced so it reconnects with it.
    const [relayKeyInput, setRelayKeyInput] = useState(getRelayAccessKey() ?? '');
    const [changing, setChanging] = useState(false);
    // The derived key is what a gated relay box must carry in joy-relay.env —
    // every logged-in client presents it automatically; this copy exists to
    // provision the BOX (and any pre-derivation daemon via ~/.joy/env).
    const handleCopyDerivedKey = React.useCallback(async () => {
        const k = getDerivedRelayPerimeterKey();
        if (!k) return;
        if (!(await copyToClipboard(k))) return;
        Modal.alert(t('server.relayCopyDerivedKey'), k.slice(0, 12) + '…', [{ text: t('common.ok') }]);
    }, []);
    const handleSaveRelayKey = React.useCallback(() => {
        setRelayAccessKey(relayKeyInput.trim() || null);
        Modal.alert(t('server.relayAccessKeySaved'), undefined, [{ text: t('common.ok') }]);
        sync.stopV2Live();
        sync.startV2Live();
    }, [relayKeyInput]);

    const handleChangeRelay = React.useCallback(async () => {
        if (!auth.isAuthenticated) {
            await switchRelayAndReload(null);
            return;
        }
        const confirmed = await Modal.confirm(
            t('server.changeRelay'),
            t('server.changeRelayMessage', { relay: relayNameForUrl(url) }),
            { confirmText: t('server.changeRelay'), destructive: true },
        );
        if (!confirmed) return;
        setChanging(true);
        try {
            await auth.logout({ forgetRelay: true });
        } catch (error) {
            Modal.alert(t('common.error'), error instanceof Error ? error.message : String(error));
        } finally {
            setChanging(false);
        }
    }, [auth, url]);

    return (
        <>
            <Stack.Screen
                options={{
                    headerShown: true,
                    headerTitle: t('server.serverConfiguration'),
                    headerBackTitle: t('common.back'),
                }}
            />

            <KeyboardAvoidingView
                style={styles.keyboardAvoidingView}
                behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
            >
                <ItemList style={styles.itemListContainer}>
                    <ItemGroup title={t('server.relayTitle')} footer={t('server.changeRelayFooter')}>
                        <Item
                            title={relayNameForUrl(url) || '—'}
                            subtitle={url.replace(/^https?:\/\//, '')}
                            icon={<Ionicons name="git-network-outline" size={29} color={theme.colors.accents.green} />}
                            showChevron={false}
                        />
                        <Item
                            title={t('server.changeRelay')}
                            icon={<Ionicons name="swap-horizontal-outline" size={24} color={theme.colors.textDestructive} />}
                            onPress={() => void handleChangeRelay()}
                            loading={changing}
                            disabled={changing}
                            showChevron={false}
                        />
                    </ItemGroup>
                    <ItemGroup footer={t('server.relayAccessKeyFooter')}>
                        <View style={styles.contentContainer}>
                            <Text style={styles.labelText}>{t('server.relayAccessKeyLabel').toUpperCase()}</Text>
                            <TextInput
                                style={styles.textInput}
                                value={relayKeyInput}
                                onChangeText={setRelayKeyInput}
                                placeholder="—"
                                placeholderTextColor={theme.colors.input.placeholder}
                                autoCapitalize="none"
                                autoCorrect={false}
                                secureTextEntry
                            />
                            <View style={styles.buttonRow}>
                                <View style={styles.buttonWrapper}>
                                    <RoundButton
                                        title={t('common.save')}
                                        size="normal"
                                        onPress={handleSaveRelayKey}
                                    />
                                </View>
                                {getDerivedRelayPerimeterKey() && (
                                    <View style={styles.buttonWrapper}>
                                        <RoundButton
                                            title={t('server.relayCopyDerivedKey')}
                                            size="normal"
                                            display="inverted"
                                            onPress={handleCopyDerivedKey}
                                        />
                                    </View>
                                )}
                            </View>
                        </View>
                    </ItemGroup>
                </ItemList>
            </KeyboardAvoidingView>
        </>
    );
}
