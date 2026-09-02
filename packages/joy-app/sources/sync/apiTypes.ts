import { z } from 'zod';

//
// Message row as the read path hands it to decryption. v2 rows
// (sources/sync/v2/reads.ts) arrive already unsealed and carry the plaintext
// on `__v2Plain` with a placeholder `content`; the `encrypted` form is the
// sealed-row shape SessionEncryption still knows how to open.
//

export const ApiMessageSchema = z.object({
    id: z.string(),
    seq: z.number(),
    localId: z.string().nullish(),
    content: z.union([
        z.object({ t: z.literal('encrypted'), c: z.string() }),
        z.object({ t: z.literal('plain') }),
    ]),
    createdAt: z.number(),
    updatedAt: z.number(),
});

export type ApiMessage = z.infer<typeof ApiMessageSchema>;
