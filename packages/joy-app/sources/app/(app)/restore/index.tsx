import React, { useState, useCallback, useRef } from 'react';
import { View, Text, ScrollView, ActivityIndicator } from 'react-native';
import { useRouter } from 'expo-router';
import { useFocusEffect } from '@react-navigation/native';
import { useAuth } from '@/auth/AuthContext';
import { RoundButton } from '@/components/RoundButton';
import { Typography } from '@/constants/Typography';
import { encodeBase64 } from '@/encryption/base64';
import { generateAuthKeyPair, authQRStart, QRAuthKeyPair } from '@/auth/authQRStart';
import { authQRWait } from '@/auth/authQRWait';
import { layout } from '@/components/layout';
import { Modal } from '@/modal';
import { t } from '@/text';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { QRCode } from '@/components/qr/QRCode';

const stylesheet = StyleSheet.create((theme) => ({
    scrollView: {
        flex: 1,
        backgroundColor: theme.colors.surface,
    },
    container: {
        flex: 1,
        alignItems: 'center',
        paddingHorizontal: 24,
    },
    contentWrapper: {
        width: '100%',
        maxWidth: layout.maxWidth,
        paddingVertical: 24,
    },
    instructionText: {
        fontSize: 20,
        color: theme.colors.text,
        marginBottom: 24,
        ...Typography.default(),
    },
    secondInstructionText: {
        fontSize: 16,
        color: theme.colors.textSecondary,
        marginBottom: 20,
        marginTop: 30,
        ...Typography.default(),
    },
    qrInstructions: {
        fontSize: 14,
        color: theme.colors.textSecondary,
        marginBottom: 16,
        lineHeight: 22,
        textAlign: 'center',
        ...Typography.default(),
    },
    textInput: {
        backgroundColor: theme.colors.input.background,
        padding: 16,
        borderRadius: 8,
        marginBottom: 24,
        fontFamily: 'IBMPlexMono-Regular',
        fontSize: 14,
        minHeight: 120,
        textAlignVertical: 'top',
        color: theme.colors.input.text,
    },
}));

export default function Restore() {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const auth = useAuth();
    const router = useRouter();
    // The keypair of the attempt currently on screen; null while none is.
    const [keypair, setKeypair] = useState<QRAuthKeyPair | null>(null);
    const [authReady, setAuthReady] = useState(false);
    const [, setWaitingDots] = useState(0);
    // Both the auth object and the router are read through refs by the async
    // attempt, so a rerender never restarts it.
    const authRef = useRef(auth);
    authRef.current = auth;
    const routerRef = useRef(router);
    routerRef.current = router;

    // A QR attempt lives exactly as long as this screen is FOCUSED (#158).
    // Pushing "Restore with Secret Key Instead" blurs this screen, which
    // cancels its attempt: a delayed QR approval can no longer log in behind
    // the manual screen and yank it away with router.back(). Coming back
    // mints a fresh keypair (the old request is dead on the relay anyway).
    // Each attempt owns its own cancellation token — the previous
    // screen-lifetime ref could not distinguish "this attempt" from "the one
    // before it".
    useFocusEffect(useCallback(() => {
        // Already signed in (e.g. manual restore just completed and popped
        // back here): nothing to pair, leave the screen.
        if (authRef.current.isAuthenticated) {
            routerRef.current.back();
            return;
        }

        let cancelled = false;
        const attempt = generateAuthKeyPair();
        setKeypair(attempt);
        setAuthReady(false);

        const run = async () => {
            try {
                // Send authentication request
                const success = await authQRStart(attempt);
                if (cancelled) return;
                if (!success) {
                    Modal.alert(t('common.error'), t('errors.authenticationFailed'));
                    return;
                }

                setAuthReady(true);

                // Start waiting for authentication
                const outcome = await authQRWait(
                    attempt,
                    (dots) => setWaitingDots(dots),
                    () => cancelled
                );
                if (cancelled || outcome.kind === 'cancelled') return;

                if (outcome.kind === 'authorized') {
                    // Convert secret bytes to base64url string for login
                    const secretString = encodeBase64(outcome.credentials.secret, 'base64url');
                    await authRef.current.login(outcome.credentials.token, secretString);
                    if (!cancelled) {
                        routerRef.current.back();
                    }
                } else {
                    // ONE alert, with the specific reason (consumed / expired,
                    // #607 #610). A generic "Authentication failed" on top of
                    // it was the double alert users saw.
                    Modal.alert(t('common.error'), outcome.message);
                }
            } catch (error) {
                if (!cancelled) {
                    console.error('QR Auth error:', error);
                    Modal.alert(t('common.error'), t('errors.authenticationFailed'));
                }
            } finally {
                if (!cancelled) {
                    setAuthReady(false);
                }
            }
        };

        void run();

        return () => {
            cancelled = true;
            setAuthReady(false);
            setKeypair(null);
        };
    }, []));

    return (
        <ScrollView style={styles.scrollView} contentContainerStyle={{ flexGrow: 1 }}>
            <View style={styles.container}>

                <View style={{justifyContent: 'flex-end' }}>
                    <Text style={styles.secondInstructionText}>
                        1. Open Joy on your mobile device{'\n'}
                        2. Go to Settings → Account{'\n'}
                        3. Tap "Link New Device"{'\n'}
                        4. Scan this QR code
                    </Text>
                </View>
                {!(authReady && keypair) && (
                    <View style={{ width: 200, height: 200, backgroundColor: theme.colors.surface, alignItems: 'center', justifyContent: 'center' }}>
                        <ActivityIndicator size="small" color={theme.colors.text} />
                    </View>
                )}
                {authReady && keypair && (
                    <QRCode
                        data={'joy:///account?' + encodeBase64(keypair.publicKey, 'base64url')}
                        size={300}
                        foregroundColor={'black'}
                        backgroundColor={'white'}
                    />
                )}
                <View style={{ flexGrow: 4, paddingTop: 30 }}>
                    <RoundButton title="Restore with Secret Key Instead" display='inverted' onPress={() => {
                        router.push('/restore/manual');
                    }} />
                </View>
            </View>
        </ScrollView>
    );
}
