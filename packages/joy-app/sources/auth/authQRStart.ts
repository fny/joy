import { getRandomBytes } from 'expo-crypto';
import sodium from '@/encryption/libsodium.lib';
import axios from 'axios';
import { encodeBase64 } from '../encryption/base64';
import { getServerUrl, relayAccessKeyHeaders } from '@/sync/serverConfig';
import { getJoyClientId } from '@/sync/clientId';

export interface QRAuthKeyPair {
    publicKey: Uint8Array;
    secretKey: Uint8Array;
}

export function generateAuthKeyPair(): QRAuthKeyPair {
    const secret = getRandomBytes(32);
    const keypair = sodium.crypto_box_seed_keypair(secret);
    return {
        publicKey: keypair.publicKey,
        secretKey: keypair.privateKey,
    };
}

export async function authQRStart(keypair: QRAuthKeyPair): Promise<boolean> {
    try {
        const serverUrl = getServerUrl();
        if (process.env.EXPO_PUBLIC_DEBUG) {
            console.log(`[AUTH DEBUG] Sending auth request to: ${serverUrl}/joy/v2/auth/account/request`);
            console.log(`[AUTH DEBUG] Public key: ${encodeBase64(keypair.publicKey).substring(0, 20)}...`);
        }

        await axios.post(`${serverUrl}/joy/v2/auth/account/request`, {
            publicKey: encodeBase64(keypair.publicKey),
        }, {
            headers: {
                'X-Joy-Client': getJoyClientId(),
                // axios bypasses the fetch interceptor (#186)
                ...relayAccessKeyHeaders(serverUrl),
            }
        });

        if (process.env.EXPO_PUBLIC_DEBUG) {
            console.log('[AUTH DEBUG] Auth request sent successfully');
        }
        return true;
    } catch (error) {
        if (process.env.EXPO_PUBLIC_DEBUG) {
            console.log('[AUTH DEBUG] Failed to send auth request:', error);
        }
        console.log('Failed to create authentication request, please try again later.');
        return false;
    }
}