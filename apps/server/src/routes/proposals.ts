import { z } from 'zod';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { ProposalError, type ProposalService } from '../services/proposals/service.js';
import { AuthoringError, type AuthoringService } from '../services/authoring/service.js';
import type { ChannelRepository } from '../db/repositories/studio.js';
import { communityProjection } from '../services/proposals/projection.js';
const id = z.string().uuid();
const revision = z.number().int().nonnegative();
const creator = { kind: 'creator' } as const;
export function proposalFailure(reply: FastifyReply, error: unknown) {
  if (!(error instanceof ProposalError)) throw error;
  const code = error.code;
  const status =
    code === 'FORBIDDEN'
      ? 403
      : code === 'NOT_FOUND'
        ? 404
        : code === 'INVALID'
          ? 400
          : code.endsWith('LIMIT')
            ? 429
            : 409;
  return reply.code(status).send({
    code,
    message:
      code === 'STALE'
        ? 'This idea changed while you were looking at it. The inbox has refreshed; check it and try again.'
        : code === 'REVOKED'
          ? 'This idea was hidden or replaced, so its selection no longer counts. Pick an eligible idea again.'
          : code === 'BALLOT_OPEN'
            ? 'A vote is already open. End it before starting another.'
            : code === 'INELIGIBLE'
              ? 'Only shortlisted ideas can go to a vote or be built. Refresh to see the latest state.'
              : code === 'GRANT_LIMIT'
                ? 'You can grant up to 100 moderators. Revoke one first.'
                : code === 'PROPOSAL_LIMIT'
                  ? 'The inbox holds 100 open ideas. Hide some before restoring more.'
                  : code === 'BALLOT_CLOSED'
                    ? 'That vote has already closed.'
                    : 'This audience action is unavailable. Refresh and review the current item.',
  });
}
/** Existing operator-local mutation guard is creator authority. No body can supply chat roles. */
export function registerProposalRoutes(
  app: FastifyInstance,
  deps: {
    proposals: ProposalService;
    authoring: AuthoringService;
    repo: ChannelRepository;
    changed: () => void;
  },
) {
  const { proposals, authoring, repo, changed } = deps;
  app.get('/api/proposals', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const query = z
      .object({
        state: z.enum(['pending', 'shortlisted', 'hidden', 'selected']).optional(),
        offset: z.coerce.number().int().min(0).optional(),
        limit: z.coerce.number().int().min(0).max(50).optional(),
      })
      .strict()
      .safeParse(request.query);
    if (!query.success)
      return reply.code(400).send({ code: 'INVALID', message: 'Invalid audience page.' });
    return {
      ...proposals.snapshot(query.data),
      publicProjection: communityProjection(proposals, repo),
    };
  });
  app.get('/api/proposals/:id/history', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const p = z.object({ id }).safeParse(request.params);
    const query = z
      .object({
        offset: z.coerce.number().int().min(0).optional(),
        limit: z.coerce.number().int().min(0).max(50).optional(),
      })
      .strict()
      .safeParse(request.query);
    if (!p.success || !query.success)
      return reply.code(400).send({ code: 'INVALID', message: 'Invalid history page.' });
    return { history: proposals.history(p.data.id, query.data) };
  });
  function post<T>(
    url: string,
    schema: z.ZodType<T>,
    action: (body: T, parameter: string) => unknown,
  ) {
    app.post(url, async (request, reply) => {
      const p = z.object({ id: id.optional() }).safeParse(request.params);
      const body = schema.safeParse(request.body ?? {});
      if (!p.success || !body.success)
        return reply.code(400).send({ code: 'INVALID', message: 'Invalid audience action.' });
      try {
        const result = action(body.data, p.data.id ?? '');
        changed();
        return result;
      } catch (error) {
        if (error instanceof AuthoringError)
          return reply
            .code(error.code === 'NOT_FOUND' ? 404 : error.code === 'QUEUE_FULL' ? 429 : 409)
            .send({ code: error.code, message: error.message });
        return proposalFailure(reply, error);
      }
    });
  }
  post(
    '/api/proposals/:id/moderate',
    z
      .object({ expectedRevision: revision, action: z.enum(['shortlist', 'hide', 'restore']) })
      .strict(),
    (body, proposalId) => ({ proposal: proposals.moderate(creator, { proposalId, ...body }) }),
  );
  post(
    '/api/proposals/grants',
    z.object({ accountId: z.string().min(1).max(128), enabled: z.boolean() }).strict(),
    (body) => {
      proposals.setGrant(creator, body.accountId, body.enabled);
      return { ok: true };
    },
  );
  post(
    '/api/proposals/ballots',
    z
      .object({
        proposalIds: z.array(z.object({ id, revision }).strict()).min(1).max(5),
        durationSeconds: z.number().int().min(15).max(600),
      })
      .strict(),
    (body) => ({ ballot: proposals.createBallot(creator, body) }),
  );
  post(
    '/api/proposals/ballots/:id/close',
    z.object({ expectedRevision: revision }).strict(),
    (body, ballotId) => ({ ballot: proposals.closeBallot(creator, { ballotId, ...body }) }),
  );
  post(
    '/api/proposals/:id/select',
    z
      .object({
        expectedRevision: revision,
        brief: z.string().min(8).max(500),
        baseVersionId: id.nullable().default(null),
      })
      .strict(),
    (body, proposalId) => {
      if (body.baseVersionId) {
        if (!repo.version(body.baseVersionId)) throw new ProposalError('NOT_FOUND');
        repo.assertVersionLineage(body.baseVersionId);
      }
      return { selection: proposals.select(creator, { proposalId, ...body }) };
    },
  );
  post('/api/proposals/selections/:id/revoke', z.object({}).strict(), (_, selectionId) => ({
    selection: proposals.revokeSelection(creator, selectionId),
  }));
  app.post('/api/proposals/selections/:id/generate', async (request, reply) => {
    const p = z.object({ id }).safeParse(request.params);
    if (
      !p.success ||
      !z
        .object({})
        .strict()
        .safeParse(request.body ?? {}).success
    )
      return reply.code(400).send({ code: 'INVALID', message: 'Invalid generation request.' });
    try {
      const run = authoring.start({ selectionId: p.data.id, intent: '', baseVersionId: null });
      changed();
      return reply.code(202).send(run);
    } catch (error) {
      if (error instanceof AuthoringError)
        return reply
          .code(error.code === 'NOT_FOUND' ? 404 : error.code === 'QUEUE_FULL' ? 429 : 409)
          .send({ code: error.code, message: error.message });
      return proposalFailure(reply, error);
    }
  });
}
