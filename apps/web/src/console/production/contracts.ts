import { z } from 'zod';
const name = z.string().max(120),
  hash = z.string().regex(/^[a-f0-9]{64}$/);
export const kindSchema = z.enum(['obs', 'streamerbot']);
export const mappingSchema = z
  .object({
    id: name,
    eventName: name,
    versionId: z.string(),
    control: z.enum(['start', 'pause']),
    actionId: name.nullable(),
  })
  .strict();
const connection = z
  .object({
    status: z.enum(['disconnected', 'connecting', 'connected', 'error']),
    reason: z.string().nullable(),
    url: z.string().nullable(),
    scenes: z.array(name).max(500),
    actions: z.array(z.object({ id: name, name, enabled: z.boolean() })).max(500),
  })
  .strict();
export const stateSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    configured: z.boolean(),
    origin: z.string(),
    connections: z.object({ obs: connection, streamerbot: connection }),
    obsReview: z
      .object({
        digest: hash,
        sceneName: name,
        inputName: name,
        width: z.number(),
        height: z.number(),
        operation: z.enum(['create', 'update']),
        status: z.enum(['review', 'test', 'live', 'rolled-back']),
        before: z
          .object({
            width: z.number().nullable(),
            height: z.number().nullable(),
            mode: z.literal('owned-browser'),
          })
          .nullable(),
      })
      .nullable(),
    mappingReview: z
      .object({
        digest: hash,
        mappings: z.array(mappingSchema).max(20),
        unsupported: z.array(z.string()).max(100),
        differences: z.array(z.string()).max(100),
      })
      .nullable(),
    mappings: z.array(mappingSchema).max(20),
    recent: z.array(z.object({ at: z.number(), code: z.string(), message: z.string() })).max(30),
  })
  .strict();
export type ProductionState = z.infer<typeof stateSchema>;
export type ProductionMapping = z.infer<typeof mappingSchema>;
