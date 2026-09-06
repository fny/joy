import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A fake expo-audio: every AudioRecorder gets its own cache file the moment
// it is prepared, like the native module, and nothing deletes it but us.
const { disk, recorders, audio, fs } = vi.hoisted(() => {
    const disk = new Set<string>();
    const recorders: FakeRecorder[] = [];
    let n = 0;
    class FakeRecorder {
        uri: string | null = null;
        recording = false;
        released = false;
        prepared = false;
        metering = -70;
        constructor(public options: unknown) { recorders.push(this); }
        async prepareToRecordAsync() {
            if (audio.prepareFails) throw new Error('prepare failed');
            this.uri = `file:///cache/recording-${++n}.m4a`;
            disk.add(this.uri);
            this.prepared = true;
        }
        record() { this.recording = true; }
        async stop() { this.recording = false; }
        release() { this.released = true; }
        getStatus() { return { metering: this.metering, isRecording: this.recording }; }
    }
    const audio = {
        prepareFails: false,
        FakeRecorder,
        setAudioModeAsync: vi.fn(async () => {}),
    };
    const fs = {
        deleteFails: false,
        deleteCalls: 0,
    };
    return { disk, recorders, audio, fs };
});
vi.mock('expo-audio', () => ({
    AudioModule: { AudioRecorder: audio.FakeRecorder },
    RecordingPresets: { LOW_QUALITY: { extension: '.m4a' } },
    setAudioModeAsync: audio.setAudioModeAsync,
}));
vi.mock('expo-file-system', () => ({
    File: class {
        constructor(private uri: string) {}
        get exists() { return disk.has(this.uri); }
        delete() {
            fs.deleteCalls++;
            if (fs.deleteFails) throw new Error('EACCES');
            disk.delete(this.uri);
        }
    },
}));

import { SOUND_WAKE_RETRY_MS, SOUND_WAKE_ROTATE_MS, isSoundWakeListening, startSoundWake, stopSoundWake } from './soundWake';
import { SOUND_WAKE } from './soundWakeDetector';

const live = () => recorders.filter(r => r.recording && !r.released);

describe('native sound wake bounds its throwaway recording (#345)', () => {
    beforeEach(async () => {
        vi.useFakeTimers();
        await stopSoundWake();
        disk.clear();
        recorders.length = 0;
        audio.prepareFails = false;
        fs.deleteFails = false;
        fs.deleteCalls = 0;
        vi.spyOn(console, 'warn').mockImplementation(() => {});
    });
    afterEach(async () => {
        await stopSoundWake();
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it('an armed phone idle for hours never holds more than one bounded file', async () => {
        await startSoundWake(() => {});
        expect(isSoundWakeListening()).toBe(true);
        expect(live()).toHaveLength(1);
        expect(disk.size).toBe(1);

        const hours = 3;
        await vi.advanceTimersByTimeAsync(hours * 60 * 60_000);

        const rotations = Math.floor((hours * 60 * 60_000) / SOUND_WAKE_ROTATE_MS);
        expect(recorders.length).toBe(rotations + 1);
        // Every superseded recording is stopped, released and deleted.
        expect(live()).toHaveLength(1);
        expect(disk.size).toBe(1);
        expect(disk.has(live()[0].uri!)).toBe(true);
        for (const r of recorders.slice(0, -1)) {
            expect(r.recording).toBe(false);
            expect(r.released).toBe(true);
            expect(disk.has(r.uri!)).toBe(false);
        }
        expect(isSoundWakeListening()).toBe(true);
    });

    it('a rotation does not happen before the period', async () => {
        await startSoundWake(() => {});
        await vi.advanceTimersByTimeAsync(SOUND_WAKE_ROTATE_MS - SOUND_WAKE.SAMPLE_MS);
        expect(recorders).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(2 * SOUND_WAKE.SAMPLE_MS);
        expect(recorders).toHaveLength(2);
    });

    it('speech after a rotation still wakes, and stop leaves nothing on disk', async () => {
        const onSpeech = vi.fn();
        await startSoundWake(onSpeech);
        await vi.advanceTimersByTimeAsync(SOUND_WAKE_ROTATE_MS + SOUND_WAKE.SAMPLE_MS);
        expect(recorders).toHaveLength(2);
        // Calibration, then a burst well above the floor.
        for (let i = 0; i < SOUND_WAKE.CALIBRATION_SAMPLES + 2; i++) await vi.advanceTimersByTimeAsync(SOUND_WAKE.SAMPLE_MS);
        live()[0].metering = -10;
        await vi.advanceTimersByTimeAsync(SOUND_WAKE.SAMPLE_MS * (SOUND_WAKE.SPEECH_SAMPLES_NEEDED + 1));
        expect(onSpeech).toHaveBeenCalledTimes(1);
        expect(isSoundWakeListening()).toBe(false);
        expect(live()).toHaveLength(0);
        expect(disk.size).toBe(0);
    });

    it('stop during a rotation releases the recorder the rotation opened', async () => {
        await startSoundWake(() => {});
        const stopAt = SOUND_WAKE_ROTATE_MS + SOUND_WAKE.SAMPLE_MS;
        // Advance exactly to the rotation tick without letting its awaits run.
        vi.advanceTimersByTime(stopAt);
        await stopSoundWake();
        await vi.advanceTimersByTimeAsync(SOUND_WAKE.SAMPLE_MS * 5);
        expect(live()).toHaveLength(0);
        expect(disk.size).toBe(0);
        expect(recorders.every(r => r.released)).toBe(true);
    });

    it('a rotation whose recorder cannot be opened is retried, and listening resumes', async () => {
        await startSoundWake(() => {});
        audio.prepareFails = true;
        await vi.advanceTimersByTimeAsync(SOUND_WAKE_ROTATE_MS + SOUND_WAKE.SAMPLE_MS);
        expect(live()).toHaveLength(0);
        expect(disk.size).toBe(0);
        expect(isSoundWakeListening()).toBe(true);
        audio.prepareFails = false;
        await vi.advanceTimersByTimeAsync(SOUND_WAKE_RETRY_MS + SOUND_WAKE.SAMPLE_MS);
        expect(live()).toHaveLength(1);
        expect(disk.size).toBe(1);
    });

    it('reports a deletion failure other than not-found, and stays silent on not-found', async () => {
        await startSoundWake(() => {});
        fs.deleteFails = true;
        await stopSoundWake();
        expect(fs.deleteCalls).toBe(1);
        expect(console.warn).toHaveBeenCalledWith(
            expect.stringContaining('not deleted'),
            expect.stringContaining('file:///cache/'),
            expect.any(Error),
        );

        vi.mocked(console.warn).mockClear();
        fs.deleteFails = false;
        await startSoundWake(() => {});
        disk.clear(); // gone underneath us
        await stopSoundWake();
        expect(fs.deleteCalls).toBe(1);
        expect(console.warn).not.toHaveBeenCalled();
    });
});
