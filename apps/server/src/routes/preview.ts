import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eventSchema } from '@riff/sandbox';
import type { createPreviewService } from '../services/rehearsal/preview.js';

const replaySchema = z
  .object({ seed: z.number().int().min(1).max(0xffff_ffff), events: z.array(eventSchema).max(64) })
  .strict();

export function registerPreviewRoute(
  app: FastifyInstance,
  service: ReturnType<typeof createPreviewService>,
) {
  app.post('/api/preview', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const origin = request.headers.origin;
    try {
      if (
        request.headers['sec-fetch-site'] === 'cross-site' ||
        (origin && new URL(origin).host !== request.host)
      ) {
        return reply.code(403).send({ message: 'Use the local preview console.' });
      }
    } catch {
      return reply.code(403).send({ message: 'Invalid request origin.' });
    }
    const parsed = replaySchema.safeParse(request.body);
    if (!parsed.success)
      return reply
        .code(400)
        .send({ message: 'Provide a seed and up to 64 valid synthetic events.' });
    const controller = new AbortController();
    const cancel = () => {
      if (!reply.raw.writableEnded) controller.abort();
    };
    reply.raw.once('close', cancel);
    let result;
    try {
      result = await service.replay(parsed.data.events, parsed.data.seed, controller.signal);
    } finally {
      reply.raw.removeListener('close', cancel);
    }
    if (!result)
      return reply.code(429).send({ message: 'Another replay is running. Try again shortly.' });
    return result;
  });
}
