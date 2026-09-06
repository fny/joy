import * as React from 'react';
import { Platform } from 'react-native';
import { CameraView } from 'expo-camera';
import { useAuth } from '@/auth/AuthContext';
import { decodeBase64 } from '@/encryption/base64';
import { encryptBox } from '@/encryption/libsodium';
import { authApprove, AuthRequestNotFoundError, PairingCodeExpiredError } from '@/auth/authApprove';
import { isScannerCancellation, useCheckScannerPermissions } from '@/hooks/useCheckCameraPermissions';
import { errorMessage } from '@/utils/guardAsync';
import { Modal } from '@/modal';
import { t } from '@/text';
import { sync } from '@/sync/sync';

interface UseConnectTerminalOptions {
    onSuccess?: () => void;
    onError?: (error: any) => void;
}

export function useConnectTerminal(options?: UseConnectTerminalOptions) {
    const auth = useAuth();
    const [isLoading, setIsLoading] = React.useState(false);
    const checkScannerPermissions = useCheckScannerPermissions();

    // Callbacks and credentials are read through refs so that processAuthUrl
    // — and with it the scanner subscription below — keeps ONE identity for
    // the life of the hook. Callers pass an inline options object, so every
    // parent rerender used to give processAuthUrl a new identity, the effect
    // cleaned up, and its cleanup dismissed the iOS scanner the user was
    // still pointing at a QR code (#313).
    const optionsRef = React.useRef(options);
    optionsRef.current = options;
    const credentialsRef = React.useRef(auth.credentials);
    credentialsRef.current = auth.credentials;

    const processAuthUrl = React.useCallback(async (url: string) => {
        if (!url.startsWith('joy://terminal?')) {
            Modal.alert(t('common.error'), t('modals.invalidAuthUrl'), [{ text: t('common.ok') }]);
            return false;
        }

        setIsLoading(true);
        try {
            const credentials = credentialsRef.current;
            if (!credentials) {
                throw new Error('Not logged in');
            }
            const tail = url.slice('joy://terminal?'.length);
            const publicKey = decodeBase64(tail, 'base64url');
            let responseV2Bundle = new Uint8Array(sync.encryption.contentDataKey.length + 1);
            responseV2Bundle[0] = 0;
            responseV2Bundle.set(sync.encryption.contentDataKey, 1);
            const responseV2 = encryptBox(responseV2Bundle, publicKey);
            await authApprove(credentials.token, publicKey, responseV2);

            Modal.alert(t('common.success'), t('modals.terminalConnectedSuccessfully'), [
                {
                    text: t('common.ok'),
                    onPress: () => optionsRef.current?.onSuccess?.()
                }
            ]);
            return true;
        } catch (e) {
            console.error(e);
            // An expired/foreign link is not a transport failure: say what
            // to do (fresh link, right relay) instead of "failed" (#187), and
            // an expired code says so (#610). Exactly ONE alert either way —
            // the specific line replaces the generic one, never joins it.
            const message = e instanceof PairingCodeExpiredError
                ? e.message
                : e instanceof AuthRequestNotFoundError
                    ? t('terminal.pairingRequestNotFound')
                    : t('modals.failedToConnectTerminal');
            Modal.alert(t('common.error'), message, [{ text: t('common.ok') }]);
            optionsRef.current?.onError?.(e);
            return false;
        } finally {
            setIsLoading(false);
        }
    }, []);

    const connectTerminal = React.useCallback(async () => {
        if (await checkScannerPermissions()) {
            // Use camera scanner. Backing out of Android's code scanner rejects
            // (BarcodeScanningCancelledException) — that is a normal exit; a
            // real launch failure is shown (#312).
            try {
                await CameraView.launchScanner({
                    barcodeTypes: ['qr']
                });
            } catch (e) {
                if (isScannerCancellation(e)) return;
                console.error('Failed to launch scanner', e);
                Modal.alert(t('common.error'), errorMessage(e), [{ text: t('common.ok') }]);
                optionsRef.current?.onError?.(e);
            }
        } else {
            Modal.alert(t('common.error'), t('modals.cameraPermissionsRequiredToConnectTerminal'), [{ text: t('common.ok') }]);
        }
    }, [checkScannerPermissions]);

    const connectWithUrl = React.useCallback(async (url: string) => {
        return await processAuthUrl(url);
    }, [processAuthUrl]);

    // Set up barcode scanner listener — once per mount; it is torn down (and
    // the iOS scanner dismissed) only on unmount (#313).
    const isProcessingRef = React.useRef(false);
    React.useEffect(() => {
        if (CameraView.isModernBarcodeScannerAvailable) {
            const subscription = CameraView.onModernBarcodeScanned(async (event) => {
                if (isProcessingRef.current) return;
                if (event.data.startsWith('joy://terminal?')) {
                    isProcessingRef.current = true;
                    try {
                        if (Platform.OS === 'ios') {
                            try {
                                await CameraView.dismissScanner();
                            } catch (e) {
                                console.warn('Failed to dismiss scanner', e);
                            }
                        }
                        await processAuthUrl(event.data);
                    } finally {
                        isProcessingRef.current = false;
                    }
                }
            });
            return () => {
                subscription.remove();
                isProcessingRef.current = false;
                if (Platform.OS === 'ios') {
                    CameraView.dismissScanner().catch((e: unknown) => {
                        console.warn('Failed to dismiss scanner during cleanup', e);
                    });
                }
            };
        }
    }, [processAuthUrl]);

    return {
        connectTerminal,
        connectWithUrl,
        isLoading,
        processAuthUrl
    };
}
