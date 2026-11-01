import { z } from 'zod';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { REHEARSAL_PRESETS, rehearsalScenarioSchema } from '@riff/sandbox';
import { RehearsalServiceError } from '../services/rehearsal/contract.js';
import type { RehearsalService } from '../services/rehearsal/service.js';
import { AuthoringError, type AuthoringService } from '../services/authoring/service.js';
import { ProposalError } from '../services/proposals/service.js';
const id = z.string().uuid(),
  name = z.string().trim().min(1).max(80),
  revision = z.number().int().nonnegative(),
  seed = z.number().int().min(1).max(4294967295);
const recording = z.object({ versionId: id, sessionId: z.string().min(1).max(100), seed }).strict();
const empty = z.object({}).strict();
/** Strict private creator API; never accepts executable artifacts or live routing authority. */
export function registerRehearsalRoutes(
  app: FastifyInstance,
  deps: { rehearsal: RehearsalService; authoring: AuthoringService },
) {
  const { rehearsal, authoring } = deps;
  function failure(reply: FastifyReply, error: unknown) {
    if (error instanceof RehearsalServiceError) {
      const status =
        error.code === 'INVALID'
          ? 400
          : error.code === 'NOT_FOUND'
            ? 404
            : error.code === 'LIMIT'
              ? 429
              : error.code === 'TIMEOUT'
                ? 408
                : error.code === 'RESULT_LIMIT'
                  ? 413
                  : 409;
      return reply.code(status).send({ code: error.code, message: error.message });
    }
    if (error instanceof AuthoringError)
      return reply
        .code(error.code === 'NOT_FOUND' ? 404 : error.code === 'QUEUE_FULL' ? 429 : 409)
        .send({ code: error.code, message: error.message });
    if (error instanceof ProposalError)
      return reply
        .code(error.code === 'NOT_FOUND' ? 404 : 409)
        .send({ code: error.code, message: 'That audience lineage is no longer authorized.' });
    // Boundary failures must not reflect private input, source or stored journal content.
    return reply.code(409).send({ code: 'UNAVAILABLE', message: 'Rehearsal is unavailable.' });
  }
  const parameter = (request: FastifyRequest) => z.object({ id }).parse(request.params).id;
  function route<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    url: string,
    schema: z.ZodType<T>,
    action: (body: T, request: FastifyRequest, signal: AbortSignal) => unknown,
    status = 200,
  ) {
    app.route({
      method,
      url,
      bodyLimit: 256 * 1024,
      handler: async (request, reply) => {
        reply.header('Cache-Control', 'no-store');
        const parsed = schema.safeParse(method === 'GET' ? request.query : (request.body ?? {}));
        const params = z.object({ id: id.optional() }).strict().safeParse(request.params);
        if (!parsed.success || !params.success)
          return reply.code(400).send({ code: 'INVALID', message: 'Invalid rehearsal input.' });
        const controller = new AbortController();
        const abort = () => controller.abort();
        const disconnected = () => {
          if (!reply.raw.writableFinished) abort();
        };
        request.raw.once('aborted', abort);
        reply.raw.once('close', disconnected);
        try {
          const result = await action(parsed.data, request, controller.signal);
          return reply.code(status).send(result);
        } catch (error) {
          return failure(reply, error);
        } finally {
          request.raw.removeListener('aborted', abort);
          reply.raw.removeListener('close', disconnected);
        }
      },
    });
  }
  route('GET', '/api/rehearsals/scenarios', empty, () => ({ scenarios: rehearsal.scenarios() }));
  route(
    'POST',
    '/api/rehearsals/scenarios',
    z.union([
      z.object({ name, scenario: rehearsalScenarioSchema }).strict(),
      z.object({ name, recording }).strict(),
    ]),
    (body) => ({ scenario: rehearsal.create(body) }),
    201,
  );
  route('GET', '/api/rehearsals/scenarios/:id', empty, (_, request) => ({
    scenario: rehearsal.scenario(parameter(request)),
  }));
  route(
    'PUT',
    '/api/rehearsals/scenarios/:id',
    z.object({ name, scenario: rehearsalScenarioSchema, expectedRevision: revision }).strict(),
    (body, request) => ({ scenario: rehearsal.update(parameter(request), body) }),
  );
  route(
    'DELETE',
    '/api/rehearsals/scenarios/:id',
    z.object({ expectedRevision: revision }).strict(),
    (body, request) => {
      rehearsal.deleteScenario(parameter(request), body.expectedRevision);
      return { ok: true };
    },
  );
  route(
    'POST',
    '/api/rehearsals/presets',
    z.object({ versionId: id, preset: z.enum(REHEARSAL_PRESETS), seed }).strict(),
    (body) => ({ scenario: rehearsal.preset(body) }),
  );
  route('POST', '/api/rehearsals/recordings', recording, (body) => ({
    scenario: rehearsal.recording(body),
  }));
  route(
    'POST',
    '/api/rehearsals/scenarios/:id/run',
    z
      .object({
        expectedRevision: revision,
        versionId: id,
        compareVersionId: id.optional(),
        through: z.number().int().min(0).max(120).optional(),
        freshStart: z.boolean().optional(),
      })
      .strict(),
    async (body, request, signal) => ({
      run: await rehearsal.runScenario(parameter(request), body, signal),
    }),
    201,
  );
  route('GET', '/api/rehearsals/runs', empty, () => ({ runs: rehearsal.runs() }));
  route('GET', '/api/rehearsals/runs/:id', empty, (_, request) => ({
    run: rehearsal.run(parameter(request)),
  }));
  route(
    'POST',
    '/api/rehearsals/runs/:id/minimize',
    z
      .object({ side: z.enum(['primary', 'compare']), checkId: z.string().min(1).max(100) })
      .strict(),
    async (body, request, signal) => ({
      run: await rehearsal.minimize(parameter(request), body, signal),
    }),
    201,
  );
  route('GET', '/api/rehearsals/regressions', empty, () => ({
    regressions: rehearsal.regressions(),
  }));
  route(
    'POST',
    '/api/rehearsals/regressions',
    z.object({ name, runId: id, checkId: z.string().min(1).max(100) }).strict(),
    (body) => ({ regression: rehearsal.saveRegression(body) }),
    201,
  );
  route('DELETE', '/api/rehearsals/regressions/:id', empty, (_, request) => {
    rehearsal.deleteRegression(parameter(request));
    return { ok: true };
  });
  route(
    'POST',
    '/api/rehearsals/regressions/:id/run',
    z.object({ versionId: id }).strict(),
    async (body, request, signal) => ({
      run: await rehearsal.runRegression(parameter(request), body.versionId, signal),
    }),
    201,
  );
  route(
    'POST',
    '/api/rehearsals/regressions/:id/repair',
    z.object({ intent: z.string().trim().min(8).max(1200) }).strict(),
    (body, request) => {
      const regression = rehearsal.regression(parameter(request));
      return authoring.start({
        intent: body.intent,
        baseVersionId: regression.originVersionId,
        regressionId: regression.id,
      });
    },
    202,
  );
}
