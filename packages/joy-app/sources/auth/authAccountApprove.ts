import axios from 'axios';
import { encodeBase64 } from "../encryption/base64";
import { getServerUrl, relayAccessKeyHeaders } from "@/sync/serverConfig";
import { getJoyClientId } from '@/sync/clientId';

export async function authAccountApprove(token: string, publicKey: Uint8Array, answer: Uint8Array) {
    const API_ENDPOINT = getServerUrl();
    await axios.post(`${API_ENDPOINT}/joy/v2/auth/account/response`, {
        publicKey: encodeBase64(publicKey),
        response: encodeBase64(answer)
    }, {
        headers: {
            'Authorization': `Bearer ${token}`,
            'X-Joy-Client': getJoyClientId(),
            // axios does not go through the global fetch interceptor, so a
            // gated relay rejected every device approval with 401 (#186).
            ...relayAccessKeyHeaders(API_ENDPOINT),
        }
    });
}
