import type { FastifyInstance, FastifyReply } from 'fastify';
import type { z } from 'zod';
import {
  announceBody,
  featureToggleBody,
  policyBody,
  pollBody,
  shoutoutBody,
} from '../services/twitch-features/contract.js';
import { HTTP_STATUS, RiffError } from '../services/twitch-features/errors.js';
import type { TwitchFeatureService } from '../services/twitch-features/service.js';

/**
 * Private creator routes for native Twitch polls, announcements and shoutouts. Mutations
 * sit behind the existing same-origin + `x-riff-request` guard and optional console
 * session. Routes only parse, authorize and call the service.
 */
export function registerTwitchFeatureRoutes(app: FastifyInstance, service: TwitchFeatureService) {
  const fail = (reply: FastifyReply, error: unknown) => {
    if (error instanceof RiffError)
      return reply.code(HTTP_STATUS[error.code]).send({ code: error.code, message: error.message });
    throw error;
  };
  const invalid = (reply: FastifyReply, error: z.ZodError) => {
    const issue = error.issues[0];
    const field = issue?.path.join('.') || 'request';
    return reply.code(400).send({
      code: 'INVALID_REQUEST',
      message: `Check ${field}: ${issue?.message ?? 'invalid value'}.`,
    });
  };
  const run = async <T>(reply: FastifyReply, fn: () => Promise<T>) => {
    try {
      return { features: await fn() };
    } catch (error) {
      return fail(reply, error);
    }
  };

  app.get('/api/twitch/features', async (_req, reply) => {
    reply.header('Cache-Control', 'no-store');
    return { features: service.snapshot() };
  });
  app.post('/api/twitch/features/toggle', async (req, reply) => {
    const body = featureToggleBody.safeParse(req.body);
    if (!body.success) return invalid(reply, body.error);
    return run(reply, () => service.setFeature(body.data.feature, body.data.enabled));
  });
  app.post('/api/twitch/features/eligibility', async (_req, reply) =>
    run(reply, () => service.refreshEligibility()),
  );
  app.post('/api/twitch/polls', async (req, reply) => {
    const body = pollBody.safeParse(req.body);
    if (!body.success) return invalid(reply, body.error);
    return run(reply, async () => {
      await service.startPoll(body.data);
      return service.snapshot();
    });
  });
  app.post('/api/twitch/polls/end', async (_req, reply) =>
    run(reply, async () => {
      await service.endPoll();
      return service.snapshot();
    }),
  );
  app.post('/api/twitch/announcements', async (req, reply) => {
    const body = announceBody.safeParse(req.body);
    if (!body.success) return invalid(reply, body.error);
    return run(reply, async () => {
      await service.announce(body.data);
      return service.snapshot();
    });
  });
  app.post('/api/twitch/shoutouts', async (req, reply) => {
    const body = shoutoutBody.safeParse(req.body);
    if (!body.success) return invalid(reply, body.error);
    return run(reply, async () => {
      await service.shoutout(body.data.login);
      return service.snapshot();
    });
  });
  app.post('/api/twitch/shoutouts/policy', async (req, reply) => {
    const body = policyBody.safeParse(req.body);
    if (!body.success) return invalid(reply, body.error);
    return run(reply, () => service.setShoutoutPolicy(body.data.mode, body.data.logins));
  });
}
