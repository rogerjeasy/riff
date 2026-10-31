import type { FastifyInstance } from 'fastify';

export function registerHealthRoute(app: FastifyInstance, checkDatabase: () => boolean) {
  app.get('/api/health', (_request, reply) => {
    let healthy = false;
    try {
      healthy = checkDatabase();
    } catch {
      /* Readiness failure is a bounded public result. */
    }
    return reply.code(healthy ? 200 : 503).send({
      status: healthy ? 'ok' : 'unavailable',
      mode: 'studio',
    });
  });
}
