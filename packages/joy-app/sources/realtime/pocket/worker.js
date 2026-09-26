// Served from /pocket with the shared engine and locally packaged ORT runtime.
import * as ort from './ort/ort.wasm.min.mjs';
import { PocketEngine } from './core.js';
let engine;
const controller = new AbortController();
ort.env.wasm.wasmPaths = new URL('./ort/', import.meta.url).href;
// Shared WASM memory needs COOP/COEP. Keep a fallback for other app hosts.
ort.env.wasm.numThreads = self.crossOriginIsolated
    ? Math.min(4, Math.max(1, Math.floor((navigator.hardwareConcurrency || 2) / 2))) : 1;
const progress = (file, loaded, total) => self.postMessage({ type: 'progress', file, loaded, total });
let handling = false;
self.onmessage = async ({ data }) => {
    const { id, type } = data;
    if (handling) { self.postMessage({ id, error: 'Pocket TTS is busy.' }); return; }
    handling = true;
    try {
        if (type === 'prepare') {
            if (!self.crypto?.subtle) throw new Error('Local speech needs HTTPS (or localhost) to verify its model download.');
            const [assetsResponse, bundleResponse] = await Promise.all([fetch('./assets.json'), fetch('./bundle.json')]);
            if (!assetsResponse.ok || !bundleResponse.ok) throw new Error('Pocket model configuration is missing.');
            const assets = await assetsResponse.json(), bundle = await bundleResponse.json();
            let cache;
            try { cache = await caches.open('joy-pocket-' + assets.revision + assets.voicesRevision); } catch { /* private browsing / quota */ }
            const load = async (name) => {
                const descriptor = assets.files[name];
                if (!descriptor) throw new Error('Unknown Pocket model asset.');
                const url = descriptor.url;
                let response = await cache?.match(url);
                const hit = !!response;
                response ||= await fetch(url, { signal: controller.signal });
                if (!response.ok) throw new Error(`Could not download Pocket speech model (${response.status}).`);
                const bytes = new Uint8Array(descriptor.size);
                if (response.body) {
                    const reader = response.body.getReader(); let offset = 0;
                    try {
                        for (;;) {
                            const { done, value } = await reader.read();
                            if (done) break;
                            if (offset + value.length > bytes.length) throw new Error('Pocket model size mismatch.');
                            bytes.set(value, offset); offset += value.length; progress(name, offset, descriptor.size);
                        }
                        if (offset !== bytes.length) throw new Error('Pocket model download was incomplete.');
                    } finally { await reader.cancel().catch(() => {}); }
                } else {
                    const received = new Uint8Array(await response.arrayBuffer());
                    if (received.length !== bytes.length) throw new Error('Pocket model size mismatch.');
                    bytes.set(received);
                }
                const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
                const hash = Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
                if (hash !== descriptor.sha256) { await cache?.delete(url); throw new Error('Pocket model verification failed. Retry to download it again.'); }
                if (cache && !hit) { try { await cache.put(url, new Response(bytes)); } catch { /* usable for this session */ } }
                progress(name, bytes.length, bytes.length);
                return bytes;
            };
            await engine?.dispose();
            engine = new PocketEngine(ort, bundle, load, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
            await engine.prepare(data.voice, controller.signal, progress);
            self.postMessage({ id });
        } else if (type === 'generate') {
            if (!engine) throw new Error('Pocket TTS has not loaded.');
            const onChunk = data.stream ? (pcm, sampleRate) => {
                self.postMessage({ id, type: 'audio', pcm, sampleRate }, [pcm.buffer]);
            } : undefined;
            const audio = await engine.generate(data.text, controller.signal, onChunk);
            self.postMessage({ id, audio }, [audio.buffer]);
        } else throw new Error('Unknown speech request.');
    } catch (error) {
        self.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
    } finally { handling = false; }
};
