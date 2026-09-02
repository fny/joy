import { authChallenge } from "./authChallenge";
import axios from 'axios';
import { encodeBase64 } from "../encryption/base64";
import { getServerUrl } from "@/sync/serverConfig";
import { getJoyClientId } from '@/sync/clientId';

export async function authGetToken(secret: Uint8Array, serverUrl?: string) {
    const API_ENDPOINT = serverUrl ?? getServerUrl();
    const { challenge, signature, publicKey } = authChallenge(secret);
    const response = await axios.post(`${API_ENDPOINT}/joy/v2/auth`, { challenge: encodeBase64(challenge), signature: encodeBase64(signature), publicKey: encodeBase64(publicKey) }, {
        headers: {
            'X-Joy-Client': getJoyClientId(),
        }
    });
    const data = response.data;
    return data.token;
}