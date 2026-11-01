import { z } from 'zod';
import { TwitchError } from '../errors.js';
import { PREDICTION_LIMITS } from './limits.js';
import { invalidRequest, parseResponse, query, type HelixRequest } from './request.js';

/**
 * Channel Points Predictions. Docs: https://dev.twitch.tv/docs/api/reference/#create-prediction
 * "The broadcaster may run only one prediction at a time." Active predictions may move to
 * LOCKED, RESOLVED or CANCELED; locked ones to RESOLVED or CANCELED.
 */
export type PredictionStatus = 'ACTIVE' | 'LOCKED' | 'RESOLVED' | 'CANCELED';
export interface PredictionInput {
  readonly title: string;
  readonly outcomes: readonly string[];
  readonly windowSeconds: number;
}
export interface PredictionOutcome {
  readonly id: string;
  readonly title: string;
  readonly users: number;
  readonly channelPoints: number;
  readonly color: string;
}
export interface Prediction {
  readonly id: string;
  readonly broadcasterId: string;
  readonly title: string;
  readonly winningOutcomeId: string | null;
  readonly outcomes: readonly PredictionOutcome[];
  readonly windowSeconds: number;
  readonly status: PredictionStatus;
  readonly createdAt: string;
  readonly endedAt: string | null;
  readonly lockedAt: string | null;
}
export interface EndPredictionInput {
  readonly id: string;
  readonly status: Exclude<PredictionStatus, 'ACTIVE'>;
  /** Required for RESOLVED and ignored otherwise. */
  readonly winningOutcomeId?: string;
}
export interface PredictionsApi {
  createPrediction(broadcasterId: string, input: PredictionInput): Promise<Prediction>;
  getPredictions(
    broadcasterId: string,
    options?: { ids?: readonly string[]; first?: number },
  ): Promise<readonly Prediction[]>;
  endPrediction(broadcasterId: string, input: EndPredictionInput): Promise<Prediction>;
}

const predictionSchema = z.looseObject({
  id: z.string().min(1),
  broadcaster_id: z.string().min(1),
  title: z.string(),
  winning_outcome_id: z.string().nullable(),
  outcomes: z.array(
    z.looseObject({
      id: z.string().min(1),
      title: z.string(),
      users: z.number().int(),
      channel_points: z.number().int(),
      color: z.string(),
    }),
  ),
  prediction_window: z.number().int(),
  status: z.enum(['ACTIVE', 'LOCKED', 'RESOLVED', 'CANCELED']),
  created_at: z.string(),
  ended_at: z.string().nullable(),
  locked_at: z.string().nullable(),
});
const predictionsResponse = z.looseObject({ data: z.array(predictionSchema) });

function toPrediction(raw: z.infer<typeof predictionSchema>): Prediction {
  return {
    id: raw.id,
    broadcasterId: raw.broadcaster_id,
    title: raw.title,
    winningOutcomeId: raw.winning_outcome_id,
    outcomes: raw.outcomes.map((o) => ({
      id: o.id,
      title: o.title,
      users: o.users,
      channelPoints: o.channel_points,
      color: o.color,
    })),
    windowSeconds: raw.prediction_window,
    status: raw.status,
    createdAt: raw.created_at,
    endedAt: raw.ended_at,
    lockedAt: raw.locked_at,
  };
}
const length = (value: string) => Array.from(value).length;

/** Documented bounds as a reusable predicate; hosts validate guest proposals with it too. */
export function predictionInputProblem(input: PredictionInput): string | null {
  const title = input.title.trim();
  if (length(title) < 1 || length(title) > PREDICTION_LIMITS.titleLength)
    return 'Prediction titles need 1 to 45 characters.';
  const { min, max } = PREDICTION_LIMITS.outcomes;
  if (input.outcomes.length < min || input.outcomes.length > max)
    return 'Predictions need 2 to 10 outcomes.';
  const seen = new Set<string>();
  for (const outcome of input.outcomes) {
    const text = outcome.trim();
    if (length(text) < 1 || length(text) > PREDICTION_LIMITS.outcomeLength)
      return 'Each outcome needs 1 to 25 characters.';
    if (seen.has(text.toLowerCase())) return 'Outcomes must be different from each other.';
    seen.add(text.toLowerCase());
  }
  const window = PREDICTION_LIMITS.windowSeconds;
  if (
    !Number.isSafeInteger(input.windowSeconds) ||
    input.windowSeconds < window.min ||
    input.windowSeconds > window.max
  )
    return 'The prediction window must be 30 to 1800 seconds.';
  return null;
}

function single(payload: unknown, endpoint: string): Prediction {
  const [prediction] = parseResponse(predictionsResponse, payload, endpoint).data;
  if (!prediction)
    throw new TwitchError('TWITCH_INVALID_RESPONSE', 'Twitch returned an unexpected response.', {
      endpoint,
    });
  return toPrediction(prediction);
}

export function createPredictionsApi(request: HelixRequest): PredictionsApi {
  return {
    async createPrediction(broadcasterId, input) {
      const endpoint = 'POST /predictions';
      const problem = predictionInputProblem(input);
      if (problem) throw invalidRequest(problem, endpoint);
      const payload = await request(
        'POST',
        '/predictions',
        endpoint,
        {
          broadcaster_id: broadcasterId,
          title: input.title.trim(),
          outcomes: input.outcomes.map((title) => ({ title: title.trim() })),
          prediction_window: input.windowSeconds,
        },
        // A server error may follow a created prediction; never open a second one blindly.
        { retryServerErrors: false },
      );
      return single(payload, endpoint);
    },
    async getPredictions(broadcasterId, options = {}) {
      const endpoint = 'GET /predictions';
      const ids = options.ids ?? [];
      const first = options.first;
      if (
        ids.length > PREDICTION_LIMITS.idsPerRequest ||
        (first !== undefined &&
          (!Number.isSafeInteger(first) || first < 1 || first > PREDICTION_LIMITS.idsPerRequest))
      )
        throw invalidRequest('Request at most 25 predictions at once.', endpoint);
      const path = `/predictions${query([
        ['broadcaster_id', broadcasterId],
        ...ids.map((id) => ['id', id] as const),
        ['first', first === undefined ? undefined : String(first)],
      ])}`;
      const payload = await request('GET', path, endpoint);
      return parseResponse(predictionsResponse, payload, endpoint).data.map(toPrediction);
    },
    async endPrediction(broadcasterId, input) {
      const endpoint = 'PATCH /predictions';
      if (input.status === 'RESOLVED' && !input.winningOutcomeId)
        throw invalidRequest('Choose the winning outcome to resolve a prediction.', endpoint);
      const payload = await request('PATCH', '/predictions', endpoint, {
        broadcaster_id: broadcasterId,
        id: input.id,
        status: input.status,
        ...(input.status === 'RESOLVED' ? { winning_outcome_id: input.winningOutcomeId } : {}),
      });
      return single(payload, endpoint);
    },
  };
}
