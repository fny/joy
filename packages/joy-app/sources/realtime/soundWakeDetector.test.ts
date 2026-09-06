import { describe, expect, it } from 'vitest';
import { SOUND_WAKE, SpeechDetector } from './soundWakeDetector';

const { CALIBRATION_SAMPLES, SPEECH_SAMPLES_NEEDED } = SOUND_WAKE;

/** Feed `n` samples at `level`; return how many of them reported speech. */
function feed(d: SpeechDetector, level: number, n: number): number {
    let fired = 0;
    for (let i = 0; i < n; i++) if (d.push(level)) fired++;
    return fired;
}

describe('SpeechDetector', () => {
    it('learns the room before making any wake decision', () => {
        const d = new SpeechDetector();
        expect(d.calibrated).toBe(false);
        // Loud from the very first sample: still no wake during calibration.
        expect(feed(d, -20, CALIBRATION_SAMPLES)).toBe(0);
        expect(d.calibrated).toBe(true);
    });

    it('never wakes on constant background noise (#347)', () => {
        // The issue's scenario: steady -35 dBFS road noise, well above the
        // old -60 starting floor + 12 margin.
        const d = new SpeechDetector();
        expect(feed(d, -35, 300)).toBe(0);
        expect(d.floor).toBeGreaterThan(-37);
        expect(d.floor).toBeLessThan(-33);
    });

    it('wakes on speech above a quiet floor and needs a full burst', () => {
        const d = new SpeechDetector();
        feed(d, -60, CALIBRATION_SAMPLES + 20);
        // Three voiced samples are not enough …
        expect(feed(d, -25, SPEECH_SAMPLES_NEEDED - 1)).toBe(0);
        // … the fourth completes the burst.
        expect(d.push(-25)).toBe(true);
    });

    it('wakes on speech over a hum once the hum is the floor', () => {
        const d = new SpeechDetector();
        feed(d, -35, 100);
        // Speech 15 dB over the hum.
        expect(feed(d, -20, SPEECH_SAMPLES_NEEDED)).toBe(1);
    });

    it('clears the window after a wake so the next burst starts fresh', () => {
        const d = new SpeechDetector();
        feed(d, -60, CALIBRATION_SAMPLES + 5);
        expect(feed(d, -25, SPEECH_SAMPLES_NEEDED)).toBe(1);
        expect(feed(d, -25, SPEECH_SAMPLES_NEEDED - 1)).toBe(0);
        expect(d.push(-25)).toBe(true);
    });

    it('ignores sound below the absolute minimum in a silent room', () => {
        const d = new SpeechDetector();
        feed(d, -75, CALIBRATION_SAMPLES + 10);
        // 30 dB above the floor but under MIN_SPEECH_DB: a whisper of a fan.
        expect(feed(d, -45, 20)).toBe(0);
    });

    it('a restarted detector seeded with the previous floor stays quiet in the hum', () => {
        // Return-to-idle used to reset the floor to -60 and fire again on the
        // same noise (#347). A preserved floor keeps the room knowledge.
        const first = new SpeechDetector();
        feed(first, -35, 100);
        const second = new SpeechDetector(first.floor);
        expect(feed(second, -35, 100)).toBe(0);
    });

    it('absorbs a hum that starts after calibration instead of firing forever', () => {
        const d = new SpeechDetector();
        feed(d, -60, CALIBRATION_SAMPLES + 10);
        // A fan turns on: one wake is the accepted cost …
        const fired = feed(d, -35, 400);
        expect(fired).toBeGreaterThanOrEqual(1);
        // … but the floor has risen to the hum, so a fresh window is quiet.
        expect(d.floor).toBeGreaterThan(-38);
        expect(feed(d, -35, 50)).toBe(0);
    });

    it('speech barely moves the floor', () => {
        const d = new SpeechDetector();
        feed(d, -60, CALIBRATION_SAMPLES + 20);
        const before = d.floor;
        feed(d, -25, SPEECH_SAMPLES_NEEDED);
        expect(d.floor - before).toBeLessThan(3);
    });

    it('ignores non-finite samples and a non-finite seed', () => {
        const d = new SpeechDetector(Number.NaN);
        expect(d.floor).toBe(SOUND_WAKE.DEFAULT_FLOOR);
        expect(d.push(Number.NaN)).toBe(false);
        expect(d.push(-Infinity)).toBe(false);
        expect(d.calibrated).toBe(false);
    });
});
