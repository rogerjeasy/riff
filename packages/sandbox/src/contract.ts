import { z } from 'zod';
import { CAPABILITIES, EFFECT_LIMITS, SDK_VERSION } from '@riff/sdk';

export const manifestSchema = z
  .object({
    sdkVersion: z.literal(SDK_VERSION),
    capabilities: z.array(z.enum(CAPABILITIES)).max(CAPABILITIES.length),
    trigger: z
      .object({
        command: z.string().regex(/^![a-zA-Z0-9_-]{1,32}$/),
        audience: z
          .array(z.enum(['viewer', 'subscriber', 'moderator', 'broadcaster']))
          .min(1)
          .max(4),
        maxPerViewer: z.number().int().min(1).max(100),
        windowMs: z.number().int().min(1000).max(3_600_000),
      })
      .strict(),
    limits: z
      .object({
        effectsPerEvent: z.number().int().min(1).max(EFFECT_LIMITS.perEvent),
        effectsPerMinute: z.number().int().min(1).max(EFFECT_LIMITS.perMinute),
      })
      .strict(),
  })
  .strict();
export const artifactSchema = z
  .object({
    source: z.string().min(1).max(16_384),
    manifest: manifestSchema,
  })
  .strict();
export const eventSchema = z
  .object({
    id: z.string().min(1).max(100),
    channelId: z.string().min(1).max(100),
    viewerId: z.string().min(1).max(100),
    roles: z.array(z.enum(['viewer', 'subscriber', 'moderator', 'broadcaster'])).max(4),
    text: z
      .string()
      .max(500)
      .refine(
        (s) => ![...s].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127),
        'Control characters forbidden',
      ),
    at: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
export const effectSchema = z
  .object({
    kind: z.literal('projectile'),
    asset: z.enum(['tomato', 'star']),
    x: z.number().finite().min(0).max(1),
  })
  .strict();
