/**
 * Write bytes to a temporary file, hand it to a consumer (the share sheet),
 * and ALWAYS remove the file afterwards.
 *
 * Both native "download" paths used to `await share()` and then delete only on
 * the success line: a rejected share sheet skipped the delete and left a new
 * copy in the cache directory on every attempt, and a delete that rejected
 * after a successful share escaped as an unhandled rejection (#225, #430).
 * Here the removal runs in `finally`, is awaited, and a cleanup failure is
 * reported through `onCleanupError` instead of masking the share result.
 */
export async function withTempExport<T>(io: {
    write: () => Promise<void>;
    share: () => Promise<T>;
    remove: () => Promise<void>;
    onCleanupError?: (error: unknown) => void;
}): Promise<T> {
    try {
        await io.write();
        return await io.share();
    } finally {
        try {
            await io.remove();
        } catch (error) {
            io.onCleanupError?.(error);
        }
    }
}
