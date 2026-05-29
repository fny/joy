/**
 * Wire-shape compatibility facade with the happy app/cli.
 *
 * The relay server stores opaque encrypted blobs; happy clients decrypt and
 * expect a discriminated union over `role`:
 *   - `{role: 'user', content: {type: 'text', text: string}, meta?}`
 *   - `{role: 'agent', content: {type: string, ...}, meta?}` (passthrough)
 *   - `{role: 'session', content: <sessionEnvelope>, meta?}`   (frozen, rarely used)
 *
 * Joy writes its own event log (`Envelope` over `AnyEvent`) per
 * comm-layer-spec §7-§9. For interop we encrypt a happy-shaped JSON in which:
 *   - `content` is whatever happy needs to render (e.g. `{type: 'text', ...}`)
 *   - `meta` carries `sentFrom: 'joy'` plus a `joy` field holding the full
 *     `Envelope`. Joy's cursor reads `meta.joy` first; if present, that is
 *     the canonical event. The happy MessageMeta zod schema strips unknown
 *     fields silently, so happy clients never see `meta.joy` on their parsed
 *     object but the bytes survive on the wire for joy to extract.
 *
 * On read, when `meta.joy` is absent (a message written by a legacy happy
 * client), we synthesize a joy event from the legacy shape so the daemon's
 * fold + agent forwarding still apply. Today we only translate user input
 * (`role: 'user', content: {type: 'text', text}` → `user-message`).
 */
import { EnvelopeSchema, type Envelope } from '../protocol/envelope';
import { AnyEventSchema, type AnyEvent } from '../protocol/events';

/** What the relay sees inside the encrypted blob. */
export interface WireRecord {
    role: 'user' | 'agent' | 'session';
    content: { type: string; [k: string]: unknown };
    meta?: { sentFrom?: string; joy?: Envelope; [k: string]: unknown };
}

/**
 * Convert a joy envelope into the on-wire record that happy clients can
 * tolerate. The full envelope is preserved verbatim in `meta.joy` so joy's
 * own cursor can recover it byte-for-byte.
 */
export function encodeForWire(env: Envelope): WireRecord {
    const happy = renderForHappy(env);
    return {
        role: happy.role,
        content: happy.content,
        meta: { sentFrom: 'joy', joy: env },
    };
}

interface HappyShape {
    role: 'user' | 'agent' | 'session';
    content: { type: string; [k: string]: unknown };
}

/**
 * Best-effort projection of a joy event into the legacy happy display shape.
 * Anything happy doesn't know about (`type: 'joy-internal'`) it ignores; the
 * authoritative joy data still rides in `meta.joy`.
 */
function renderForHappy(env: Envelope): HappyShape {
    const ev = env.payload as Record<string, unknown> | undefined;
    switch (env.type) {
        case 'user-message': {
            const content = (ev?.content as unknown);
            const text = typeof content === 'string' ? content : JSON.stringify(content);
            return { role: 'user', content: { type: 'text', text } };
        }
        case 'turn-output': {
            // happy renders agent messages shaped like the raw Claude SDK
            // `{type:'output', data:{type:'assistant', message:{role, model,
            // content:[...]}}}` (see happy-app typesRaw rawAgentRecordSchema).
            // turn-output.payload.content already IS the SDK content array, so
            // we pass it through verbatim under that envelope.
            const sdkContent = Array.isArray(ev?.content) ? ev?.content : [{ type: 'text', text: String(ev?.content ?? '') }];
            const messageId = String(ev?.messageId ?? env.eventId);
            return {
                role: 'agent',
                content: {
                    type: 'output',
                    data: {
                        type: 'assistant',
                        uuid: messageId,
                        message: { role: 'assistant', model: 'claude', content: sdkContent },
                    },
                },
            };
        }
        default:
            // Internal/lifecycle events (writer-claim, turn-*, heartbeat, bg-*,
            // permission-*, snapshot, cursor). happy's strict schema doesn't
            // recognize these, so it skips them (no bubble). The authoritative
            // joy data still rides in meta.joy for joy consumers.
            return { role: 'agent', content: { type: 'joy-internal', kind: env.type } };
    }
}

/**
 * Decode a happy-wire JSON into a joy envelope, or null if it's not
 * meaningful to joy. Prefers `meta.joy` (joy's own write); falls back to
 * translating a legacy `role: 'user'` text message into a `user-message`
 * event. Other legacy shapes are ignored (joy doesn't currently consume
 * legacy agent output).
 *
 * `defaultMessageId` is used when the legacy record has no id we can adopt;
 * pass the relay's raw message id.
 */
export function decodeFromWire(decrypted: unknown, defaultMessageId: string): Envelope | null {
    if (!decrypted || typeof decrypted !== 'object') return null;
    const obj = decrypted as Record<string, unknown>;

    // Fast path: our own write.
    const meta = obj.meta as { joy?: unknown } | undefined;
    if (meta?.joy && typeof meta.joy === 'object') {
        const parsed = EnvelopeSchema.safeParse(meta.joy);
        if (parsed.success) return parsed.data;
    }

    // Legacy translation: happy user-message → joy user-message event.
    if (obj.role === 'user') {
        const content = obj.content as { type?: string; text?: string } | undefined;
        if (content?.type === 'text' && typeof content.text === 'string') {
            const synth: Envelope = {
                eventId: defaultMessageId,
                type: 'user-message',
                v: 1,
                vmin: null,
                sessionId: '', // populated by caller if needed
                turnId: null,
                by: 'legacy',
                ts: Date.now(),
                payload: { messageId: defaultMessageId, content: content.text },
            };
            return synth;
        }
    }

    return null;
}

/** Re-validate a joy event from an envelope's (type, payload). Mirrors the
 *  inline check in cursor.parse — exported so the cursor can stay thin. */
export function eventFromEnvelope(env: Envelope): AnyEvent | null {
    const r = AnyEventSchema.safeParse({ type: env.type, payload: env.payload });
    return r.success ? r.data : null;
}
