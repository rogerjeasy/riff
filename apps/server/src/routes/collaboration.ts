import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import {
  CollaborationError,
  rolesSchema,
  digestSchema,
  inputSchema,
  tokenSchema,
} from '../services/collaboration/contract.js';
import type { createCoordinator } from '../services/collaboration/coordinator.js';
import type { CollaborationMember } from '../services/collaboration/member.js';
import { coordinatorUrl } from '../services/collaboration/transport.js';

type Coordinator = ReturnType<typeof createCoordinator>;
/** Operator mutations are guarded globally; peer routes only admit scoped membership bearers. */
export function registerCollaborationRoutes(
  app: FastifyInstance,
  deps: {
    coordinator: Coordinator;
    member: CollaborationMember;
    identity: () => string | null;
    login?: () => string | null;
    publicUrl: string;
    configured: boolean;
    ready: () => boolean;
  },
) {
  const empty = z.object({}).strict();
  const uuid = z.string().uuid();
  const privateAction = <T>(path: string, schema: z.ZodType<T>, action: (input: T) => unknown) => {
    app.post(`/api/collaboration${path}`, { bodyLimit: 16 * 1024 }, async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const parsed = schema.safeParse(request.body);
      if (!parsed.success)
        return reply
          .code(400)
          .send({ code: 'INVALID', message: 'Check the collaboration fields and try again.' });
      try {
        return await action(parsed.data);
      } catch (error) {
        const known = error instanceof CollaborationError;
        return reply.code(known && error.code === 'LIMIT' ? 429 : 409).send({
          code: known ? error.code : 'BLOCKED',
          message: known
            ? error.message
            : error instanceof Error && !(error instanceof z.ZodError)
              ? error.message.slice(0, 400)
              : 'The collaboration could not be verified. Review it again.',
        });
      }
    });
  };
  app.get('/api/collaboration', (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return {
      sessions: deps.coordinator.list(),
      member: deps.member.status(),
      channelId: deps.identity(),
      login: deps.login?.() ?? null,
      configured: deps.configured,
      ready: deps.ready(),
    };
  });
  privateAction(
    '/create',
    z.object({ versionId: uuid, roles: rolesSchema, raidHandoff: z.boolean().optional() }).strict(),
    async ({ versionId, roles, raidHandoff }) => {
      if (!deps.configured) throw new Error('Configure RIFF_SECRET before connecting channels.');
      if (['connected', 'paused'].includes(deps.member.status().state))
        throw new Error('Leave the current shared session first.');
      return { session: await deps.coordinator.create(versionId, roles, raidHandoff ?? false) };
    },
  );
  privateAction(
    '/invite',
    z.object({ sessionId: uuid, roleId: z.string().max(32) }).strict(),
    ({ sessionId, roleId }) => {
      const invitation = deps.coordinator.invite(sessionId, roleId);
      return {
        origin: coordinatorUrl(deps.publicUrl),
        token: invitation.token,
        expiresAt: invitation.expiresAt,
        roleId: invitation.roleId,
      };
    },
  );
  privateAction('/review-owner', z.object({ sessionId: uuid }).strict(), async ({ sessionId }) => {
    const session = deps.coordinator.view(sessionId);
    const role = session.contract.roles.find((r) => r.channelId === deps.identity());
    if (!role)
      throw new Error('The connected Twitch channel does not own a role in this agreement.');
    if (['connected', 'paused'].includes(deps.member.status().state))
      throw new Error('Leave the current membership before reviewing another.');
    const invitation = deps.coordinator.invite(sessionId, role.id);
    return { review: await deps.member.review('local', invitation.token) };
  });
  privateAction(
    '/review',
    z.object({ origin: z.string().max(256), token: tokenSchema }).strict(),
    async ({ origin, token }) => ({
      review: await deps.member.review(coordinatorUrl(origin), token),
    }),
  );
  privateAction('/recheck', empty, async () => ({ review: await deps.member.recheck() }));
  privateAction('/approve', z.object({ digest: digestSchema }).strict(), async ({ digest }) => ({
    member: await deps.member.approve(digest),
  }));
  privateAction('/leave', empty, () => {
    deps.member.stop();
    return { ok: true };
  });
  privateAction(
    '/control',
    z
      .object({
        sessionId: uuid,
        expectedRevision: z.number().int().nonnegative(),
        action: z.enum(['start', 'pause', 'resume', 'wait', 'continue', 'end']),
      })
      .strict(),
    ({ sessionId, expectedRevision, action }) => ({
      session: deps.coordinator.control(sessionId, expectedRevision, action),
    }),
  );

  function peer<T>(action: string, schema: z.ZodType<T>, run: (token: string, body: T) => unknown) {
    app.post(`/peer/collaboration/${action}`, { bodyLimit: 4096 }, async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      // Browser-origin requests have no standing; tokens travel only server-to-server.
      const parsed = tokenSchema.safeParse(request.headers.authorization?.replace(/^Bearer /, ''));
      if (
        !parsed.success ||
        !request.headers.authorization?.startsWith('Bearer ') ||
        request.headers.origin ||
        request.headers['sec-fetch-site']
      )
        return reply
          .code(401)
          .send({ code: 'UNAUTHORIZED', message: 'A valid membership credential is required.' });
      const body = schema.safeParse(request.body);
      if (!body.success)
        return reply.code(400).send({ code: 'INVALID', message: 'Invalid peer message.' });
      try {
        return await run(parsed.data, body.data);
      } catch (error) {
        const code = error instanceof CollaborationError ? error.code : 'BLOCKED';
        return reply
          .code(
            code === 'UNAUTHORIZED' || code === 'NOT_FOUND' ? 403 : code === 'LIMIT' ? 429 : 409,
          )
          .send({
            code,
            // Coordinator messages are fixed host text; they tell the invited creator what to do.
            message:
              error instanceof CollaborationError
                ? error.message
                : 'The collaboration request was denied. Review current membership.',
          });
      }
    });
  }
  peer('review', empty, (token) => deps.coordinator.review(token));
  peer('approve', z.object({ digest: digestSchema }).strict(), (token, body) =>
    deps.coordinator.approve(token, body.digest),
  );
  peer('heartbeat', empty, (token) => deps.coordinator.heartbeat(token));
  peer('input', inputSchema, (token, body) => deps.coordinator.input(token, body));
  peer(
    'handoff',
    z
      .object({
        eventId: z.string().min(1).max(100),
        fromChannelId: z.string().regex(/^\d{1,32}$/),
      })
      .strict(),
    (token, body) => deps.coordinator.handoff(token, body),
  );
  peer('leave', empty, (token) => {
    deps.coordinator.leave(token);
    return { ok: true };
  });
}
