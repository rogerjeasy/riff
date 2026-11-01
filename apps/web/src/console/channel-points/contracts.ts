import { z } from 'zod';

/** Browser-side validation of the F22 console projections (server: services/channel-points, services/predictions). */
const eligibility = z.enum(['affiliate', 'partner', 'ineligible', 'unknown']);
const consent = z.object({ granted: z.boolean(), url: z.string().startsWith('/auth/twitch') });
const common = {
  connected: z.boolean(),
  configured: z.boolean(),
  consent,
  eligibility,
  panicked: z.boolean(),
  lastError: z.string().max(400).nullable(),
};

export const rewardSchema = z.object({
  id: z.string(),
  title: z.string().max(45),
  cost: z.number().int(),
  prompt: z.string().max(200),
  inputRequired: z.boolean(),
  cooldownSeconds: z.number().int().nullable(),
  enabled: z.boolean(),
  paused: z.boolean(),
  policy: z.enum(['auto', 'manual']),
  automationId: z.string().nullable(),
  automationTitle: z.string().nullable(),
});
export const redemptionSchema = z.object({
  id: z.string(),
  rewardId: z.string(),
  rewardTitle: z.string(),
  viewerName: z.string(),
  input: z.string().max(500),
  status: z.enum(['queued', 'fulfilled', 'refunded', 'failed']),
  code: z.string().nullable(),
  reason: z.string(),
  redeemedAt: z.string(),
  receivedAt: z.number(),
});
export const channelPointsSchema = z.object({
  ...common,
  subscription: z.enum(['unrequested', 'subscribed', 'failed']),
  limits: z.object({ titleLength: z.number(), promptLength: z.number(), rewards: z.number() }),
  rewards: z.array(rewardSchema).max(50),
  automations: z
    .array(z.object({ id: z.string(), title: z.string(), status: z.string(), reward: z.string() }))
    .max(200),
  redemptions: z.array(redemptionSchema).max(50),
});
export type ChannelPointsState = z.infer<typeof channelPointsSchema>;
export type Reward = z.infer<typeof rewardSchema>;
export type Redemption = z.infer<typeof redemptionSchema>;

const outcomeSchema = z.object({
  id: z.string(),
  title: z.string(),
  users: z.number(),
  channelPoints: z.number(),
  color: z.string(),
});
export const predictionSchema = z.object({
  id: z.string(),
  title: z.string(),
  winningOutcomeId: z.string().nullable(),
  outcomes: z.array(outcomeSchema).max(10),
  windowSeconds: z.number(),
  status: z.enum(['ACTIVE', 'LOCKED', 'RESOLVED', 'CANCELED']),
  createdAt: z.string(),
  endedAt: z.string().nullable(),
  lockedAt: z.string().nullable(),
});
export const predictionRequestSchema = z.object({
  id: z.string(),
  source: z.enum(['automation', 'console']),
  automationId: z.string().nullable(),
  automationTitle: z.string().nullable(),
  title: z.string(),
  outcomes: z.array(z.string()).max(10),
  windowSeconds: z.number(),
  status: z.enum(['proposed', 'dismissed', 'opened', 'failed']),
  predictionId: z.string().nullable(),
  message: z.string(),
  createdAt: z.number(),
});
export const predictionsSchema = z.object({
  ...common,
  limits: z.object({
    titleLength: z.number(),
    outcomeLength: z.number(),
    outcomes: z.object({ min: z.number(), max: z.number() }),
    windowSeconds: z.object({ min: z.number(), max: z.number() }),
  }),
  current: predictionSchema.nullable(),
  requests: z.array(predictionRequestSchema).max(50),
});
export type PredictionsState = z.infer<typeof predictionsSchema>;
export type Prediction = z.infer<typeof predictionSchema>;
export type PredictionRequest = z.infer<typeof predictionRequestSchema>;

/** Plain-language access state shared by both panels. */
export function accessProblem(
  state: Pick<ChannelPointsState, 'configured' | 'connected' | 'consent' | 'eligibility'>,
  feature: string,
): { text: string; action: 'connect' | 'consent' | null } | null {
  if (!state.configured)
    return {
      text: 'Twitch is not configured on this Riff server, so nothing can be created.',
      action: null,
    };
  if (!state.connected) return { text: `Connect Twitch to use ${feature}.`, action: 'connect' };
  if (!state.consent.granted)
    return { text: `Riff needs your permission to manage ${feature}.`, action: 'consent' };
  if (state.eligibility === 'ineligible')
    return {
      text: 'Twitch offers Channel Points and Predictions only to Affiliate and Partner channels.',
      action: null,
    };
  return null;
}
