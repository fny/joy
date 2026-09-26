import { reportPocketProgress } from './progress';
import type { AudioChunk } from './core';

export function createPocketSpeech() {
    let worker: Worker | null = null;
    let nextId = 0;
    const pending = new Map<number, { resolve: (value: Uint8Array) => void; reject: (error: Error) => void; onChunk?: AudioChunk }>();
    let disposed = false;
    const fail = (error: Error) => {
        worker?.terminate(); worker = null;
        for (const promise of pending.values()) promise.reject(error);
        pending.clear();
    };
    const request = (type: string, payload: object, onChunk?: AudioChunk) => new Promise<Uint8Array>((resolve, reject) => {
        if (disposed || !worker) { reject(new Error('Pocket TTS is stopped.')); return; }
        const id = ++nextId;
        pending.set(id, { resolve, reject, onChunk });
        worker.postMessage({ id, type, ...payload });
    });
    return {
        async prepare(voice: string) {
            if (disposed) throw new Error('Pocket TTS is stopped.');
            // Static same-origin worker/runtime files are copied by pocket:prepare.
            worker = new Worker('/pocket/worker.js', { type: 'module' });
            worker.onerror = () => fail(new Error('Could not load the local speech runtime.'));
            worker.onmessageerror = () => fail(new Error('Could not read speech worker output.'));
            worker.onmessage = ({ data }) => {
                if (data.type === 'progress') { reportPocketProgress(data.file, data.loaded); return; }
                const task = pending.get(data.id);
                if (!task) return;
                if (data.type === 'audio') {
                    try { task.onChunk?.(data.pcm, data.sampleRate); }
                    catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
                    return;
                }
                pending.delete(data.id);
                data.error ? task.reject(new Error(data.error)) : task.resolve(data.audio);
            };
            await request('prepare', { voice });
        },
        async generate(text: string, signal: AbortSignal, onChunk?: AudioChunk) {
            const abort = () => { const error = new Error('Speech stopped'); error.name = 'AbortError'; fail(error); };
            if (signal.aborted) { abort(); throw new Error('Speech stopped'); }
            signal.addEventListener('abort', abort, { once: true });
            try { return await request('generate', { text, stream: !!onChunk }, onChunk); }
            finally { signal.removeEventListener('abort', abort); }
        },
        dispose() { disposed = true; fail(new Error('Speech stopped')); },
    };
}
