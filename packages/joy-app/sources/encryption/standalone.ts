/**
 * Materialize a byte view as a Uint8Array that owns EXACTLY its bytes.
 *
 * The native libsodium TurboModule (and any JSI bridge) reads a typed-array
 * argument through getArrayBuffer(): it sees the view's WHOLE backing store,
 * not the [byteOffset, byteOffset + length) window the JS side means. A
 * subarray, or a Node/RN `Buffer` (whose `.slice()` is also a view, and
 * whose small allocations share a pool), therefore either fails a length
 * check ("invalid key length" for a 32-byte key view over a 64-byte HMAC
 * output) or seals/opens the unrelated neighbouring bytes (#305, #307).
 *
 * `new Uint8Array(view)` copies into a fresh, exact-length buffer whatever
 * subclass the input is — unlike `view.slice()`, which a Buffer overrides
 * to return another view of the same pool.
 */
export function standaloneBytes(view: Uint8Array): Uint8Array {
    if (view.byteOffset === 0 && view.buffer.byteLength === view.byteLength) {
        return view;
    }
    return new Uint8Array(view);
}
