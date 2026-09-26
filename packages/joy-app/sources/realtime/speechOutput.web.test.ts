import { afterEach, expect, test, vi } from 'vitest';
import { createSpeechOutput } from './speechOutput.web';

afterEach(() => vi.unstubAllGlobals());
async function fixture() {
    const source = { connect: vi.fn(), disconnect: vi.fn(), start: vi.fn(), stop: vi.fn(), onended: null as (() => void) | null };
    const ctx = {
        state: 'running', destination: {}, resume: vi.fn(async () => {}), close: vi.fn(async () => {}),
        decodeAudioData: vi.fn(async () => ({})), createBufferSource: vi.fn(() => source),
    };
    vi.stubGlobal('AudioContext', vi.fn(function () { return ctx; }));
    const output = createSpeechOutput(); await output.prepare();
    return { output, source, ctx, controller: new AbortController(), wav: new Uint8Array([1]) };
}
test('waits for playback to end and disconnects the source', async () => {
    const { output, source, controller, wav } = await fixture();
    const finished = vi.fn();
    const playing = output.play(wav, controller.signal).then(finished);
    await Promise.resolve();
    expect(source.start).toHaveBeenCalledOnce();
    expect(finished).not.toHaveBeenCalled();
    source.onended!(); await playing;
    expect(finished).toHaveBeenCalledOnce();
    expect(source.disconnect).toHaveBeenCalledOnce();
});
test.each(['abort', 'dispose'] as const)('%s stops playback and releases its source', async reason => {
    const { output, source, ctx, controller, wav } = await fixture();
    const playing = output.play(wav, controller.signal);
    await Promise.resolve();
    if (reason === 'abort') controller.abort(); else await output.dispose();
    await playing;
    expect(source.stop).toHaveBeenCalledOnce();
    expect(source.disconnect).toHaveBeenCalledOnce();
    if (reason === 'dispose') expect(ctx.close).toHaveBeenCalledOnce();
});
test('does not start audio cancelled while it is decoding', async () => {
    const { output, source, ctx, controller, wav } = await fixture();
    let decoded!: (value: object) => void;
    ctx.decodeAudioData.mockReturnValue(new Promise(resolve => { decoded = resolve; }));
    const playing = output.play(wav, controller.signal);
    controller.abort(); decoded({}); await playing;
    expect(source.start).not.toHaveBeenCalled();
});
test('reports a playback start failure and releases its source', async () => {
    const { output, source, controller, wav } = await fixture();
    source.start.mockImplementation(() => { throw new Error('Audio unavailable'); });
    await expect(output.play(wav, controller.signal)).rejects.toThrow('Audio unavailable');
    expect(source.disconnect).toHaveBeenCalledOnce();
});
