import { expect, test, vi } from 'vitest';
import { PocketEngine, pcmToWav } from './core.js';

// Instrument ownership using a tiny deterministic ONNX double. This verifies
// orchestration and cleanup, not compatibility, audio quality or performance.
function fixture() {
    const tensors: Tensor[] = [];
    class Tensor {
        disposed = false;
        constructor(public type: string, public data: Float32Array | BigInt64Array | Uint8Array, public dims: number[]) { tensors.push(this); }
        dispose() { if (this.disposed) throw new Error('Double disposal'); this.disposed = true; }
    }
    const manifest = [{ input_name: 'state_0', output_name: 'out_state_0', path: 'layer/cache', key: 'cache', module: 'layer', shape: [2], dtype: 'float32', fill: 'zeros' }];
    const bundle = { flow_lm_state_manifest: manifest, mimi_state_manifest: [{ ...manifest[0], dtype: 'bool', fill: 'ones' }], latent_dim: 2, conditioning_dim: 2, sample_rate: 24000 };
    const ort = { Tensor };
    // These fields are deliberately inspected by the ownership test; app callers
    // only use prepare/generate/dispose through the public declaration.
    const engine = new PocketEngine(ort, bundle, async () => new Uint8Array(), {}) as PocketEngine & Record<string, any>;
    engine.tokenizer = { encodeIds: (text: string) => Array.from(text, c => c.codePointAt(0)) };
    engine.voice = { 'layer/cache': { data: new Float32Array([2]), shape: [1] } };
    const tensor = (data = [0], dtype = 'float32') => new Tensor(dtype, dtype === 'bool' ? new Uint8Array(data) : new Float32Array(data), [data.length]);
    const run = vi.fn(async (input: Record<string, Tensor>) => {
        if (input.token_ids) return { embedding: new Tensor('float32', new Float32Array([1, 2]), [1, 2]) };
        if (input.c) return { flow_dir: tensor([0, 0]) };
        if (input.latent) {
            expect(Array.from(input.state_0.data as Uint8Array)).toEqual([1, 1]);
            return { audio: tensor([0.25, -0.25]), out_state_0: tensor([1, 1], 'bool') };
        }
        expect(input.state_0.disposed).toBe(false);
        return { conditioning: tensor([1, 2]), eos_logit: tensor([0]), out_state_0: tensor([2, 0]) };
    });
    const release = vi.fn(async () => {});
    engine.sessions = Object.fromEntries(['text_conditioner', 'flow_lm_main', 'flow_lm_flow', 'mimi_decoder'].map(name => [name, { run, release, outputNames: [name === 'text_conditioner' ? 'embedding' : 'audio'] }]));
    return { engine, tensors, run, release };
}

test('WAV lengths, little-endian PCM and clipping match its payload', () => {
    const wav = pcmToWav([new Float32Array([-2, -0.5, 0, 0.5, 2])]);
    const view = new DataView(wav.buffer);
    expect(new TextDecoder().decode(wav.slice(0, 4))).toBe('RIFF');
    expect(view.getUint32(4, true)).toBe(wav.length - 8);
    expect(view.getUint32(40, true)).toBe(10);
    expect([0, 1, 2, 3, 4].map(i => view.getInt16(44 + i * 2, true))).toEqual([-32768, -16384, 0, 16384, 32767]);
    expect(() => pcmToWav([new Float32Array([NaN])])).toThrow('invalid audio');
});
test('generation preserves live state then releases every tensor and session', async () => {
    const { engine, tensors, release } = fixture();
    const wav = await engine.generate('Hi', new AbortController().signal);
    expect(wav.length).toBeGreaterThan(44);
    expect(tensors.length).toBeGreaterThan(10);
    expect(tensors.every(t => t.disposed)).toBe(true);
    await engine.dispose(); await engine.dispose();
    expect(release).toHaveBeenCalledTimes(4);
});
test('cancellation after an in-flight inference retires its late outputs too', async () => {
    const { engine, tensors, run } = fixture();
    const controller = new AbortController();
    const infer = run.getMockImplementation()!;
    run.mockImplementationOnce(async inputs => { const out = await infer(inputs); controller.abort(); return out; });
    await expect(engine.generate('Hello', controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(run).toHaveBeenCalledOnce(); expect(tensors.every(t => t.disposed)).toBe(true);
});
test('an inference failure disposes state and allows a retry', async () => {
    const { engine, tensors, run } = fixture();
    run.mockRejectedValueOnce(new Error('unsupported operator'));
    await expect(engine.generate('Hello', new AbortController().signal)).rejects.toThrow('unsupported operator');
    expect(tensors.every(t => t.disposed)).toBe(true);
    await expect(engine.generate('Hello', new AbortController().signal)).resolves.toBeInstanceOf(Uint8Array);
});
test('long Unicode words are chunked by characters and fit the token limit', () => {
    const { engine } = fixture();
    const text = '😀'.repeat(70) + ' ' + 'example '.repeat(35);
    const chunks = engine.chunks(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
        expect(Array.from(chunk).length).toBeLessThanOrEqual(50);
        expect(chunk).not.toMatch(/[\uD800-\uDBFF]$/);
    }
});

test('streams PCM while inference is still running without building a second WAV', async () => {
    const { engine, tensors, run } = fixture();
    const infer = run.getMockImplementation()!; let frames = 0;
    run.mockImplementation(async inputs => {
        const result = await infer(inputs);
        if (result.eos_logit && ++frames < 24) result.eos_logit.data[0] = -10;
        return result;
    });
    const streamed: Float32Array[] = []; let callsAtFirstChunk = 0;
    const wav = await engine.generate('Hi', new AbortController().signal, (pcm, rate) => {
        expect(rate).toBe(24000); streamed.push(pcm);
        if (!callsAtFirstChunk) callsAtFirstChunk = run.mock.calls.length;
    });
    expect(streamed.length).toBeGreaterThan(1);
    expect(callsAtFirstChunk).toBeLessThan(run.mock.calls.length);
    expect(Array.from(streamed[0])).toEqual([0.25, -0.25]);
    expect(wav).toHaveLength(0); expect(tensors.every(t => t.disposed)).toBe(true);
});
test('a streaming consumer failure releases inference state and permits retry', async () => {
    const { engine, tensors } = fixture();
    await expect(engine.generate('Hi', new AbortController().signal, () => { throw new Error('playback failed'); })).rejects.toThrow('playback failed');
    expect(tensors.every(t => t.disposed)).toBe(true);
    await expect(engine.generate('Hi', new AbortController().signal)).resolves.toBeInstanceOf(Uint8Array);
});
