/**
 * Test double for the NATIVE libsodium argument contract.
 *
 * @more-tech/react-native-libsodium hands each typed-array argument to JSI
 * as its ENTIRE backing ArrayBuffer (getArrayBuffer()), ignoring byteOffset
 * and length. libsodium-wrappers (web / Node) honours the view, so a plain
 * Node test cannot catch the class of bug in #305/#307. This proxy makes
 * libsodium-wrappers behave like the native module: every Uint8Array
 * argument is replaced by a view over its whole `.buffer` before the call.
 * Code that materializes exact-length copies is unaffected; code that
 * forwards subarrays or Buffers gets the wrong bytes, exactly as on iOS.
 */
export function withNativeBufferContract<T extends object>(realSodium: T): T {
    const widen = (arg: unknown): unknown =>
        arg instanceof Uint8Array ? new Uint8Array(arg.buffer) : arg;
    return new Proxy(realSodium, {
        get(target, prop, receiver) {
            const value = Reflect.get(target, prop, receiver);
            if (typeof value !== 'function') {
                return value;
            }
            return (...args: unknown[]) => (value as (...a: unknown[]) => unknown).apply(target, args.map(widen));
        },
    });
}
