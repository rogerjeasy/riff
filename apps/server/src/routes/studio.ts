import type { ProposalService } from '../services/proposals/service.js';
import { ProposalError } from '../services/proposals/service.js';
import { communityProjection } from '../services/proposals/projection.js';
import { proposalFailure } from './proposals.js';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { eventSchema, timerNameSchema } from '@riff/sandbox';
import { AuthoringError, type AuthoringService } from '../services/authoring/service.js';
import { StudioError, type StudioService } from '../services/automations/studio.js';
import type { PreviewService } from '../services/rehearsal/preview.js';
import type { ChannelRepository } from '../db/repositories/studio.js';
import type { OverlayBroker } from '../services/overlay/broker.js';
import type { TwitchConnection } from '../services/twitch/connection.js';

const id = z.string().uuid();
const params = z.object({ id }).strict();
const replaySchema = z
  .object({ seed: z.number().int().min(1).max(0xffff_ffff), events: z.array(eventSchema).max(120) })
  .strict();

function fail(reply: FastifyReply, error: unknown) {
  if (error instanceof ProposalError) return proposalFailure(reply, error);
  if (error instanceof StudioError || error instanceof AuthoringError) {
    const status = { NOT_FOUND: 404, STALE: 409, BLOCKED: 409, QUEUE_FULL: 429, CONFLICT: 409 }[
      error.code
    ];
    return reply.code(status).send({ code: error.code, message: error.message });
  }
  throw error;
}

/** Routes only parse, authorize (see the mutation guard in app.ts) and call a service. */
export function registerStudioRoutes(
  app: FastifyInstance,
  deps: {
    studio: StudioService;
    authoring: AuthoringService;
    preview: PreviewService;
    repo: ChannelRepository;
    overlay: OverlayBroker;
    twitch: TwitchConnection;
    publicUrl: string;
    proposals: ProposalService;
  },
) {
  const { studio, authoring, preview, repo } = deps;
  app.get('/api/studio', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return {
      ...studio.snapshot(),
      proposals: deps.proposals.snapshot(),
      community: communityProjection(deps.proposals, repo),
      compiler: authoring.transport,
      runs: authoring.runs(),
      twitch: { ...deps.twitch.status, configured: deps.twitch.configured },
    };
  });
  app.post('/api/compile-runs', async (request, reply) => {
    const body = z
      .object({
        intent: z.string().trim().min(8).max(1200),
        baseVersionId: id.nullable().default(null),
      })
      .strict()
      .safeParse(request.body);
    if (!body.success)
      return reply
        .code(400)
        .send({ code: 'INVALID', message: 'Describe the interaction in at least a few words.' });
    try {
      return reply.code(202).send(authoring.start(body.data));
    } catch (error) {
      return fail(reply, error);
    }
  });
  app.post('/api/compile-runs/:id/cancel', async (request, reply) => {
    const p = params.safeParse(request.params);
    if (!p.success) return reply.code(404).send({ code: 'NOT_FOUND', message: 'Unknown run.' });
    try {
      return authoring.cancel(p.data.id);
    } catch (error) {
      return fail(reply, error);
    }
  });
  app.post('/api/versions/:id/preview', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const p = params.safeParse(request.params);
    const body = replaySchema.safeParse(request.body);
    if (!p.success || !body.success)
      return reply
        .code(400)
        .send({ code: 'INVALID', message: 'Provide a seed and up to 120 valid synthetic events.' });
    const version = repo.version(p.data.id);
    if (!version)
      return reply.code(404).send({ code: 'NOT_FOUND', message: 'That version no longer exists.' });
    const controller = new AbortController();
    const cancel = () => {
      if (!reply.raw.writableEnded) controller.abort();
    };
    reply.raw.once('close', cancel);
    try {
      const result = await preview.replay(
        { source: version.source, manifest: version.manifest },
        body.data.events,
        body.data.seed,
        controller.signal,
      );
      if (!result)
        return reply
          .code(429)
          .send({ code: 'BUSY', message: 'Another rehearsal is running. Try again shortly.' });
      return result;
    } catch {
      return reply
        .code(422)
        .send({ code: 'INVALID_ARTIFACT', message: 'This version cannot run in the sandbox.' });
    } finally {
      reply.raw.removeListener('close', cancel);
    }
  });
  app.post('/api/versions/:id/transition/preview', async (request, reply) => {
    const p = params.safeParse(request.params);
    const body = z
      .object({
        migrationSource: z.string().min(1).max(32768).optional(),
        boundary: z.enum(['immediate', 'round-end', 'stopped']),
        events: z.array(eventSchema).max(24).optional(),
        seed: z.number().int().min(1).max(0xffffffff).optional(),
      })
      .strict()
      .safeParse(request.body);
    if (!p.success || !body.success)
      return reply.code(400).send({
        code: 'INVALID',
        message: 'Provide a bounded migration source, boundary and at most 24 hypothetical events.',
      });
    try {
      return { transition: await studio.previewTransition(p.data.id, body.data) };
    } catch (error) {
      return fail(reply, error);
    }
  });
  app.post('/api/transitions/:id/approve', async (request, reply) => {
    const p = params.safeParse(request.params);
    const body = z
      .object({
        evidenceId: z.string().regex(/^[a-f0-9]{64}$/),
        artifactId: z.string().regex(/^[a-f0-9]{64}$/),
        expectedActiveVersionId: id,
        sessionId: id,
        boundary: z.enum(['immediate', 'round-end', 'stopped']),
      })
      .strict()
      .safeParse(request.body);
    if (!p.success || !body.success)
      return reply.code(400).send({
        code: 'INVALID',
        message: 'Approval must bind exact transition evidence and source session.',
      });
    try {
      return { transition: await studio.approveTransition(p.data.id, body.data) };
    } catch (error) {
      return fail(reply, error);
    }
  });
  app.post('/api/transitions/:id/cancel', async (request, reply) => {
    const p = params.safeParse(request.params);
    if (!p.success)
      return reply.code(400).send({ code: 'INVALID', message: 'Invalid transition.' });
    try {
      return { transition: studio.cancelTransition(p.data.id) };
    } catch (error) {
      return fail(reply, error);
    }
  });
  app.post('/api/versions/:id/approve', async (request, reply) => {
    const p = params.safeParse(request.params);
    const body = z
      .object({
        artifactId: z.string().regex(/^[a-f0-9]{64}$/),
        expectedActiveVersionId: id.nullable(),
        resetSession: z.boolean().optional(),
      })
      .strict()
      .safeParse(request.body);
    if (!p.success || !body.success)
      return reply
        .code(400)
        .send({ code: 'INVALID', message: 'Approval must name the exact artifact you reviewed.' });
    try {
      const version = studio.approve(p.data.id, {
        artifactId: body.data.artifactId,
        activeVersionId: body.data.expectedActiveVersionId,
        ...(body.data.resetSession === undefined ? {} : { resetSession: body.data.resetSession }),
      });
      return { versionId: version.id, status: version.status };
    } catch (error) {
      return fail(reply, error);
    }
  });
  app.post('/api/versions/:id/discard', async (request, reply) => {
    const p = params.safeParse(request.params);
    if (!p.success) return reply.code(404).send({ code: 'NOT_FOUND', message: 'Unknown version.' });
    try {
      studio.discard(p.data.id);
      return { ok: true };
    } catch (error) {
      return fail(reply, error);
    }
  });
  for (const action of ['pause', 'resume', 'rollback'] as const)
    app.post(`/api/automations/:id/${action}`, async (request, reply) => {
      const p = params.safeParse(request.params);
      if (!p.success)
        return reply.code(404).send({ code: 'NOT_FOUND', message: 'Unknown interaction.' });
      try {
        if (action === 'pause') studio.pause(p.data.id);
        else if (action === 'resume') studio.resumeAutomation(p.data.id);
        else {
          const consent = z
            .object({ resetSession: z.boolean().optional() })
            .strict()
            .safeParse(request.body ?? {});
          if (!consent.success)
            return reply.code(400).send({ code: 'INVALID', message: 'Invalid rollback consent.' });
          studio.rollback(p.data.id, consent.data.resetSession ?? false);
        }
        return { ok: true };
      } catch (error) {
        return fail(reply, error);
      }
    });
  app.post('/api/automations/:id/timers/:name/cancel', async (request, reply) => {
    const p = z.object({ id, name: timerNameSchema }).strict().safeParse(request.params);
    if (!p.success) return reply.code(404).send({ code: 'NOT_FOUND', message: 'Unknown timer.' });
    try {
      return await studio.cancelTimer(p.data.id, p.data.name);
    } catch (error) {
      return fail(reply, error);
    }
  });
  app.post('/api/automations/:id/session/reset', async (request, reply) => {
    const p = params.safeParse(request.params);
    const body = z
      .object({ confirm: z.literal(true) })
      .strict()
      .safeParse(request.body);
    if (!p.success || !body.success)
      return reply.code(400).send({
        code: 'CONFIRM',
        message: 'Confirm that current session progress and resources may be reset.',
      });
    try {
      return { session: studio.resetSession(p.data.id) };
    } catch (error) {
      return fail(reply, error);
    }
  });
  app.post('/api/automations/:id/session/audit', async (request, reply) => {
    const p = params.safeParse(request.params);
    if (!p.success)
      return reply.code(400).send({ code: 'INVALID', message: 'Invalid automation.' });
    try {
      return { audit: await studio.auditSession(p.data.id) };
    } catch (error) {
      return fail(reply, error);
    }
  });
  app.post('/api/channel/panic', async () => {
    studio.panic('console stop button');
    return { ok: true, panic: true };
  });
  app.post('/api/channel/resume', async (request, reply) => {
    const body = z
      .object({ confirm: z.literal(true) })
      .strict()
      .safeParse(request.body);
    if (!body.success)
      return reply.code(400).send({
        code: 'CONFIRM',
        message: 'Confirm that every approved interaction may run again.',
      });
    try {
      studio.resume();
      return { ok: true, panic: false };
    } catch (error) {
      return fail(reply, error);
    }
  });
  app.get('/api/overlay', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return {
      url: `${deps.publicUrl}/overlay/?key=${repo.state().overlayKey}`,
      connections: deps.overlay.connections,
    };
  });
  app.post('/api/overlay/test', async () => ({ delivered: deps.overlay.testFrame() }));
  app.post('/api/overlay/rotate', async () => {
    repo.updateState({
      overlayKey: (await import('node:crypto')).randomBytes(16).toString('base64url'),
    });
    deps.overlay.disconnectAll();
    return { url: `${deps.publicUrl}/overlay/?key=${repo.state().overlayKey}` };
  });
}
