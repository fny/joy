import type { SpeechOutput } from './types';

/** Complete clips share the browser audio context unlocked by the mic tap. */
export function createSpeechOutput(): SpeechOutput {
    let context: AudioContext | null = null;
    let disposed = false;
    const active = new Set<() => void>();
    return {
        async prepare() {
            if (disposed) return;
            const ctx = new AudioContext();
            context = ctx;
            await ctx.resume();
            if (!disposed && ctx.state !== 'running') throw new Error('Audio playback is blocked. Tap the microphone to try again.');
        },
        async play(wav, signal) {
            const ctx = context;
            if (!ctx || disposed || signal.aborted) return;
            const buffer = await ctx.decodeAudioData(wav.slice().buffer as ArrayBuffer);
            if (disposed || signal.aborted) return;
            await new Promise<void>((resolve, reject) => {
                const source = ctx.createBufferSource();
                const finish = () => {
                    source.onended = null;
                    signal.removeEventListener('abort', cancel);
                    active.delete(cancel);
                    source.disconnect();
                    resolve();
                };
                const cancel = () => {
                    try { source.stop(); } catch { /* Already ended. */ }
                    finish();
                };
                source.buffer = buffer;
                source.connect(ctx.destination);
                source.onended = finish;
                active.add(cancel);
                signal.addEventListener('abort', cancel, { once: true });
                try { source.start(); }
                catch (error) { reject(error); cancel(); }
            });
        },
        async dispose() {
            disposed = true;
            for (const cancel of active) cancel();
            const ctx = context;
            context = null;
            await ctx?.close().catch(() => {});
        },
    };
}
