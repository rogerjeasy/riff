import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  ChatAuthoringError,
  type ChatAuthoringService,
} from '../services/chat-authoring/service.js';

/** Private console routes; the mutation guard and optional console session apply. */
export function registerChatAuthoringRoutes(app: FastifyInstance, service: ChatAuthoringService) {
  const fail = (error: unknown) => {
    if (error instanceof ChatAuthoringError)
      return {
        status: error.code === 'CONFLICT' ? 409 : 404,
        body: { code: error.code, message: error.message },
      };
    throw error;
  };
  app.get('/api/chat-authoring', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return service.snapshot();
  });
  app.post('/api/chat-authoring/settings', async (request, reply) => {
    const body = z
      .object({ enabled: z.boolean(), expectedRevision: z.number().int().nonnegative() })
      .strict()
      .safeParse(request.body);
    if (!body.success)
      return reply
        .code(400)
        .send({ code: 'INVALID', message: 'Choose on or off for the current settings revision.' });
    try {
      return service.setEnabled(body.data.enabled, body.data.expectedRevision);
    } catch (error) {
      const failure = fail(error);
      return reply.code(failure.status).send(failure.body);
    }
  });
  app.post('/api/chat-authoring/codes/:id/revoke', async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).strict().safeParse(request.params);
    if (!params.success)
      return reply.code(404).send({ code: 'NOT_FOUND', message: 'Unknown approval code.' });
    try {
      return service.revoke(params.data.id);
    } catch (error) {
      const failure = fail(error);
      return reply.code(failure.status).send(failure.body);
    }
  });
}
