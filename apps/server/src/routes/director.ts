import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import {
  directorEnvelopeSchema,
  directorSettingsSchema,
  DirectorError,
} from '../services/director/contract.js';
import type { DirectorService } from '../services/director/service.js';
const revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const FIELD_NAMES: Record<string, string> = {
  intervalMs: 'Pause between batches',
  batchSize: 'Effects per batch',
  intensity: 'Visual intensity',
  interruptionsPerMinute: 'Interruptions per minute',
  participation: 'Participation order',
  expectedRevision: 'Director revision',
  versionId: 'Version',
};
/** Name the first invalid field in creator language rather than returning a generic failure. */
function describeIssue(error: z.ZodError) {
  const issue = error.issues[0];
  const field = issue?.path.find((part) => typeof part === 'string' && part in FIELD_NAMES);
  return field
    ? `${FIELD_NAMES[field as string]}: ${issue?.message ?? 'invalid'}.`
    : 'Check the presentation ranges.';
}
/** Operator-local API; all mutations use the global same-origin guard. */
export function registerDirectorRoutes(app: FastifyInstance, service: DirectorService) {
  app.get('/api/director', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return { state: service.view() };
  });
  function route<T>(path: string, schema: z.ZodType<T>, action: (input: T) => unknown) {
    app.post(`/api/director/${path}`, { bodyLimit: 4096 }, async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const parsed = schema.safeParse(request.body);
      if (!parsed.success)
        return reply.code(400).send({
          code: 'INVALID',
          message: `${describeIssue(parsed.error)} Commands, cooldowns, audience and resources require behavior review.`,
        });
      try {
        return { state: await action(parsed.data) };
      } catch (error) {
        if (error instanceof DirectorError)
          return reply
            .code(
              error.code === 'INVALID'
                ? 400
                : error.code === 'NOT_FOUND'
                  ? 404
                  : error.code === 'BUSY'
                    ? 429
                    : 409,
            )
            .send({ code: error.code, message: error.message });
        request.log.error({ err: error }, 'director request failed');
        return reply.code(500).send({
          code: 'FAILED',
          message:
            'The director operation failed. Reload before trying again; stopped presentation remains stopped.',
        });
      }
    });
  }
  route(
    'draft',
    z.object({ expectedRevision: revision, envelope: directorEnvelopeSchema }).strict(),
    (b) => service.save(b.expectedRevision, b.envelope),
  );
  route(
    'rehearse',
    z.object({ expectedRevision: revision, versionId: z.string().uuid() }).strict(),
    (b) => service.rehearse(b.expectedRevision, b.versionId),
  );
  route(
    'approve',
    z.object({ expectedRevision: revision, digest, evidenceHash: digest }).strict(),
    (b) => service.approve(b.expectedRevision, b.digest, b.evidenceHash),
  );
  route(
    'control',
    z
      .object({
        expectedRevision: revision,
        action: z.enum(['balanced', 'gameplay', 'locked', 'manual']),
        settings: directorSettingsSchema.optional(),
      })
      .strict()
      .refine((b) => (b.action === 'manual' ? !!b.settings : b.settings === undefined)),
    (b) => service.control(b.expectedRevision, b.action, b.settings),
  );
  route('stop', z.object({}).strict(), () => service.stop());
}
