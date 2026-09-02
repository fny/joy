import React, { useState } from 'react';
import { View, TextInput, KeyboardAvoidingView, Platform } from 'react-native';
import { Stack, useRouter } from 'expo-router';
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
import { getServerUrl, validateServerUrl, getServerInfo, KNOWN_RELAYS, getRelayAccessKey, setRelayAccessKey, getDerivedRelayPerimeterKey } from '@/sync/serverConfig';
import * as Clipboard from 'expo-clipboard';
import { switchRelayAndReload, loginToRelay } from '@/sync/relaySwitch';
import { TokenStorage } from '@/auth/tokenStorage';
import { normalizeSecretKey } from '@/auth/secretKeyBackup';
import { useAuth } from '@/auth/AuthContext';
import type { AlertButton } from '@/modal';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

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
    const router = useRouter();
    const auth = useAuth();
    const serverInfo = getServerInfo();
    const [inputUrl, setInputUrl] = useState(serverInfo.isCustom ? getServerUrl() : '');
    // Perimeter key for the ACTIVE relay (joy-relay gate). Saved per relay;
    // socket reconnect picks it up (the fetch interceptor reads it live).
    const [relayKeyInput, setRelayKeyInput] = useState(getRelayAccessKey() ?? '');
    // The derived key is what a gated relay box must carry in joy-relay.env —
    // every logged-in client presents it automatically; this copy exists to
    // provision the BOX (and any pre-derivation daemon via ~/.joy/env).
    const handleCopyDerivedKey = React.useCallback(async () => {
        const k = getDerivedRelayPerimeterKey();
        if (!k) return;
        await Clipboard.setStringAsync(k);
        Modal.alert(t('server.relayCopyDerivedKey'), k.slice(0, 12) + '…', [{ text: t('common.ok') }]);
    }, []);
    const handleSaveRelayKey = React.useCallback(() => {
        setRelayAccessKey(relayKeyInput.trim() || null);
        Modal.alert(t('server.relayAccessKeySaved'), undefined, [{ text: t('common.ok') }]);
        // Bounce the socket so the handshake carries (or drops) the key now.
        // Bounce the v2 live stream so the next connect carries the new key.
        sync.stopV2Live();
        sync.startV2Live();
    }, [relayKeyInput]);
    const [error, setError] = useState<string | null>(null);
    const [isValidating, setIsValidating] = useState(false);
    const [applyingKey, setApplyingKey] = useState(false);

    const validateServer = async (url: string): Promise<boolean> => {
        try {
            setIsValidating(true);
            setError(null);
            
            // joy-relay answers its unauthenticated capabilities probe with
            // `relay: 'joy-relay'`; anything else is not a relay we can talk to.
            const response = await fetch(`${url.replace(/\/+$/, '')}/joy/v1/capabilities`, {
                method: 'GET',
                headers: {
                    'Accept': 'application/json'
                }
            });
            
            if (!response.ok) {
                setError(t('server.serverReturnedError'));
                return false;
            }
            
            const caps = await response.json().catch(() => null) as { relay?: string } | null;
            if (caps?.relay !== 'joy-relay') {
                setError(t('server.notValidJoyServer'));
                return false;
            }
            
            return true;
        } catch (err) {
            setError(t('server.failedToConnectToServer'));
            return false;
        } finally {
            setIsValidating(false);
        }
    };

    const handleSave = async () => {
        if (!inputUrl.trim()) {
            Modal.alert(t('common.error'), t('server.enterServerUrl'));
            return;
        }

        const validation = validateServerUrl(inputUrl);
        if (!validation.valid) {
            setError(validation.error || t('errors.invalidFormat'));
            return;
        }

        // Validate the server
        const isValid = await validateServer(inputUrl);
        if (!isValid) {
            return;
        }

        const confirmed = await Modal.confirm(
            t('server.changeServer'),
            t('server.continueWithServer'),
            { confirmText: t('common.continue'), destructive: true }
        );

        if (confirmed) {
            await switchRelayAndReload(inputUrl);
        }
    };

    // One key everywhere: log into every known relay with the CURRENT
    // account's secret. Relays auto-create the account on first contact, so
    // afterwards this one code restores every relay and switching never asks
    // for a key. Replaces any other account previously saved for a relay on
    // this device (deliberate — the point is converging on a single key).
    const handleApplyKeyToAll = async () => {
        const secret = auth.credentials?.secret;
        if (!secret) return;
        const confirmed = await Modal.confirm(
            t('server.relayApplyKeyAll'),
            t('server.relayApplyKeyAllMessage'),
            { confirmText: t('common.continue') }
        );
        if (!confirmed) return;
        setApplyingKey(true);
        const failed: string[] = [];
        try {
            for (const relay of KNOWN_RELAYS) {
                if (relay.url === getServerUrl()) continue; // the key's own account
                try {
                    await loginToRelay(relay.url, secret);
                } catch (err) {
                    console.error(`Apply key failed for ${relay.name}:`, err);
                    failed.push(relay.name);
                }
            }
        } finally {
            setApplyingKey(false);
        }
        if (failed.length === 0) {
            Modal.alert(t('server.relayApplyKeyAll'), t('server.relayApplyKeyAllSuccess'));
        } else {
            Modal.alert(t('common.error'), `${t('server.relayApplyKeyAllPartial')} ${failed.join(', ')}`);
        }
    };

    // How to log into a relay that has no saved account on this device.
    // Kept to three buttons per dialog (Android's native Alert caps at 3):
    // when a current key exists it takes the "log in later" slot — a
    // logged-out switch is still reachable via the custom-URL Save flow.
    const askLoginChoice = (hasCurrentKey: boolean): Promise<'current' | 'enter' | 'later' | null> =>
        new Promise((resolve) => {
            const buttons: AlertButton[] = [
                { text: t('common.cancel'), style: 'cancel', onPress: () => resolve(null) },
                hasCurrentKey
                    ? { text: t('server.relayUseCurrentKey'), onPress: () => resolve('current') }
                    : { text: t('server.relayLoginLater'), onPress: () => resolve('later') },
                { text: t('server.relayEnterKey'), onPress: () => resolve('enter') },
            ];
            Modal.alert(t('server.relayLogin'), t('server.relayLoginMessage'), buttons);
        });

    const handleSelectRelay = async (url: string, name: string) => {
        if (getServerUrl() === url) return;
        const isValid = await validateServer(url);
        if (!isValid) return;

        // Already have an account on that relay: plain switch, boots logged in.
        const existing = await TokenStorage.getCredentials(url);
        if (existing) {
            const confirmed = await Modal.confirm(
                t('server.changeServer'),
                t('server.continueWithServer'),
                { confirmText: t('common.continue'), destructive: true }
            );
            if (confirmed) {
                setInputUrl('');
                await switchRelayAndReload(url);
            }
            return;
        }

        const choice = await askLoginChoice(!!auth.credentials);
        if (!choice) return;
        try {
            if (choice === 'current' && auth.credentials) {
                await loginToRelay(url, auth.credentials.secret);
            } else if (choice === 'enter') {
                const entered = await Modal.prompt(
                    t('server.relayEnterKey'),
                    undefined,
                    { placeholder: 'XXXXX-XXXXX-XXXXX...' }
                );
                if (!entered?.trim()) return;
                await loginToRelay(url, normalizeSecretKey(entered));
            }
        } catch (error) {
            console.error('Relay login error:', error);
            Modal.alert(t('common.error'), t('server.relayLoginFailed'));
            return;
        }
        setInputUrl('');
        await switchRelayAndReload(url);
    };

    const handleReset = async () => {
        const confirmed = await Modal.confirm(
            t('server.resetToDefault'),
            t('server.resetServerDefault'),
            { confirmText: t('common.reset'), destructive: true }
        );

        if (confirmed) {
            setInputUrl('');
            await switchRelayAndReload(null);
        }
    };

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
                    <ItemGroup title={t('server.knownRelays')}>
                        {KNOWN_RELAYS.map((r) => (
                            <Item
                                key={r.key}
                                title={r.name}
                                subtitle={r.url.replace('https://', '')}
                                onPress={() => void handleSelectRelay(r.url, r.name)}
                                rightElement={getServerUrl() === r.url ? (
                                    <Ionicons name="checkmark-circle" size={22} color={theme.colors.textLink} />
                                ) : undefined}
                            />
                        ))}
                    </ItemGroup>
                    {!!auth.credentials && (
                        <ItemGroup footer={t('server.relayApplyKeyAllFooter')}>
                            <Item
                                title={t('server.relayApplyKeyAll')}
                                icon={<Ionicons name="key-outline" size={24} color={theme.colors.textLink} />}
                                onPress={() => void handleApplyKeyToAll()}
                                loading={applyingKey}
                                disabled={applyingKey}
                                showChevron={false}
                            />
                        </ItemGroup>
                    )}
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
                    <ItemGroup footer={t('server.advancedFeatureFooter')}>
                        <View style={styles.contentContainer}>
                            <Text style={styles.labelText}>{t('server.customServerUrlLabel').toUpperCase()}</Text>
                            <TextInput
                                style={[
                                    styles.textInput,
                                    isValidating && styles.textInputValidating
                                ]}
                                value={inputUrl}
                                onChangeText={(text) => {
                                    setInputUrl(text);
                                    setError(null);
                                }}
                                placeholder={t('common.urlPlaceholder')}
                                placeholderTextColor={theme.colors.input.placeholder}
                                autoCapitalize="none"
                                autoCorrect={false}
                                keyboardType="url"
                                editable={!isValidating}
                            />
                            {error && (
                                <Text style={styles.errorText}>
                                    {error}
                                </Text>
                            )}
                            {isValidating && (
                                <Text style={styles.validatingText}>
                                    {t('server.validatingServer')}
                                </Text>
                            )}
                            <View style={styles.buttonRow}>
                                <View style={styles.buttonWrapper}>
                                    <RoundButton
                                        title={t('server.resetToDefault')}
                                        size="normal"
                                        display="inverted"
                                        onPress={handleReset}
                                    />
                                </View>
                                <View style={styles.buttonWrapper}>
                                    <RoundButton
                                        title={isValidating ? t('server.validating') : t('common.save')}
                                        size="normal"
                                        action={handleSave}
                                        disabled={isValidating}
                                    />
                                </View>
                            </View>
                            {serverInfo.isCustom && (
                                <Text style={styles.statusText}>
                                    {t('server.currentlyUsingCustomServer')}
                                </Text>
                            )}
                        </View>
                    </ItemGroup>

                    </ItemList>
            </KeyboardAvoidingView>
        </>
    );
}
