import { sceneProjectionSchema } from '../scenes/schema.js';
import { z } from 'zod';
import { communitySchema } from '../community/schema.js';
import { overlaySessionSchema } from '../sessions/schemas.js';

export const overlayMessageSchema = z.discriminatedUnion('type', [
  z.object({
    v: z.literal(1),
    type: z.literal('scenes'),
    payload: z.object({ scenes: z.array(sceneProjectionSchema).max(64) }),
  }),
  z.object({ v: z.literal(1), type: z.literal('community'), payload: communitySchema.nullable() }),
  z.object({
    v: z.literal(1),
    type: z.literal('sessions'),
    payload: z.object({ sessions: z.array(overlaySessionSchema).max(64) }),
  }),
  z.object({
    v: z.literal(1),
    type: z.literal('hello'),
    payload: z.object({ channel: z.string() }),
  }),
  z.object({
    v: z.literal(1),
    type: z.literal('heartbeat'),
    payload: z.object({ at: z.number() }),
  }),
  z.object({
    v: z.literal(1),
    type: z.literal('effect'),
    payload: z.object({
      id: z.string(),
      automationId: z.string().optional(),
      versionId: z.string().optional(),
      asset: z.enum(['tomato', 'star', 'heart']),
      x: z.number().min(0).max(1),
      viewer: z.string().max(100).nullable(),
    }),
  }),
  z.object({
    v: z.literal(1),
    type: z.literal('instructions'),
    payload: z.object({ lines: z.array(z.string().max(200)).max(4) }),
  }),
  z.object({
    v: z.literal(1),
    type: z.literal('clear'),
    payload: z.object({ reason: z.string() }),
  }),
  z.object({ v: z.literal(1), type: z.literal('test'), payload: z.object({ at: z.number() }) }),
]);
