import { randomUUID } from 'node:crypto';
import {
  PREDICTION_LIMITS,
  PREDICTION_SCOPES,
  predictionInputProblem,
  type Prediction,
  type PredictionInput,
} from '@riff/twitch';
import type { DatabaseConnection } from '../../db/client.js';
import { channelPointsRepository } from '../../db/repositories/channel-points.js';
import type { ChannelRepository } from '../../db/repositories/studio.js';
import type { LivePredictionProposal } from '../live/runtime.js';
import {
  consentUrl,
  createEligibility,
  FeatureError,
  requireAccess,
  twitchFailure,
  type FeatureAccess,
} from '../twitch/features.js';

/** Pending automation proposals the console shows at once; extra proposals are dropped. */
export const MAX_PENDING_PROPOSALS = 5;
/** Unopened proposals go stale: the moment they were proposed for has passed. */
export const PROPOSAL_TTL_MS = 10 * 60_000;
export type EndAction = 'lock' | 'resolve' | 'cancel';

/**
 * F22 Predictions. Automations may only propose; the creator opens, locks, resolves and
 * cancels from the console. Settlement needs an explicit confirmed creator request
 * naming the prediction and, to resolve, the winning outcome. No model or guest path
 * reaches `end`.
 */
export function createPredictionsService(deps: {
  database: DatabaseConnection;
  repo: ChannelRepository;
  access: FeatureAccess;
  blocked: () => boolean;
  changed: () => void;
  now?: () => number;
}) {
  const now = deps.now ?? Date.now;
  const store = channelPointsRepository(deps.database, deps.repo.channelId);
  const eligibility = createEligibility(deps.access, now);
  let current: Prediction | null = null;
  let lastError: string | null = null;
  let busy = false;
  const consented = () =>
    PREDICTION_SCOPES.every((scope) => deps.access.api()?.scopes.includes(scope) ?? false);
  const api = () => requireAccess(deps.access, PREDICTION_SCOPES, eligibility.get(), 'predictions');
  const running = () => current?.status === 'ACTIVE' || current?.status === 'LOCKED';

  /** One Twitch mutation at a time per channel, so double clicks cannot open two. */
  async function exclusive<T>(work: () => Promise<T>): Promise<T> {
    if (busy) throw new FeatureError('CONFLICT', 'Another prediction action is in progress.');
    busy = true;
    try {
      return await work();
    } finally {
      busy = false;
    }
  }
  function expire() {
    for (const request of store.requests(PREDICTION_LIMITS.idsPerRequest))
      if (request.status === 'proposed' && now() - request.createdAt > PROPOSAL_TTL_MS)
        store.updateRequest(request.id, {
          status: 'dismissed',
          message: 'Expired before it was opened.',
          updatedAt: now(),
        });
  }
  async function create(input: PredictionInput) {
    const problem = predictionInputProblem(input);
    if (problem) throw new FeatureError('INVALID', problem);
    if (deps.blocked())
      throw new FeatureError('BLOCKED', 'Resume the channel before opening a prediction.');
    await eligibility.refresh();
    const access = api();
    if (running())
      throw new FeatureError(
        'CONFLICT',
        'Twitch runs one prediction at a time. Resolve or cancel the current one first.',
      );
    try {
      current = await access.helix.createPrediction(access.broadcasterId, input);
      lastError = null;
      return current;
    } catch (error) {
      throw twitchFailure(error);
    }
  }

  const service = {
    view() {
      expire();
      return {
        connected: deps.access.api() !== null,
        configured: deps.access.configured,
        consent: { granted: consented(), url: consentUrl('predictions') },
        eligibility: eligibility.get(),
        panicked: deps.blocked(),
        lastError,
        limits: {
          titleLength: PREDICTION_LIMITS.titleLength,
          outcomeLength: PREDICTION_LIMITS.outcomeLength,
          outcomes: PREDICTION_LIMITS.outcomes,
          windowSeconds: PREDICTION_LIMITS.windowSeconds,
        },
        current,
        requests: store.requests(20).map((r) => ({
          id: r.id,
          source: r.source,
          automationId: r.automationId,
          automationTitle: r.automationId
            ? (deps.repo.automation(r.automationId)?.title ?? null)
            : null,
          title: r.title,
          outcomes: r.outcomes,
          windowSeconds: r.windowSeconds,
          status: r.status,
          predictionId: r.predictionId,
          message: r.message,
          createdAt: r.createdAt,
        })),
      };
    },
    async refresh() {
      const access = deps.access.api();
      if (!access) return service.view();
      await eligibility.refresh(true);
      if (!consented() || eligibility.get() === 'ineligible') return service.view();
      try {
        const [latest] = await access.helix.getPredictions(access.broadcasterId, { first: 1 });
        current = latest ?? null;
        lastError = null;
      } catch (error) {
        lastError = twitchFailure(error).message;
      }
      return service.view();
    },
    /** From the live runtime: record a host-validated proposal for creator review. */
    propose(input: LivePredictionProposal) {
      if (deps.blocked()) return false;
      expire();
      const pending = store
        .requests(PREDICTION_LIMITS.idsPerRequest)
        .filter((r) => r.status === 'proposed');
      if (pending.length >= MAX_PENDING_PROPOSALS) return false;
      const problem = predictionInputProblem(input.proposal);
      if (problem) return false;
      const inserted = store.insertRequest({
        id: randomUUID(),
        source: 'automation',
        automationId: input.automationId,
        versionId: input.versionId,
        eventId: input.eventId,
        title: input.proposal.title,
        outcomes: input.proposal.outcomes,
        windowSeconds: input.proposal.windowSeconds,
        status: 'proposed',
        predictionId: null,
        message: '',
        createdAt: now(),
        updatedAt: now(),
      });
      if (inserted) deps.changed();
      return inserted;
    },
    /** Creator opens a new prediction directly from the console. */
    async open(input: PredictionInput) {
      return exclusive(async () => {
        const prediction = await create(input);
        store.insertRequest({
          id: randomUUID(),
          source: 'console',
          automationId: null,
          versionId: null,
          eventId: null,
          title: prediction.title,
          outcomes: prediction.outcomes.map((o) => o.title),
          windowSeconds: prediction.windowSeconds,
          status: 'opened',
          predictionId: prediction.id,
          message: '',
          createdAt: now(),
          updatedAt: now(),
        });
        deps.changed();
        return service.view();
      });
    },
    /** Creator opens an automation's proposal exactly as reviewed. */
    async openProposal(requestId: string) {
      return exclusive(async () => {
        expire();
        const request = store.request(requestId);
        if (!request || request.status !== 'proposed')
          throw new FeatureError('NOT_FOUND', 'That proposal is no longer waiting.');
        try {
          const prediction = await create({
            title: request.title,
            outcomes: request.outcomes,
            windowSeconds: request.windowSeconds,
          });
          store.updateRequest(requestId, {
            status: 'opened',
            predictionId: prediction.id,
            message: '',
            updatedAt: now(),
          });
        } catch (error) {
          const failure = twitchFailure(error);
          if (failure.code !== 'CONFLICT' && failure.code !== 'BLOCKED')
            store.updateRequest(requestId, {
              status: 'failed',
              message: failure.message,
              updatedAt: now(),
            });
          throw failure;
        } finally {
          deps.changed();
        }
        return service.view();
      });
    },
    dismiss(requestId: string) {
      const request = store.request(requestId);
      if (!request || request.status !== 'proposed')
        throw new FeatureError('NOT_FOUND', 'That proposal is no longer waiting.');
      store.updateRequest(requestId, {
        status: 'dismissed',
        message: 'Dismissed by you.',
        updatedAt: now(),
      });
      deps.changed();
      return service.view();
    },
    /**
     * Creator-only settlement. The request must name the exact current prediction and, to
     * resolve, one of its outcome ids; the route also requires `confirm: true`.
     */
    async end(input: { predictionId: string; action: EndAction; winningOutcomeId: string | null }) {
      return exclusive(async () => {
        const access = api();
        if (!current || current.id !== input.predictionId)
          throw new FeatureError('CONFLICT', 'The prediction changed. Refresh and confirm again.');
        if (!running()) throw new FeatureError('CONFLICT', 'This prediction already ended.');
        if (input.action === 'lock' && current.status !== 'ACTIVE')
          throw new FeatureError('CONFLICT', 'Only an open prediction can be locked.');
        if (
          input.action === 'resolve' &&
          !current.outcomes.some((outcome) => outcome.id === input.winningOutcomeId)
        )
          throw new FeatureError(
            'INVALID',
            'Choose one of this prediction’s outcomes as the winner.',
          );
        try {
          current = await access.helix.endPrediction(access.broadcasterId, {
            id: input.predictionId,
            status:
              input.action === 'lock'
                ? 'LOCKED'
                : input.action === 'resolve'
                  ? 'RESOLVED'
                  : 'CANCELED',
            ...(input.action === 'resolve' && input.winningOutcomeId
              ? { winningOutcomeId: input.winningOutcomeId }
              : {}),
          });
          lastError = null;
        } catch (error) {
          throw twitchFailure(error);
        }
        deps.changed();
        return service.view();
      });
    },
    /**
     * Panic locks a running prediction so no more points are wagered; the creator still
     * decides to resolve or cancel. Pending proposals are dismissed.
     */
    async onPanic() {
      try {
        store.dismissProposed(now(), 'Dismissed because Riff was stopped.');
      } catch {
        /* Proposals cannot open while panicked anyway. */
      }
      const access = deps.access.api();
      if (access && consented())
        try {
          // A prediction may have been started outside Riff; read Twitch's truth first.
          current =
            (await access.helix.getPredictions(access.broadcasterId, { first: 1 }))[0] ?? current;
        } catch {
          /* Fall back to the last known prediction. */
        }
      if (access && current?.status === 'ACTIVE') {
        try {
          current = await access.helix.endPrediction(access.broadcasterId, {
            id: current.id,
            status: 'LOCKED',
          });
        } catch (error) {
          lastError = `Could not lock the prediction on stop: ${twitchFailure(error).message}`;
        }
      }
      deps.changed();
    },
  };
  return service;
}
export type PredictionsService = ReturnType<typeof createPredictionsService>;
