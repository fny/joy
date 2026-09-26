import { afterEach, beforeEach, expect, test, vi } from 'vitest';
const native = vi.hoisted(() => ({
    start: vi.fn(async () => {}), finish: vi.fn(async () => 'file:///clip.wav'), stop: vi.fn(async () => {}),
    listeners: new Map<string, (event: any) => void>(), deleted: vi.fn(),
}));
vi.mock('../../modules/joy-voice-audio', () => ({ getVoiceAudio: () => ({
    startRecording: native.start, finishRecording: native.finish, stopRecording: native.stop,
    addListener: (event: string, callback: (data: any) => void) => {
        native.listeners.set(event, callback); return { remove: () => { native.listeners.delete(event); } };
    },
}) }));
vi.mock('expo-file-system', () => ({ File: class { exists = true; delete = native.deleted; } }));
import { createSpeechInput } from './speechInput.ios';
beforeEach(() => { vi.clearAllMocks(); native.listeners.clear(); native.start.mockResolvedValue(); native.finish.mockResolvedValue('file:///clip.wav'); vi.useFakeTimers(); vi.setSystemTime(1000); });
afterEach(() => vi.useRealTimers());
const settle = async () => { for (let n = 0; n < 20; n++) await Promise.resolve(); };
test('voice-processed levels segment a WAV and transfer cleanup to the caller', async () => {
    const heard = vi.fn(); const start = vi.fn();
    const input = createSpeechInput({ onSpeechStart: start, onRecording: heard, onError: vi.fn() });
    await input.start();
    for (const db of [-20, -20, -20, ...Array(9).fill(-60)]) {
        native.listeners.get('level')!({ db }); vi.setSystemTime(Date.now() + 100);
    }
    await settle();
    expect(start).toHaveBeenCalledOnce(); expect(heard).toHaveBeenCalledOnce();
    const clip = heard.mock.calls[0][0]; expect(clip.mimeType).toBe('audio/wav');
    expect(native.deleted).not.toHaveBeenCalled(); clip.dispose(); expect(native.deleted).toHaveBeenCalledOnce();
    await input.stop(); expect(native.listeners.size).toBe(0);
});
test('stopping during rotation discards a late clip without delivering it', async () => {
    let finish!: (uri: string) => void;
    native.finish.mockReturnValueOnce(new Promise<string>(resolve => { finish = resolve; }));
    const heard = vi.fn(); const input = createSpeechInput({ onSpeechStart: vi.fn(), onRecording: heard, onError: vi.fn() });
    await input.start();
    for (const db of [-20, -20, -20, ...Array(9).fill(-60)]) {
        native.listeners.get('level')!({ db }); vi.setSystemTime(Date.now() + 100);
    }
    const stopped = input.stop(); finish('file:///late.wav'); await stopped;
    expect(heard).not.toHaveBeenCalled(); expect(native.deleted).toHaveBeenCalledOnce();
});
test('stop and restart await a late native start before acquiring capture again', async () => {
    let ready!: () => void;
    native.start.mockReturnValueOnce(new Promise<void>(resolve => { ready = resolve; }));
    const input = createSpeechInput({ onSpeechStart: vi.fn(), onRecording: vi.fn(), onError: vi.fn() });
    const first = input.start(); await settle(); const stopped = input.stop(); const second = input.start();
    await settle(); expect(native.start).toHaveBeenCalledTimes(1);
    ready(); await Promise.all([first, stopped, second]);
    expect(native.start).toHaveBeenCalledTimes(2); await input.stop();
});
