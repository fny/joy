/**
 * Protocol constants — see comm-layer-spec §23. All tunable unless noted.
 * Times in milliseconds.
 */
export const CONSTANTS = {
    BACKOFF_BASE_MS: 500,
    BACKOFF_CAP_MS: 15_000,
    OUTBOX_MAX_EVENTS: 2000,
    OUTBOX_MAX_BYTES: 32 * 1024 * 1024,
    /** Not tunable: bounds synchronous-encryption stalls (spec §10.4). */
    CHUNK_PLAINTEXT_MAX_BYTES: 64 * 1024,
    GRACE_INTERRUPT_MS: 3_000,
    GRACE_ABORT_MS: 2_000,
    PERMISSION_TIMEOUT_MS: 300_000,
    HEARTBEAT_INTERVAL_MS: 5_000,
    STALL_WINDOW_MS: 20_000,
    SNAPSHOT_EVERY_EVENTS: 500,
    SNAPSHOT_EVERY_MS: 10 * 60_000,
    SNAPSHOT_MIN_EVENTS_ON_TURN_END: 100,
} as const;

/** Frozen envelope shape version (spec §7). Never changes. */
export const ENVELOPE_VERSION = 1 as const;
