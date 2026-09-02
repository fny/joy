
import axios from 'axios';
import { encodeBase64 } from "../encryption/base64";
import { getServerUrl } from "@/sync/serverConfig";
import { getJoyClientId } from '@/sync/clientId';

interface AuthRequestStatus {
    status: 'not_found' | 'pending' | 'authorized';
}

/** Answer a terminal's pairing request with the sealed content data key
 *  (the only answer shape the daemon has ever accepted from joy). */
export async function authApprove(token: string, publicKey: Uint8Array, answer: Uint8Array) {
    const API_ENDPOINT = getServerUrl();
    const publicKeyBase64 = encodeBase64(publicKey);
    
    // First, check the auth request status
    const statusResponse = await axios.get<AuthRequestStatus>(
        `${API_ENDPOINT}/joy/v2/auth/request/status`,
        {
            params: {
                publicKey: publicKeyBase64
            },
            headers: {
                'X-Joy-Client': getJoyClientId(),
            }
        }
    );
    
    const { status } = statusResponse.data;
    
    // Handle different status cases
    if (status === 'not_found') {
        // Already authorized, no need to approve again
        console.log('Auth request already authorized or not found');
        return;
    }
    
    if (status === 'authorized') {
        // Already authorized, no need to approve again
        console.log('Auth request already authorized');
        return;
    }
    
    // Handle pending status
    if (status === 'pending') {
        await axios.post(`${API_ENDPOINT}/joy/v2/auth/response`, {
            publicKey: publicKeyBase64,
            response: encodeBase64(answer)
        }, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'X-Joy-Client': getJoyClientId(),
            }
        });
    }
}