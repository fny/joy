import axios from 'axios';
import { decodeBase64, encodeBase64 } from '../encryption/base64';
import { getServerUrl } from '@/sync/serverConfig';
import { QRAuthKeyPair } from './authQRStart';
import { decryptBox } from '@/encryption/libsodium';
import { getJoyClientId } from '@/sync/clientId';

export interface AuthCredentials {
    secret: Uint8Array;
    token: string;
}

export async function authQRWait(keypair: QRAuthKeyPair, onProgress?: (dots: number) => void, shouldCancel?: () => boolean): Promise<AuthCredentials | null> {
    let dots = 0;
    const serverUrl = getServerUrl();
    // Hard stop. The relay forgets an answered request after ten minutes and
    // a repeat poll of a forgotten key CREATES a new pending request, so a
    // screen that slept across the approval would otherwise poll forever
    // for a QR the user already approved (#127). Twenty minutes covers any
    // real approval; after that the user re-scans a fresh code.
    const deadline = Date.now() + 20 * 60 * 1000;

    while (true) {
        if (shouldCancel && shouldCancel()) {
            return null;
        }
        if (Date.now() > deadline) {
            console.log('\n\nPairing request expired. Please start again.');
            return null;
        }

        try {
            const response = await axios.post(`${serverUrl}/joy/v2/auth/account/request`, {
                publicKey: encodeBase64(keypair.publicKey),
            }, {
                headers: {
                    'X-Joy-Client': getJoyClientId(),
                }
            });

            // The relay hands the answer out once (#70). 'consumed' means
            // someone else collected it — or our own earlier poll did and the
            // reply was lost — and 'expired' that it aged out: neither can
            // succeed by polling on, so stop and let the user re-scan.
            if (response.data.state === 'consumed' || response.data.state === 'expired') {
                console.log(`\n\nPairing request ${response.data.state}. Please start again.`);
                return null;
            }
            if (response.data.state === 'authorized') {
                const token = response.data.token as string;
                const encryptedResponse = decodeBase64(response.data.response);
                
                const decrypted = decryptBox(encryptedResponse, keypair.secretKey);
                if (decrypted) {
                    console.log('\n\n✓ Authentication successful\n');
                    return {
                        secret: decrypted,
                        token: token
                    };
                } else {
                    console.log('\n\nFailed to decrypt response. Please try again.');
                    return null;
                }
            }
        } catch (error) {
            console.log('\n\nFailed to check authentication status. Please try again.');
            return null;
        }

        // Call progress callback if provided
        if (onProgress) {
            onProgress(dots);
        }
        dots++;

        // Wait 1 second before next check
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
}