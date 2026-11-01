import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  ProductionError,
  connectSchema,
  setupSchema,
  mappingsSchema,
  kindSchema,
} from '../services/production/contract.js';
import type { ProductionService } from '../services/production/service.js';
import { draftSchema, previewSchema } from '../services/production/imports.js';
/** All routes are private and use the host's existing session and mutation guards. */
export function registerProductionRoutes(app: FastifyInstance, service: ProductionService) {
  app.get('/api/production', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return { state: service.view() };
  });
  function route<T>(
    path: string,
    schema: z.ZodType<T>,
    action: (body: T) => unknown,
    options: { bodyLimit?: number; respond?: boolean } = {},
  ) {
    app.post(
      '/api/production/' + path,
      { bodyLimit: options.bodyLimit ?? 40 * 1024 },
      async (request, reply) => {
        reply.header('Cache-Control', 'no-store');
        const body = schema.safeParse(request.body);
        if (!body.success)
          return reply.code(400).send({
            code: 'INVALID',
            message: 'Check the production connection or selected operation fields.',
          });
        try {
          const result = await action(body.data);
          return options.respond ? result : { state: service.view() };
        } catch (error) {
          if (error instanceof ProductionError)
            return reply
              .code(
                error.code === 'INVALID'
                  ? 400
                  : error.code === 'UNAVAILABLE' || error.code === 'BUSY'
                    ? 503
                    : 409,
              )
              .send({ code: error.code, message: error.message });
          if (error instanceof z.ZodError)
            return reply.code(400).send({
              code: 'INVALID',
              message: 'Check the supported production format and bounded fields.',
            });
          return reply.code(500).send({
            code: 'FAILED',
            message: 'Production operation failed. Inspect the external tool before trying again.',
          });
        }
      },
    );
  }
  const hash = z.object({ digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
  route('connect', connectSchema, (b) => service.connect(b));
  route('disconnect', z.object({ kind: kindSchema }).strict(), (b) => service.disconnect(b.kind));
  route('obs/review', setupSchema, (b) => service.reviewObs(b));
  route('obs/apply', hash, (b) => service.applyObs(b.digest));
  route('obs/confirm', hash, (b) => service.confirmObs(b.digest));
  route('obs/rollback', hash, (b) => service.rollbackObs(b.digest));
  route('mappings/review', z.object({ mappings: mappingsSchema }).strict(), (b) =>
    service.reviewMappings(b.mappings),
  );
  route('mappings/approve', hash, (b) => service.approveMappings(b.digest));
  route('mappings/discard', hash, (b) => service.discardMappings(b.digest));
  route('import', z.object({ document: z.unknown() }).strict(), (b) =>
    service.importConfiguration(b.document),
  );
  // Native exports are read as data only; drafts never approve or execute anything.
  const importLimit = { bodyLimit: 300 * 1024, respond: true };
  route(
    'import/preview',
    previewSchema,
    (b) => ({ report: service.previewImport(b) }),
    importLimit,
  );
  route('import/drafts', draftSchema, (b) => service.draftImport(b), importLimit);
}
