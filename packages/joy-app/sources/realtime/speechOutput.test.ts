import { beforeEach, expect, test, vi } from 'vitest';
const m = vi.hoisted(() => ({
    prepare: vi.fn(async () => {}), play: vi.fn(), stop: vi.fn(), dispose: vi.fn(async () => {}),
    write: vi.fn(), deleted: vi.fn(), finish: null as null | (() => void),
}));
vi.mock('../../modules/joy-voice-audio', () => ({ getVoiceAudio: () => ({ preparePlayback: m.prepare, play: m.play, stopPlayback: m.stop, disposePlayback: m.dispose }) }));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'test' }));
vi.mock('expo-file-system', () => ({ Paths: { cache: '/tmp' }, File: class { exists = true; uri = 'cache.wav'; write = m.write; delete = m.deleted; } }));
import { createSpeechOutput } from './speechOutput';
beforeEach(() => {
    vi.clearAllMocks();
    m.prepare.mockResolvedValue();
    m.play.mockImplementation(() => new Promise<void>(resolve => { m.finish = resolve; }));
    m.stop.mockImplementation(async () => { m.finish?.(); });
});
test('native playback uses voice audio and deletes its temporary file on completion', async () => {
    const output = createSpeechOutput(); await output.prepare();
    const playing = output.play(new Uint8Array([1]), new AbortController().signal);
    await vi.waitFor(() => expect(m.play).toHaveBeenCalledWith('cache.wav'));
    m.finish!(); await playing;
    expect(m.deleted).toHaveBeenCalledOnce();
});
test('native cancellation stops playback and releases the audio file', async () => {
    const output = createSpeechOutput(); const controller = new AbortController();
    const playing = output.play(new Uint8Array([1]), controller.signal);
    await vi.waitFor(() => expect(m.play).toHaveBeenCalledOnce());
    controller.abort(); await output.dispose(); await playing;
    expect(m.stop).toHaveBeenCalledOnce(); expect(m.dispose).toHaveBeenCalledOnce(); expect(m.deleted).toHaveBeenCalledOnce();
});
test('cancellation during native audio preparation never starts playback', async () => {
    let ready!: () => void;
    m.prepare.mockReturnValueOnce(new Promise<void>(resolve => { ready = resolve; }));
    const output = createSpeechOutput(); const controller = new AbortController();
    const playing = output.play(new Uint8Array([1]), controller.signal);
    controller.abort(); ready(); await playing;
    expect(m.play).not.toHaveBeenCalled(); expect(m.deleted).toHaveBeenCalledOnce();
});
