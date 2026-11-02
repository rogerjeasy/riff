import { reportClient } from './report-client.js';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { isSameOrigin } from './guard.js';
import { describeError, profileSchema, RecipeError } from '../services/recipes/contract.js';
import type { RecipeService } from '../services/recipes/service.js';
import type { RecipeParameter, RecipeParameterValues } from '@riff/sdk';
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const revision = z.number().int().nonnegative().safe();
/** Operator-local mutations and deliberately separate published-snapshot endpoints. */
export function registerRecipeRoutes(
  app: FastifyInstance,
  service: RecipeService,
  changed: () => void,
) {
  // LIMIT means "make room" (409); RATE is the only genuine rate limit (429); BUSY is a
  // temporarily unavailable compiler or a stopping server (503).
  const statusOf: Record<RecipeError['code'], number> = {
    NOT_FOUND: 404,
    INVALID: 400,
    RATE: 429,
    BUSY: 503,
    LIMIT: 409,
    STALE: 409,
    BLOCKED: 409,
    UNSUPPORTED: 409,
    CONFLICT: 409,
  };
  const failure = (error: unknown) =>
    error instanceof RecipeError
      ? { status: statusOf[error.code], code: error.code, message: error.message }
      : error instanceof z.ZodError
        ? { status: 400, code: 'INVALID', message: describeError(error) }
        : {
            status: 500,
            code: 'FAILED',
            message: 'The recipe operation failed. Reload before trying again.',
          };
  app.get('/api/recipes', async (_req, reply) => {
    reply.header('Cache-Control', 'no-store');
    return { state: service.state() };
  });
  function route<T>(
    suffix: string,
    schema: z.ZodType<T>,
    action: (body: T) => Promise<Record<string, unknown>> | Record<string, unknown>,
  ) {
    app.post(`/api/recipes/${suffix}`, { bodyLimit: 192 * 1024 }, async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      const parsed = schema.safeParse(req.body);
      if (!parsed.success)
        return reply.code(400).send({ code: 'INVALID', message: describeError(parsed.error) });
      try {
        const result = await action(parsed.data);
        changed();
        return { ...result, state: service.state() };
      } catch (error) {
        const result = failure(error);
        if (result.status === 500) req.log.error({ err: error }, 'recipe operation failed');
        return reply.code(result.status).send({ code: result.code, message: result.message });
      }
    });
  }
  route(
    'export',
    z
      .object({
        versionId: z.string().uuid(),
        title: z.string().trim().min(1).max(80),
        description: z.string().trim().min(1).max(400),
        author: z.string().trim().min(1).max(80),
        license: z.enum(['MIT', 'CC0-1.0', 'CC-BY-4.0']),
        rightsAttested: z.literal(true),
        recipeId: z.string().uuid().optional(),
        revision: revision.min(1).optional(),
        // F29: shape and bounds are checked by the service against the version's rules.
        parameters: z.array(z.unknown()).max(6).optional(),
      })
      .strict(),
    (body) => ({
      package: service.export({
        versionId: body.versionId,
        title: body.title,
        description: body.description,
        author: body.author,
        license: body.license,
        rightsAttested: body.rightsAttested,
        ...(body.recipeId ? { recipeId: body.recipeId } : {}),
        ...(body.revision !== undefined ? { revision: body.revision } : {}),
        ...(body.parameters ? { parameters: body.parameters as RecipeParameter[] } : {}),
      }),
    }),
  );
  route('import', z.object({ package: z.unknown() }).strict(), (body) => ({
    import: service.import(body.package),
  }));
  route(
    'profile',
    z.object({ expectedRevision: revision, profile: profileSchema }).strict(),
    (body) => ({ state: service.saveProfile(body.expectedRevision, body.profile) }),
  );
  route(
    'adapt',
    z
      .object({
        sourceDigest: hash,
        profileRevision: revision,
        generate: z.boolean().optional(),
        targetVersionId: z.string().uuid().optional(),
        // F29: values are validated against the edition's declarations by the service.
        parameters: z.record(z.string(), z.unknown()).optional(),
      })
      .strict(),
    async (body) => ({
      review: await service.adapt({
        sourceDigest: body.sourceDigest,
        profileRevision: body.profileRevision,
        ...(body.generate !== undefined ? { generate: body.generate } : {}),
        ...(body.targetVersionId ? { targetVersionId: body.targetVersionId } : {}),
        ...(body.parameters ? { parameters: body.parameters as RecipeParameterValues } : {}),
      }),
    }),
  );
  route('install', z.object({ reviewId: z.string().uuid(), digest: hash }).strict(), (body) =>
    service.install(body),
  );
  // F27 install links. The preview is read-only (no state change is announced); an
  // optional `package` is a file the creator chose, pinned to the link's digest.
  app.post('/api/recipes/install-preview', { bodyLimit: 192 * 1024 }, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const parsed = z
      .object({ digest: hash, package: z.unknown().optional() })
      .strict()
      .safeParse(req.body);
    if (!parsed.success)
      return reply.code(400).send({ code: 'INVALID', message: 'Invalid install link digest.' });
    try {
      return {
        preview: await service.installPreview({
          digest: parsed.data.digest,
          ...(parsed.data.package !== undefined ? { package: parsed.data.package } : {}),
        }),
      };
    } catch (error) {
      const result = failure(error);
      if (result.status === 500) req.log.error({ err: error }, 'recipe install preview failed');
      return reply.code(result.status).send({ code: result.code, message: result.message });
    }
  });
  route(
    'install-link',
    z
      .object({
        digest: hash,
        package: z.unknown().optional(),
        profileRevision: revision,
        targetVersionId: z.string().uuid().optional(),
      })
      .strict(),
    async (body) => ({
      installed: await service.installFromLink({
        digest: body.digest,
        profileRevision: body.profileRevision,
        ...(body.package !== undefined ? { package: body.package } : {}),
        ...(body.targetVersionId ? { targetVersionId: body.targetVersionId } : {}),
      }),
    }),
  );
  route('publish', z.object({ package: z.unknown() }).strict(), async (body) => ({
    publication: await service.publish(body.package),
  }));
  route(
    'remove',
    z.object({ kind: z.enum(['import', 'export']), digest: hash }).strict(),
    (body) => ({ state: service.remove(body.kind, body.digest) }),
  );
  route(
    'moderate',
    z.object({ reportId: z.string().uuid(), withhold: z.boolean() }).strict(),
    (body) => ({ state: service.moderate(body.reportId, body.withhold) }),
  );
  route(
    'restore',
    z.object({ digest: hash, rightsAttested: z.literal(true) }).strict(),
    (body) => ({ state: service.restore(body.digest, body.rightsAttested) }),
  );
  app.get('/directory/recipes', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const query = z
      .object({ q: z.string().trim().max(80).optional() })
      .strict()
      .safeParse(req.query);
    if (!query.success)
      return reply
        .code(400)
        .send({ code: 'INVALID', message: 'Search text must be at most 80 characters.' });
    return { recipes: service.directory(query.data.q) };
  });
  app.get('/directory/recipes/:digest', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const params = z.object({ digest: hash }).safeParse(req.params);
    if (!params.success)
      return reply.code(400).send({ code: 'INVALID', message: 'Invalid recipe digest.' });
    try {
      return { recipe: service.detail(params.data.digest) };
    } catch (error) {
      const refusal = failure(error);
      return reply.code(refusal.status).send({ code: refusal.code, message: refusal.message });
    }
  });
  app.post('/directory/recipes/:digest/report', { bodyLimit: 2048 }, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!isSameOrigin(req) || req.headers['x-riff-request'] !== '1')
      return reply
        .code(403)
        .send({ code: 'CSRF', message: 'Send reports from this directory page.' });
    const params = z.object({ digest: hash }).safeParse(req.params),
      body = z
        .object({ reason: z.string().trim().min(8).max(500) })
        .strict()
        .safeParse(req.body);
    if (!params.success || !body.success)
      return reply.code(400).send({
        code: 'INVALID',
        message: 'Describe the abuse or licensing concern in 8–500 characters.',
      });
    try {
      service.report(params.data.digest, body.data.reason, reportClient(req));
      changed();
      return { received: true };
    } catch (error) {
      const refusal = failure(error);
      return reply.code(refusal.status).send({ code: refusal.code, message: refusal.message });
    }
  });
}
