import { z } from 'zod';
import { sceneSchema, QueueFullError } from '@riff/compiler';
import type { FastifyInstance } from 'fastify';
import { SceneError } from '../services/scenes/contract.js';
import type { SceneService } from '../services/scenes/service.js';
import { ProposalError } from '../services/proposals/service.js';
const revision = z.number().int().min(0).max(100);
/** Private same-origin guarded scene API. All destinations and artifacts are host-resolved. */
export function registerSceneRoutes(app: FastifyInstance, service: SceneService) {
  function route<T>(
    method: 'GET' | 'POST',
    suffix: string,
    schema: z.ZodType<T>,
    action: (versionId: string, input: T, signal: AbortSignal) => unknown,
  ) {
    app.route({
      method,
      url: `/api/scenes/:versionId${suffix}`,
      bodyLimit: 32 * 1024,
      handler: async (request, reply) => {
        reply.header('Cache-Control', 'no-store');
        const params = z
          .object({ versionId: z.string().uuid() })
          .strict()
          .safeParse(request.params);
        const input = schema.safeParse(method === 'GET' ? request.query : request.body);
        if (!params.success || !input.success) {
          // Host-authored layout rules are safe to show; they name the object to fix.
          const reasons = [
            ...new Set(
              (input.success ? [] : input.error.issues)
                .filter((issue) => issue.code === 'custom' && issue.path[0] === 'scene')
                .map((issue) => issue.message),
            ),
          ].slice(0, 3);
          return reply.code(400).send({
            code: 'INVALID',
            message: reasons.length
              ? `This layout can't be saved: ${reasons.join('; ')}.`
              : 'Invalid scene input. Check the selected region, geometry and timing.',
          });
        }
        const controller = new AbortController();
        const abort = () => controller.abort();
        const disconnected = () => {
          if (!reply.raw.writableFinished) abort();
        };
        request.raw.once('aborted', abort);
        reply.raw.once('close', disconnected);
        try {
          return { state: await action(params.data.versionId, input.data, controller.signal) };
        } catch (error) {
          if (error instanceof SceneError)
            return reply
              .code(
                error.code === 'INVALID'
                  ? 400
                  : error.code === 'NOT_FOUND'
                    ? 404
                    : error.code === 'LIMIT'
                      ? 429
                      : 409,
              )
              .send({ code: error.code, message: error.message });
          if (error instanceof QueueFullError)
            return reply.code(429).send({ code: error.code, message: error.message });
          if (error instanceof ProposalError)
            return reply.code(409).send({
              code: 'BLOCKED',
              message: 'The audience selection behind this behavior is no longer authorized.',
            });
          if (suffix !== '/generate') {
            request.log.error({ err: error }, 'scene request failed');
            return reply.code(500).send({
              code: 'FAILED',
              message: 'The layout service failed. Reload the layout and try again.',
            });
          }
          // Model text and raw validation errors are untrusted; return a bounded action-oriented message.
          return reply.code(400).send({
            code: 'INVALID',
            message:
              'Scene generation could not produce a valid presentation edit. In offline mode use “Move right by 10 units” or “Show this after the round ends for 5 seconds”. Behavior changes use Describe and review.',
          });
        } finally {
          request.raw.removeListener('aborted', abort);
          reply.raw.removeListener('close', disconnected);
        }
      },
    });
  }
  route('GET', '', z.object({}).strict(), (id) => service.view(id));
  route(
    'POST',
    '',
    z
      .object({ expectedRevision: revision, scene: sceneSchema, source: z.literal('direct') })
      .strict(),
    (id, body) => service.save(id, body.expectedRevision, body.scene),
  );
  route(
    'POST',
    '/undo',
    z.object({ expectedRevision: revision, targetRevision: revision }).strict(),
    (id, body) => service.undo(id, body.expectedRevision, body.targetRevision),
  );
  route(
    'POST',
    '/apply',
    z.object({ expectedRevision: revision, digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
    (id, body) => service.apply(id, body.expectedRevision, body.digest),
  );
  route(
    'POST',
    '/generate',
    z
      .object({
        expectedRevision: revision,
        selectionId: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/),
        intent: z.string().trim().min(8).max(1200),
      })
      .strict(),
    (id, body, signal) => service.generate(id, body, signal),
  );
}
