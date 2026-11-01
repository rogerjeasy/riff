import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  languageSchema,
  settingsSchema,
  ParticipationError,
  type ParticipationService,
} from '../services/participation/service.js';
import { reportClient } from './report-client.js';

/** Public companion polling: a burst of 30, refilled at 3 requests per second per client. */
export const PUBLIC_BUCKET = { capacity: 30, perSecond: 3, clients: 10_000 };

/** Name the first invalid field in a readable sentence; never echo submitted values. */
function invalidField(error: z.ZodError, root: string) {
  const issue = error.issues[0];
  if (!issue) return root;
  if (issue.code === 'unrecognized_keys')
    return [...issue.path, issue.keys[0]].filter((p) => p !== undefined).join('.') || root;
  return issue.path.join('.') || root;
}

export function registerParticipationRoutes(app: FastifyInstance, service: ParticipationService) {
  const buckets = new Map<string, { tokens: number; at: number }>();
  function admit(client: string) {
    const at = Date.now();
    let bucket = buckets.get(client);
    if (!bucket) {
      if (buckets.size >= PUBLIC_BUCKET.clients)
        for (const [key, value] of buckets)
          if (at - value.at > (PUBLIC_BUCKET.capacity / PUBLIC_BUCKET.perSecond) * 1000)
            buckets.delete(key);
      // A full table of active clients fails closed rather than growing without bound.
      if (buckets.size >= PUBLIC_BUCKET.clients) return false;
      bucket = { tokens: PUBLIC_BUCKET.capacity, at };
      buckets.set(client, bucket);
    }
    bucket.tokens = Math.min(
      PUBLIC_BUCKET.capacity,
      bucket.tokens + ((at - bucket.at) / 1000) * PUBLIC_BUCKET.perSecond,
    );
    bucket.at = at;
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }
  app.get('/api/participation', async (_req, reply) => {
    reply.header('Cache-Control', 'no-store');
    return { settings: service.settings() };
  });
  app.get('/participation', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!admit(reportClient(req)))
      return reply
        .code(429)
        .header('Retry-After', '1')
        .send({ message: 'Too many guidance requests from this device. Wait a moment and retry.' });
    // Unknown keys (cache-busters, tracking parameters) are ignored, not rejected.
    const parsed = z.object({ language: languageSchema.optional() }).safeParse(req.query);
    if (!parsed.success)
      return reply
        .code(400)
        .send({ message: 'The language parameter must be one of en, fr, es or de, given once.' });
    return service.publicView(parsed.data.language);
  });
  app.post('/api/participation/settings', async (req, reply) => {
    const parsed = z
      .object({ expectedRevision: z.number().int().nonnegative().safe(), settings: settingsSchema })
      .strict()
      .safeParse(req.body);
    if (!parsed.success)
      return reply.code(400).send({
        message: `Check the broadcast preferences: ${invalidField(parsed.error, 'request body')} is invalid.`,
      });
    try {
      return { settings: service.save(parsed.data.expectedRevision, parsed.data.settings) };
    } catch (error) {
      if (error instanceof ParticipationError)
        return reply.code(409).send({ message: error.message });
      throw error;
    }
  });
}
