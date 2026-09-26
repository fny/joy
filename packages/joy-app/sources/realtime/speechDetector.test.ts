import { describe, expect, it } from 'vitest';
import { SPEECH_DETECTOR, SpeechDetector, shouldFinishSpeechClip, shouldRotateSilentRecording } from './speechDetector';

describe('SpeechDetector', () => {
    it('requires sustained speech and ignores a single ambient click', () => {
        const detector = new SpeechDetector();
        expect(detector.push(-20, 0)).toBeNull();
        expect(detector.push(-60, 100)).toBeNull();
        expect(detector.push(-60, 200)).toBeNull();
        expect(detector.push(-20, 300)).toBeNull();
        expect(detector.push(-20, 400)).toBeNull();
        expect(detector.push(-20, 500)).toBe('start');
    });

    it('ends after trailing silence and returns to idle', () => {
        const detector = new SpeechDetector();
        expect(detector.push(-20, 0)).toBeNull();
        expect(detector.push(-20, 100)).toBeNull();
        expect(detector.push(-20, 200)).toBe('start');
        expect(detector.push(-60, 300)).toBeNull();
        expect(detector.push(-60, 1_100)).toBe('end');
        expect(detector.isSpeaking).toBe(false);
    });

    it('exposes bounded capture and idle rotation timings', () => {
        expect(SPEECH_DETECTOR.ambientRotationMs).toBe(30_000);
        expect(SPEECH_DETECTOR.maxClipMs).toBe(30_000);
        expect(shouldRotateSilentRecording(false, 29_999)).toBe(false);
        expect(shouldRotateSilentRecording(false, 30_000)).toBe(true);
        expect(shouldFinishSpeechClip(true, 29_999)).toBe(false);
        expect(shouldFinishSpeechClip(true, 30_000)).toBe(true);
        expect(shouldRotateSilentRecording(true, 30_000)).toBe(false);
    });
});
