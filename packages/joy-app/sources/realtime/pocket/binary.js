// Safetensors voice-state decoder. Pocket exports keys as module/state_key:
// https://github.com/kyutai-labs/pocket-tts/blob/main/pocket_tts/models/model_state.py
// Only called after verifying the immutable voice file's SHA-256 digest.
export function parseVoiceState(bytes) {
    const fail = () => { throw new Error('Invalid Pocket voice state.'); };
    if (bytes.length < 8) fail();
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const headerLength = Number(view.getBigUint64(0, true));
    if (!Number.isSafeInteger(headerLength) || headerLength < 2 || headerLength > 1_000_000 || headerLength + 8 > bytes.length) fail();
    const header = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + headerLength)));
    const offset = 8 + headerLength;
    const state = Object.create(null);
    for (const [key, entry] of Object.entries(header)) {
        if (key === '__metadata__') continue;
        if (!entry || !Array.isArray(entry.shape) || !Array.isArray(entry.data_offsets) || entry.data_offsets.length !== 2) fail();
        if (!entry.shape.every(d => Number.isSafeInteger(d) && d >= 0)) fail();
        const [start, end] = entry.data_offsets;
        if (![start, end].every(Number.isSafeInteger) || start < 0 || end < start || offset + end > bytes.length) fail();
        const formats = { F32: [Float32Array, 4, 'float32'], I64: [BigInt64Array, 8, 'int64'], BOOL: [Uint8Array, 1, 'bool'] };
        const format = formats[entry.dtype];
        if (!format || entry.shape.reduce((a, b) => a * b, 1) * format[1] !== end - start) fail();
        const data = bytes.slice(offset + start, offset + end);
        state[key] = { data: new format[0](data.buffer), shape: entry.shape, dtype: format[2] };
    }
    if (!Object.keys(state).length) fail();
    return state;
}
