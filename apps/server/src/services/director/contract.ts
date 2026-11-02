import { z } from 'zod';
import { createHash } from 'node:crypto';
export const DIRECTOR_POLICY_VERSION = 1;
const range = (min: number, max: number) =>
  z
    .object({
      min: z.number().int().min(min).max(max),
      max: z.number().int().min(min).max(max),
    })
    .strict()
    .refine((r) => r.min <= r.max, 'Minimum must not exceed maximum.');
export const directorEnvelopeSchema = z
  .object({
    version: z.literal(1),
    intervalMs: range(250, 2000),
    batchSize: range(1, 6),
    intensity: range(25, 100),
    interruptionsPerMinute: z.number().int().min(1).max(60),
    participation: z.enum(['fifo', 'first-time', 'rotation']),
  })
  .strict();
export const directorSettingsSchema = z
  .object({
    intervalMs: z.number().int().min(250).max(2000),
    batchSize: z.number().int().min(1).max(6),
    intensity: z.number().int().min(25).max(100),
  })
  .strict();
/** Normalized schema order gives stable evidence identity. */
export function directorDigest(envelope: unknown) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        policy: DIRECTOR_POLICY_VERSION,
        envelope: directorEnvelopeSchema.parse(envelope),
      }),
    )
    .digest('hex');
}
export class DirectorError extends Error {
  constructor(
    public readonly code: 'INVALID' | 'STALE' | 'BLOCKED' | 'NOT_FOUND' | 'LIMIT' | 'BUSY',
    message: string,
  ) {
    super(message);
  }
}
