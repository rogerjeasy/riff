import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { INSIGHT_RANGES } from '../services/insights/contract.js';
import type { InsightsService } from '../services/insights/service.js';

const query = z.object({ range: z.enum(INSIGHT_RANGES).default('stream') });

/** Private creator-console aggregates; the optional console session gate applies. */
export function registerInsightsRoutes(app: FastifyInstance, service: InsightsService) {
  app.get('/api/insights', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const parsed = query.safeParse(request.query);
    if (!parsed.success)
      return reply
        .code(400)
        .send({ code: 'INVALID', message: 'Choose last stream, 24 hours or 7 days.' });
    try {
      return { insights: service.summary(parsed.data.range) };
    } catch (error) {
      request.log.error({ err: error }, 'insights failed');
      return reply.code(500).send({
        code: 'FAILED',
        message: 'Insights are unavailable right now. Try again shortly.',
      });
    }
  });
}
