/** Static knobs for what the voice agent is told about coding sessions. */
export const VOICE_CONFIG = {
    /** Send only tool names and descriptions, never arguments. */
    LIMITED_TOOL_CALLS: true,
    /** Messages included when a session's context is first injected. */
    MAX_HISTORY_MESSAGES: 12,
    /** Characters per message in injected history (text is truncated beyond). */
    MAX_MESSAGE_CHARS: 1200,
    ENABLE_DEBUG_LOGGING: __DEV__,
} as const;
