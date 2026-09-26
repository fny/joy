import { File, Directory, Paths } from 'expo-file-system';
import { createDownloadResumable } from 'expo-file-system/legacy';
import { digest, CryptoDigestAlgorithm } from 'expo-crypto';
import assets from './assets.json';
import bundle from './bundle.json';
import { PocketEngine, checkAborted, type Progress, type AudioChunk } from './core';
import { reportPocketProgress } from './progress';

// One engine at a time. A stopped native inference call must finish before its
// sessions can be released; the next activation waits for that retirement.
let retiring: Promise<unknown> = Promise.resolve();
export function createPocketSpeech() {
    const controller = new AbortController();
    let engine: PocketEngine | undefined;
    let operation: Promise<unknown> = retiring;
    let disposed = false;
    const load = async (name: string, signal: AbortSignal, progress: Progress): Promise<Uint8Array | string> => {
        const descriptor = assets.files[name as keyof typeof assets.files];
        if (!descriptor) throw new Error('Unknown Pocket model asset.');
        checkAborted(signal);
        const directory = new Directory(Paths.document, 'pocket-tts', assets.revision + assets.voicesRevision);
        directory.create({ intermediates: true, idempotent: true });
        const file = new File(directory, name);
        // Files are committed only after digest validation, never read from .part.
        if (!file.exists || file.size !== descriptor.size) {
            if (file.exists) file.delete();
            const partial = new File(directory, name + '.part');
            if (partial.exists) partial.delete();
            const download = createDownloadResumable(descriptor.url, partial.uri, {}, event => {
                if (!signal.aborted) progress(name, event.totalBytesWritten, descriptor.size);
            });
            const abort = () => { void download.cancelAsync().catch(() => {}); };
            signal.addEventListener('abort', abort, { once: true });
            let committed = false;
            try {
                const result = await download.downloadAsync();
                checkAborted(signal);
                if (!result || result.status !== 200 || partial.size !== descriptor.size) throw new Error('Pocket model download was incomplete.');
                const bytes = await partial.bytes();
                const hash = new Uint8Array(await digest(CryptoDigestAlgorithm.SHA256, bytes));
                const hex = Array.from(hash, byte => byte.toString(16).padStart(2, '0')).join('');
                if (hex !== descriptor.sha256) throw new Error('Pocket model verification failed.');
                checkAborted(signal);
                partial.move(file);
                committed = true;
            } finally {
                signal.removeEventListener('abort', abort);
                if (!committed && partial.exists) partial.delete();
            }
        }
        checkAborted(signal);
        progress(name, descriptor.size, descriptor.size);
        // Native ORT loads ONNX files from disk, avoiding a second JS copy.
        return name.endsWith('.onnx') ? file.uri.replace(/^file:\/\//, '') : file.bytes();
    };
    return {
        prepare(voice: string) {
            operation = operation.then(async () => {
                checkAborted(controller.signal);
                const ort = await import('onnxruntime-react-native');
                checkAborted(controller.signal);
                engine = new PocketEngine(ort, bundle, load, { executionProviders: ['cpu'], intraOpNumThreads: 2, interOpNumThreads: 1 });
                await engine.prepare(voice, controller.signal, reportPocketProgress);
            });
            return operation as Promise<void>;
        },
        generate(text: string, signal: AbortSignal, _onChunk?: AudioChunk): Promise<Uint8Array> {
            const abort = () => controller.abort();
            if (signal.aborted) abort();
            signal.addEventListener('abort', abort, { once: true });
            const result = operation.then(async () => {
                checkAborted(controller.signal);
                if (!engine) throw new Error('Pocket TTS has not loaded.');
                return engine.generate(text, controller.signal);
            }).finally(() => signal.removeEventListener('abort', abort));
            operation = result;
            return result;
        },
        dispose() {
            if (disposed) return;
            disposed = true;
            controller.abort();
            retiring = operation.catch(() => {}).then(() => engine?.dispose());
        },
    };
}
