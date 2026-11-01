import { z } from 'zod';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { CHANNEL_POINTS_LIMITS, PREDICTION_LIMITS } from '@riff/twitch';
import type { ChannelPointsService } from '../services/channel-points/service.js';
import type { PredictionsService } from '../services/predictions/service.js';
import { FEATURE_STATUS, FeatureError } from '../services/twitch/features.js';

const rewardId = z.string().min(1).max(100);
const title = z.string().trim().min(1).max(CHANNEL_POINTS_LIMITS.titleLength);
const rewardBody = z
  .object({
    title,
    cost: z.number().int().min(1).max(1_000_000_000),
    prompt: z.string().max(CHANNEL_POINTS_LIMITS.promptLength).default(''),
    inputRequired: z.boolean().default(false),
    cooldownSeconds: z
      .number()
      .int()
      .min(1)
      .max(CHANNEL_POINTS_LIMITS.maxCooldownSeconds)
      .nullable()
      .default(null),
  })
  .strict();
const rewardPatch = z
  .object({
    title: title.optional(),
    cost: z.number().int().min(1).max(1_000_000_000).optional(),
    prompt: z.string().max(CHANNEL_POINTS_LIMITS.promptLength).optional(),
    inputRequired: z.boolean().optional(),
    cooldownSeconds: z
      .number()
      .int()
      .min(1)
      .max(CHANNEL_POINTS_LIMITS.maxCooldownSeconds)
      .nullable()
      .optional(),
    paused: z.boolean().optional(),
    enabled: z.boolean().optional(),
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, 'Nothing to update');
const predictionBody = z
  .object({
    title: z.string().trim().min(1).max(PREDICTION_LIMITS.titleLength),
    outcomes: z
      .array(z.string().trim().min(1).max(PREDICTION_LIMITS.outcomeLength))
      .min(PREDICTION_LIMITS.outcomes.min)
      .max(PREDICTION_LIMITS.outcomes.max),
    windowSeconds: z
      .number()
      .int()
      .min(PREDICTION_LIMITS.windowSeconds.min)
      .max(PREDICTION_LIMITS.windowSeconds.max),
  })
  .strict();
const endBody = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('resolve'),
      predictionId: z.string().min(1).max(100),
      winningOutcomeId: z.string().min(1).max(100),
      confirm: z.literal(true),
    })
    .strict(),
  z
    .object({
      action: z.enum(['lock', 'cancel']),
      predictionId: z.string().min(1).max(100),
      confirm: z.literal(true),
    })
    .strict(),
]);

function fail(reply: FastifyReply, error: unknown) {
  if (error instanceof FeatureError)
    return reply
      .code(FEATURE_STATUS[error.code])
      .send({ code: error.code, message: error.message });
  reply.log.error({ err: error }, 'channel points request failed');
  return reply
    .code(500)
    .send({
      code: 'FAILED',
      message: 'Riff could not complete that. Nothing was changed on Twitch.',
    });
}
function parsed<T>(schema: z.ZodType<T>, value: unknown, message: string): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new FeatureError('INVALID', message);
  return result.data;
}

/**
 * Creator-console routes for F22. They parse, rely on the global same-origin mutation
 * guard and console session, and call the services; no Helix call happens here.
 */
export function registerChannelPointsRoutes(
  app: FastifyInstance,
  deps: { points: ChannelPointsService; predictions: PredictionsService },
) {
  const { points, predictions } = deps;
  const run = async (reply: FastifyReply, work: () => unknown) => {
    reply.header('Cache-Control', 'no-store');
    try {
      return await work();
    } catch (error) {
      return fail(reply, error);
    }
  };
  const id = z.object({ id: rewardId });
  const confirm = z.object({ confirm: z.literal(true) }).strict();
  const link = z
    .object({
      automationId: z.string().min(1).max(100).nullable(),
      policy: z.enum(['auto', 'manual']),
    })
    .strict();
  const settle = z.object({ action: z.enum(['fulfil', 'refund']) }).strict();
  app.get('/api/channel-points', (_request, reply) => run(reply, () => points.view()));
  app.post('/api/channel-points/refresh', (_request, reply) => run(reply, () => points.refresh()));
  app.post('/api/channel-points/rewards', { bodyLimit: 4096 }, (request, reply) =>
    run(reply, () =>
      points.createReward(
        parsed(
          rewardBody,
          request.body,
          'A reward needs a 1–45 character title and a cost of at least 1 point.',
        ),
      ),
    ),
  );
  app.post('/api/channel-points/rewards/:id', { bodyLimit: 4096 }, (request, reply) =>
    run(reply, () =>
      points.updateReward(
        parsed(id, request.params, 'Unknown reward.').id,
        parsed(rewardPatch, request.body, 'Check the reward fields.'),
      ),
    ),
  );
  app.post('/api/channel-points/rewards/:id/delete', (request, reply) =>
    run(reply, () => {
      parsed(confirm, request.body, 'Confirm deletion.');
      return points.deleteReward(parsed(id, request.params, 'Unknown reward.').id);
    }),
  );
  app.post('/api/channel-points/rewards/:id/link', (request, reply) =>
    run(reply, () => {
      const body = parsed(
        link,
        request.body,
        'Choose an interaction (or none) and a refund policy.',
      );
      return points.link(
        parsed(id, request.params, 'Unknown reward.').id,
        body.automationId,
        body.policy,
      );
    }),
  );
  app.post('/api/channel-points/redemptions/:id', (request, reply) =>
    run(reply, () =>
      points.settle(
        parsed(id, request.params, 'Unknown redemption.').id,
        parsed(settle, request.body, 'Choose fulfil or refund.').action,
      ),
    ),
  );

  app.get('/api/predictions', (_request, reply) => run(reply, () => predictions.view()));
  app.post('/api/predictions/refresh', (_request, reply) =>
    run(reply, () => predictions.refresh()),
  );
  app.post('/api/predictions', { bodyLimit: 4096 }, (request, reply) =>
    run(reply, () =>
      predictions.open(
        parsed(
          predictionBody,
          request.body,
          'A prediction needs a 1–45 character question, 2–10 outcomes of up to 25 characters and 30–1800 seconds.',
        ),
      ),
    ),
  );
  app.post('/api/predictions/proposals/:id/open', (request, reply) =>
    run(reply, () => predictions.openProposal(parsed(id, request.params, 'Unknown proposal.').id)),
  );
  app.post('/api/predictions/proposals/:id/dismiss', (request, reply) =>
    run(reply, () => predictions.dismiss(parsed(id, request.params, 'Unknown proposal.').id)),
  );
  app.post('/api/predictions/end', (request, reply) =>
    run(reply, () => {
      const body = parsed(
        endBody,
        request.body,
        'Confirm the action. Resolving needs the winning outcome you chose.',
      );
      return predictions.end({
        predictionId: body.predictionId,
        action: body.action,
        winningOutcomeId: body.action === 'resolve' ? body.winningOutcomeId : null,
      });
    }),
  );
}
