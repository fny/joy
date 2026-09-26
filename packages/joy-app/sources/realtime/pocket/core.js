// Pocket TTS ONNX inference, adapted from vlapky/pocket-tts-js (MIT).
// Reference: 7d7a27423b0845eb0425c81a8aa5ed3f3d973eef. See LICENSE and NOTICE.md.
// Shared by the browser worker and the native ONNX Runtime adapter.
import { SentencePieceTokenizer } from './tokenizer.js';
import { parseVoiceState } from './binary.js';

export const supportedVoices = ['alba', 'marius', 'javert', 'fantine', 'eponine', 'azelma'];
export function checkAborted(signal) {
    if (signal.aborted) { const error = new Error('Speech stopped'); error.name = 'AbortError'; throw error; }
}
export function pcmToWav(chunks, sampleRate = 24000) {
    const length = chunks.reduce((n, c) => n + c.length, 0);
    const wav = new Uint8Array(44 + length * 2);
    const view = new DataView(wav.buffer);
    const text = (at, value) => { for (let i = 0; i < value.length; i++) wav[at + i] = value.charCodeAt(i); };
    text(0, 'RIFF'); view.setUint32(4, wav.length - 8, true); text(8, 'WAVE'); text(12, 'fmt ');
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true); view.setUint16(34, 16, true); text(36, 'data'); view.setUint32(40, length * 2, true);
    let at = 44;
    for (const chunk of chunks) for (const value of chunk) {
        if (!Number.isFinite(value)) throw new Error('Pocket TTS produced invalid audio.');
        view.setInt16(at, Math.round(Math.max(-1, Math.min(1, value)) * (value < 0 ? 32768 : 32767)), true); at += 2;
    }
    return wav;
}

export class PocketEngine {
    constructor(ort, bundle, load, sessionOptions) {
        this.ort = ort; this.bundle = bundle; this.load = load; this.sessionOptions = sessionOptions;
        this.sessions = {}; this.tensors = new Set(); this.busy = false;
    }
    async prepare(voice, signal, progress) {
        if (!supportedVoices.includes(voice)) voice = 'alba'; // migrate retired NC presets
        try {
            const bytes = await this.load('tokenizer.model', signal, progress);
            this.tokenizer = SentencePieceTokenizer.fromBytes(bytes);
            for (const name of ['text_conditioner', 'flow_lm_main', 'flow_lm_flow', 'mimi_decoder']) {
                checkAborted(signal);
                const model = await this.load(`${name}_int8.onnx`, signal, progress);
                checkAborted(signal);
                this.sessions[name] = await this.ort.InferenceSession.create(model, this.sessionOptions);
            }
            const voiceBytes = await this.load(`${voice}.safetensors`, signal, progress);
            checkAborted(signal);
            // The official per-voice files avoid downloading unused or NC presets.
            this.voice = parseVoiceState(voiceBytes);
            if (!this.voice) throw new Error('Pocket voice is missing.');
        } catch (error) { await this.dispose(); throw error; }
    }
    tensor(dtype, data, dims) {
        const tensor = new this.ort.Tensor(dtype, data, dims);
        this.tensors.add(tensor); return tensor;
    }
    release(...values) {
        for (const tensor of values) if (this.tensors.delete(tensor)) tensor.dispose();
    }
    async run(name, inputs, signal) {
        checkAborted(signal);
        const outputs = await this.sessions[name].run(inputs);
        for (const tensor of Object.values(outputs)) this.tensors.add(tensor);
        checkAborted(signal); return outputs;
    }
    filled(entry) {
        const length = entry.shape.reduce((a, b) => a * b, 1);
        if (entry.dtype === 'int64') return new BigInt64Array(length).fill(entry.fill === 'ones' ? 1n : 0n);
        const data = entry.dtype === 'bool' ? new Uint8Array(length) : new Float32Array(length);
        if (entry.fill === 'ones') data.fill(1);
        else if (entry.fill === 'nan') data.fill(NaN);
        return data;
    }
    initial(manifest, voice) {
        const state = {};
        for (const entry of manifest) {
            let data = this.filled(entry);
            const source = voice?.[entry.path];
            if (source) {
                if (source.shape.length !== entry.shape.length) throw new Error('Incompatible Pocket voice shape.');
                // Copy each source coordinate into the padded ONNX cache layout.
                for (let i = 0; i < source.data.length; i++) {
                    let remainder = i, target = 0, stride = 1;
                    for (let d = source.shape.length - 1; d >= 0; d--) {
                        const index = remainder % source.shape[d]; remainder = Math.floor(remainder / source.shape[d]);
                        if (index >= entry.shape[d]) { target = -1; break; }
                        target += index * stride; stride *= entry.shape[d];
                    }
                    if (target >= 0) data[target] = source.data[i];
                }
            } else if (voice && entry.key === 'step') {
                const prefix = `${entry.module}/`;
                const step = voice[prefix + 'step'] || voice[prefix + 'offset'];
                data[0] = BigInt(step ? step.data[0] : voice[prefix + 'current_end']?.shape[0] || 0);
            }
            state[entry.input_name] = this.tensor(entry.dtype, data, entry.shape);
        }
        return state;
    }
    update(state, result, manifest) {
        for (const entry of manifest) {
            this.release(state[entry.input_name]);
            state[entry.input_name] = result[entry.output_name];
            delete result[entry.output_name];
        }
        this.release(...Object.values(result));
    }
    chunks(text) {
        let prompt = text.trim().replace(/\s+/g, ' ');
        if (this.bundle.remove_semicolons) prompt = prompt.replace(/;/g, ',');
        if (!prompt) throw new Error('No text to speak.');
        prompt = prompt[0].toUpperCase() + prompt.slice(1);
        if (/[\p{L}\p{N}]$/u.test(prompt)) prompt += '.';
        // Split at words to preserve byte-fallback Unicode sequences. Always recheck
        // after adding punctuation; never silently exceed the model's token budget.
        const result = []; let current = '';
        for (const word of prompt.split(' ')) {
            const next = current ? current + ' ' + word : word;
            if (this.tokenizer.encodeIds(next).length <= 50) { current = next; continue; }
            if (current) result.push(current);
            current = '';
            for (const char of word) {
                if (this.tokenizer.encodeIds(current + char).length > 50) { result.push(current); current = ''; }
                current += char;
            }
        }
        if (current) result.push(current);
        return result;
    }
    async generate(text, signal, onChunk) {
        if (this.busy) throw new Error('Pocket TTS is already speaking.');
        this.busy = true;
        const audio = [];
        const b = this.bundle;
        const emit = pcm => { if (onChunk) onChunk(pcm, b.sample_rate); else audio.push(pcm); };
        try {
            checkAborted(signal);
            const chunks = this.chunks(text.slice(0, 500));
            let totalFrames = 0;
            for (const [index, chunk] of chunks.entries()) {
                let flow = this.initial(b.flow_lm_state_manifest, this.voice);
                let mimi = this.initial(b.mimi_state_manifest);
                const ids = this.tokenizer.encodeIds(chunk);
                const input = this.tensor('int64', BigInt64Array.from(ids, BigInt), [1, ids.length]);
                const embeddings = await this.run('text_conditioner', { token_ids: input }, signal);
                let embedding = embeddings[this.sessions.text_conditioner.outputNames[0]];
                if (embedding.dims.length === 2) embedding = this.tensor('float32', new Float32Array(embedding.data), [1, ...embedding.dims]);
                const emptySequence = this.tensor('float32', new Float32Array(), [1, 0, b.latent_dim]);
                const emptyText = this.tensor('float32', new Float32Array(), [1, 0, b.conditioning_dim]);
                const conditioned = await this.run('flow_lm_main', { sequence: emptySequence, text_embeddings: embedding, ...flow }, signal);
                this.update(flow, conditioned, b.flow_lm_state_manifest);
                this.release(input, embedding, ...Object.values(embeddings));
                let latent = this.tensor('float32', new Float32Array(b.latent_dim).fill(NaN), [1, 1, b.latent_dim]);
                const s = this.tensor('float32', new Float32Array([0]), [1, 1]);
                const t = this.tensor('float32', new Float32Array([1]), [1, 1]);
                let eos = null; let pending = [];
                const afterEos = b.model_recommended_frames_after_eos ?? (chunk.split(/\s+/).length <= 4 ? 3 : 1);
                for (let frame = 0; ; frame++) {
                    if (++totalFrames > 500) throw new Error('Pocket TTS exceeded its speech length limit.');
                    const ar = await this.run('flow_lm_main', { sequence: latent, text_embeddings: emptyText, ...flow }, signal);
                    if (Number(ar.eos_logit.data[0]) > -4 && eos === null) eos = frame;
                    const stop = eos !== null && frame >= eos + afterEos;
                    const data = new Float32Array(b.latent_dim);
                    for (let i = 0; i < data.length; i++) {
                        const u = Math.max(Number.MIN_VALUE, Math.random());
                        data[i] = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * Math.random()) * Math.sqrt(0.7);
                    }
                    const x = this.tensor('float32', data, [1, b.latent_dim]);
                    const result = await this.run('flow_lm_flow', { c: ar.conditioning, s, t, x }, signal);
                    for (let i = 0; i < data.length; i++) data[i] += result.flow_dir.data[i];
                    this.release(x, latent, ...Object.values(result));
                    this.update(flow, ar, b.flow_lm_state_manifest);
                    latent = this.tensor('float32', data, [1, 1, b.latent_dim]);
                    pending.push(data);
                    if (stop || pending.length === 12) {
                        const values = new Float32Array(pending.length * b.latent_dim);
                        pending.forEach((v, i) => values.set(v, i * b.latent_dim));
                        const decoderInput = this.tensor('float32', values, [1, pending.length, b.latent_dim]);
                        const decoded = await this.run('mimi_decoder', { latent: decoderInput, ...mimi }, signal);
                        emit(new Float32Array(decoded[this.sessions.mimi_decoder.outputNames[0]].data));
                        this.update(mimi, decoded, b.mimi_state_manifest); this.release(decoderInput); pending = [];
                    }
                    if (stop) break;
                    // Native ORT runs off-thread; yield JS between iterations for stop/UI events.
                    await new Promise(resolve => setTimeout(resolve, 0));
                }
                this.release(...this.tensors);
                if (index < chunks.length - 1) emit(new Float32Array(b.sample_rate / 4));
            }
            checkAborted(signal); return onChunk ? new Uint8Array() : pcmToWav(audio, b.sample_rate);
        } finally { this.release(...this.tensors); this.busy = false; }
    }
    async dispose() {
        this.release(...this.tensors);
        const sessions = Object.values(this.sessions); this.sessions = {}; this.voice = null;
        await Promise.allSettled(sessions.map(session => session.release()));
    }
}
