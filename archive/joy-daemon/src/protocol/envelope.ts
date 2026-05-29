/**
 * Event envelope — comm-layer-spec §7. Shape is frozen at v1; only payloads evolve.
 *
 * `seq` is server-assigned at persist time and is THE canonical order; it is NOT
 * part of the produced envelope but is paired with the envelope when read back.
 */
import { z } from 'zod';

export const EnvelopeSchema = z.object({
    eventId: z.string().uuid(),
    type: z.string().min(1),
    v: z.number().int().positive(),
    vmin: z.number().int().positive().nullable().optional(),
    sessionId: z.string().min(1),
    turnId: z.string().nullable().optional(),
    by: z.string().min(1),
    ts: z.number().int().nonnegative(),
    payload: z.unknown(),
});
export type Envelope = z.infer<typeof EnvelopeSchema>;

/** An envelope as the consumer sees it after read: server-assigned seq attached. */
export interface StampedEnvelope extends Envelope {
    seq: number;
}
