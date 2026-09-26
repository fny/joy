import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSpeechInput } from './speechInput.web';
import type { SpeechRecording } from './speechInput';

class FakeTrack extends EventTarget {
    stopped = false;
    stop() { this.stopped = true; this.dispatchEvent(new Event('ended')); }
}

class FakeStream {
    track = new FakeTrack();
    getTracks() { return [this.track]; }
    getAudioTracks() { return [this.track]; }
}

class FakeMediaRecorder extends EventTarget {
    static isTypeSupported(type: string) { return type === 'audio/webm;codecs=opus'; }
    state: RecordingState = 'inactive';
    mimeType = 'audio/webm;codecs=opus';
    static instances: FakeMediaRecorder[] = [];
    constructor(_stream: FakeStream, _options?: MediaRecorderOptions) { super(); FakeMediaRecorder.instances.push(this); }
    start() { this.state = 'recording'; }
    stop() {
        if (this.state === 'inactive') throw new Error('inactive');
        this.state = 'inactive';
        const data = new Blob(['WEBM-CONTAINER-HEADER', `clip-${FakeMediaRecorder.instances.indexOf(this)}`], { type: this.mimeType });
        const dataEvent = new Event('dataavailable');
        Object.defineProperty(dataEvent, 'data', { value: data });
        this.dispatchEvent(dataEvent);
        this.dispatchEvent(new Event('stop'));
    }
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(r => { resolve = r; });
    return { promise, resolve: (value: T) => resolve(value) };
}

describe('web speech input', () => {
    let level = -60;
    let urls: Map<string, Blob>;
    let nextUrl: number;

    beforeEach(() => {
        vi.useFakeTimers();
        level = -60;
        urls = new Map();
        nextUrl = 0;
        FakeMediaRecorder.instances = [];
        vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
        vi.stubGlobal('AudioContext', class {
            state = 'running';
            resume = vi.fn(async () => {});
            close = vi.fn(async () => {});
            createMediaStreamSource() { return { connect: vi.fn(), disconnect: vi.fn() }; }
            createAnalyser() {
                return { fftSize: 2048, getFloatTimeDomainData: (buffer: Float32Array) => buffer.fill(10 ** (level / 20)) };
            }
        });
        vi.spyOn(URL, 'createObjectURL').mockImplementation(blob => {
            const url = `blob:test-${nextUrl++}`;
            urls.set(url, blob as Blob);
            return url;
        });
        vi.spyOn(URL, 'revokeObjectURL').mockImplementation(url => { urls.delete(url); });
        vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn(async () => new FakeStream()) } });
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        vi.useRealTimers();
    });

    async function sample(levelDb: number, count: number) {
        level = levelDb;
        for (let i = 0; i < count; i++) await vi.advanceTimersByTimeAsync(100);
    }

    async function settleUntil(predicate: () => boolean) {
        for (let i = 0; i < 100 && !predicate(); i++) await Promise.resolve();
        expect(predicate()).toBe(true);
    }

    it('emits two phrases with a fresh standalone container for each', async () => {
        const recordings: SpeechRecording[] = [];
        const input = createSpeechInput({ onSpeechStart: vi.fn(), onRecording: r => recordings.push(r), onError: vi.fn() });
        await input.start();

        await sample(-20, 3);
        await sample(-60, 9);
        await vi.waitFor(() => expect(recordings).toHaveLength(1));
        await sample(-20, 3);
        await sample(-60, 9);
        await vi.waitFor(() => expect(recordings).toHaveLength(2));

        const blobs = recordings.map(recording => urls.get(recording.uri)!);
        expect(await Promise.all(blobs.map(blob => blob.text()))).toEqual([
            'WEBM-CONTAINER-HEADERclip-0',
            'WEBM-CONTAINER-HEADERclip-1',
        ]);
        await Promise.all(recordings.map(recording => recording.dispose()));
        expect(urls.size).toBe(0);
        await input.stop();
    });

    it('stops a late permission stream before a restarted capture takes the mic', async () => {
        const first = deferred<FakeStream>();
        const second = deferred<FakeStream>();
        const getUserMedia = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
        vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
        const input = createSpeechInput({ onSpeechStart: vi.fn(), onRecording: vi.fn(), onError: vi.fn() });

        const firstStart = input.start();
        await settleUntil(() => getUserMedia.mock.calls.length === 1);
        const stopping = input.stop();
        const restart = input.start();
        const oldStream = new FakeStream();
        first.resolve(oldStream);
        await Promise.all([firstStart, stopping]);
        await settleUntil(() => getUserMedia.mock.calls.length === 2);
        const currentStream = new FakeStream();
        second.resolve(currentStream);
        await restart;

        expect(oldStream.track.stopped).toBe(true);
        expect(currentStream.track.stopped).toBe(false);
        await input.stop();
        expect(currentStream.track.stopped).toBe(true);
    });

    it('reports an ended microphone track instead of leaving capture armed silently', async () => {
        const onError = vi.fn();
        const input = createSpeechInput({ onSpeechStart: vi.fn(), onRecording: vi.fn(), onError });
        await input.start();
        FakeMediaRecorder.instances[0].dispatchEvent(new Event('stop'));
        expect(onError).toHaveBeenCalledOnce();
        await input.stop();
    });

    it('rejects start failures after reporting them and releasing setup resources', async () => {
        const onError = vi.fn();
        vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn(async () => { throw new Error('permission denied'); }) } });
        const input = createSpeechInput({ onSpeechStart: vi.fn(), onRecording: vi.fn(), onError });
        await expect(input.start()).rejects.toThrow('permission denied');
        expect(onError).toHaveBeenCalledOnce();
        await input.stop();
    });
});
