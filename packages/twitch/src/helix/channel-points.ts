import { z } from 'zod';
import { TwitchError } from '../errors.js';
import { CHANNEL_POINTS_LIMITS } from './limits.js';
import { invalidRequest, parseResponse, query, type HelixRequest } from './request.js';

/**
 * Channel Points custom rewards and redemptions.
 * Docs: https://dev.twitch.tv/docs/api/reference/#create-custom-rewards and following.
 * Docs: "The app used to create the reward is the only app that may update the reward"
 * (also delete, get redemptions and update redemption status). All endpoints answer
 * 403 when "The broadcaster is not a partner or affiliate."
 */
export interface CustomRewardInput {
  readonly title: string;
  readonly cost: number;
  readonly prompt?: string;
  readonly isEnabled?: boolean;
  readonly backgroundColor?: string;
  readonly isUserInputRequired?: boolean;
  /** null disables the limit. */
  readonly maxPerStream?: number | null;
  readonly maxPerUserPerStream?: number | null;
  readonly globalCooldownSeconds?: number | null;
}
export interface CustomRewardUpdate extends Partial<CustomRewardInput> {
  readonly isPaused?: boolean;
}
export interface CustomReward {
  readonly id: string;
  readonly broadcasterId: string;
  readonly title: string;
  readonly prompt: string;
  readonly cost: number;
  readonly backgroundColor: string;
  readonly isEnabled: boolean;
  readonly isPaused: boolean;
  readonly isInStock: boolean;
  readonly isUserInputRequired: boolean;
  readonly maxPerStream: number | null;
  readonly maxPerUserPerStream: number | null;
  readonly globalCooldownSeconds: number | null;
  /** True when Twitch auto-fulfils redemptions, which makes refunds impossible. */
  readonly skipsQueue: boolean;
  readonly cooldownExpiresAt: string | null;
}
export type RedemptionStatus = 'UNFULFILLED' | 'FULFILLED' | 'CANCELED';
export interface CustomRewardRedemption {
  readonly id: string;
  readonly broadcasterId: string;
  readonly viewerId: string;
  readonly viewerLogin: string | null;
  readonly viewerName: string;
  readonly userInput: string;
  readonly status: RedemptionStatus;
  readonly redeemedAt: string;
  readonly rewardId: string;
  readonly rewardTitle: string;
  readonly rewardCost: number;
}
export interface ChannelPointsApi {
  createCustomReward(broadcasterId: string, input: CustomRewardInput): Promise<CustomReward>;
  getCustomRewards(
    broadcasterId: string,
    options?: { ids?: readonly string[]; onlyManageable?: boolean },
  ): Promise<readonly CustomReward[]>;
  updateCustomReward(
    broadcasterId: string,
    rewardId: string,
    update: CustomRewardUpdate,
  ): Promise<CustomReward>;
  deleteCustomReward(broadcasterId: string, rewardId: string): Promise<void>;
  getRedemptions(
    broadcasterId: string,
    rewardId: string,
    options: { status: RedemptionStatus; ids?: readonly string[]; first?: number; after?: string },
  ): Promise<{ redemptions: readonly CustomRewardRedemption[]; cursor: string | null }>;
  updateRedemptionStatus(
    broadcasterId: string,
    rewardId: string,
    redemptionIds: readonly string[],
    status: Exclude<RedemptionStatus, 'UNFULFILLED'>,
  ): Promise<readonly CustomRewardRedemption[]>;
}

// Response body per Create Custom Rewards; the Get Custom Reward example omits
// broadcaster_login, so it is not required.
const rewardSchema = z.looseObject({
  broadcaster_id: z.string().min(1),
  id: z.string().min(1),
  title: z.string(),
  prompt: z.string(),
  cost: z.number().int(),
  background_color: z.string(),
  is_enabled: z.boolean(),
  is_user_input_required: z.boolean(),
  max_per_stream_setting: z.looseObject({ is_enabled: z.boolean(), max_per_stream: z.number() }),
  max_per_user_per_stream_setting: z.looseObject({
    is_enabled: z.boolean(),
    max_per_user_per_stream: z.number(),
  }),
  global_cooldown_setting: z.looseObject({
    is_enabled: z.boolean(),
    global_cooldown_seconds: z.number(),
  }),
  is_paused: z.boolean(),
  is_in_stock: z.boolean(),
  should_redemptions_skip_request_queue: z.boolean(),
  cooldown_expires_at: z.string().nullable(),
});
const rewardsResponse = z.looseObject({ data: z.array(rewardSchema) });
// Get Custom Reward Redemption / Update Redemption Status; one documented example omits user_login.
const redemptionSchema = z.looseObject({
  broadcaster_id: z.string().min(1),
  id: z.string().min(1),
  user_id: z.string().min(1),
  user_login: z.string().optional(),
  user_name: z.string(),
  user_input: z.string(),
  status: z.enum(['UNFULFILLED', 'FULFILLED', 'CANCELED']),
  redeemed_at: z.string(),
  reward: z.looseObject({ id: z.string().min(1), title: z.string(), cost: z.number().int() }),
});
const redemptionsResponse = z.looseObject({
  data: z.array(redemptionSchema),
  pagination: z.looseObject({ cursor: z.string().optional() }).optional(),
});

function toReward(raw: z.infer<typeof rewardSchema>): CustomReward {
  const max = raw.max_per_stream_setting;
  const perUser = raw.max_per_user_per_stream_setting;
  const cooldown = raw.global_cooldown_setting;
  return {
    id: raw.id,
    broadcasterId: raw.broadcaster_id,
    title: raw.title,
    prompt: raw.prompt,
    cost: raw.cost,
    backgroundColor: raw.background_color,
    isEnabled: raw.is_enabled,
    isPaused: raw.is_paused,
    isInStock: raw.is_in_stock,
    isUserInputRequired: raw.is_user_input_required,
    maxPerStream: max.is_enabled ? max.max_per_stream : null,
    maxPerUserPerStream: perUser.is_enabled ? perUser.max_per_user_per_stream : null,
    globalCooldownSeconds: cooldown.is_enabled ? cooldown.global_cooldown_seconds : null,
    skipsQueue: raw.should_redemptions_skip_request_queue,
    cooldownExpiresAt: raw.cooldown_expires_at,
  };
}
function toRedemption(raw: z.infer<typeof redemptionSchema>): CustomRewardRedemption {
  return {
    id: raw.id,
    broadcasterId: raw.broadcaster_id,
    viewerId: raw.user_id,
    viewerLogin: raw.user_login ?? null,
    viewerName: raw.user_name,
    userInput: raw.user_input,
    status: raw.status,
    redeemedAt: raw.redeemed_at,
    rewardId: raw.reward.id,
    rewardTitle: raw.reward.title,
    rewardCost: raw.reward.cost,
  };
}

const positiveInt = (value: number) => Number.isSafeInteger(value) && value >= 1;
/** Translate camelCase input into the documented body, refusing documented 400s locally. */
function rewardBody(input: CustomRewardUpdate, endpoint: string): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (input.title !== undefined) {
    const length = Array.from(input.title.trim()).length;
    if (length < 1 || length > CHANNEL_POINTS_LIMITS.titleLength)
      throw invalidRequest('Reward titles need 1 to 45 characters.', endpoint);
    body['title'] = input.title.trim();
  }
  if (input.cost !== undefined) {
    if (!positiveInt(input.cost))
      throw invalidRequest('Reward cost must be at least 1 Channel Point.', endpoint);
    body['cost'] = input.cost;
  }
  if (input.prompt !== undefined) {
    if (Array.from(input.prompt).length > CHANNEL_POINTS_LIMITS.promptLength)
      throw invalidRequest('Reward prompts are limited to 200 characters.', endpoint);
    body['prompt'] = input.prompt;
  }
  if (input.isEnabled !== undefined) body['is_enabled'] = input.isEnabled;
  if (input.backgroundColor !== undefined) {
    if (!/^#[0-9a-fA-F]{6}$/.test(input.backgroundColor))
      throw invalidRequest('Use a hex colour such as #9147FF.', endpoint);
    body['background_color'] = input.backgroundColor;
  }
  if (input.isUserInputRequired !== undefined)
    body['is_user_input_required'] = input.isUserInputRequired;
  const limit = (
    value: number | null | undefined,
    flag: string,
    field: string,
    max = Number.MAX_SAFE_INTEGER,
  ) => {
    if (value === undefined) return;
    if (value !== null && (!positiveInt(value) || value > max))
      throw invalidRequest('Reward limits must be whole numbers of at least 1.', endpoint);
    body[flag] = value !== null;
    if (value !== null) body[field] = value;
  };
  limit(input.maxPerStream, 'is_max_per_stream_enabled', 'max_per_stream');
  limit(
    input.maxPerUserPerStream,
    'is_max_per_user_per_stream_enabled',
    'max_per_user_per_stream',
  );
  limit(
    input.globalCooldownSeconds,
    'is_global_cooldown_enabled',
    'global_cooldown_seconds',
    CHANNEL_POINTS_LIMITS.maxCooldownSeconds,
  );
  if (input.isPaused !== undefined) body['is_paused'] = input.isPaused;
  return body;
}

/** Rewrite a 403 so the creator learns which documented constraint applies. */
async function explained<T>(work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (error) {
    if (error instanceof TwitchError && error.code === 'TWITCH_FORBIDDEN')
      throw new TwitchError(
        'TWITCH_FORBIDDEN',
        'Twitch refused: only rewards created by Riff can be managed by Riff, and Channel Points need an Affiliate or Partner channel. Reconnect Twitch if the Channel Points permission was not approved.',
        error.detail,
      );
    throw error;
  }
}

export function createChannelPointsApi(request: HelixRequest): ChannelPointsApi {
  const base = '/channel_points/custom_rewards';
  return {
    async createCustomReward(broadcasterId, input) {
      const endpoint = 'POST /channel_points/custom_rewards';
      if (input.title === undefined || input.cost === undefined)
        throw invalidRequest('A reward needs a title and a cost.', endpoint);
      // Riff never lets Twitch auto-fulfil: refunds on rejection need the request queue.
      const body = { ...rewardBody(input, endpoint), should_redemptions_skip_request_queue: false };
      const payload = await explained(
        request('POST', `${base}${query([['broadcaster_id', broadcasterId]])}`, endpoint, body, {
          retryServerErrors: false,
        }),
      );
      const [reward] = parseResponse(rewardsResponse, payload, endpoint).data;
      if (!reward)
        throw new TwitchError('TWITCH_INVALID_RESPONSE', 'Twitch returned an unexpected response.', {
          endpoint,
        });
      return toReward(reward);
    },
    async getCustomRewards(broadcasterId, options = {}) {
      const endpoint = 'GET /channel_points/custom_rewards';
      const ids = options.ids ?? [];
      if (ids.length > CHANNEL_POINTS_LIMITS.rewardsPerChannel)
        throw invalidRequest('Too many rewards requested at once.', endpoint);
      const path = `${base}${query([
        ['broadcaster_id', broadcasterId],
        ...ids.map((id) => ['id', id] as const),
        ['only_manageable_rewards', options.onlyManageable ? 'true' : undefined],
      ])}`;
      const payload = await explained(request('GET', path, endpoint));
      return parseResponse(rewardsResponse, payload, endpoint).data.map(toReward);
    },
    async updateCustomReward(broadcasterId, rewardId, update) {
      const endpoint = 'PATCH /channel_points/custom_rewards';
      const body = rewardBody(update, endpoint);
      if (!Object.keys(body).length) throw invalidRequest('Nothing to update.', endpoint);
      const path = `${base}${query([
        ['broadcaster_id', broadcasterId],
        ['id', rewardId],
      ])}`;
      const payload = await explained(request('PATCH', path, endpoint, body));
      const [reward] = parseResponse(rewardsResponse, payload, endpoint).data;
      if (!reward)
        throw new TwitchError('TWITCH_INVALID_RESPONSE', 'Twitch returned an unexpected response.', {
          endpoint,
        });
      return toReward(reward);
    },
    async deleteCustomReward(broadcasterId, rewardId) {
      const endpoint = 'DELETE /channel_points/custom_rewards';
      const path = `${base}${query([
        ['broadcaster_id', broadcasterId],
        ['id', rewardId],
      ])}`;
      await explained(request('DELETE', path, endpoint));
    },
    async getRedemptions(broadcasterId, rewardId, options) {
      const endpoint = 'GET /channel_points/custom_rewards/redemptions';
      const first = options.first;
      if (first !== undefined && (!positiveInt(first) || first > CHANNEL_POINTS_LIMITS.pageSize))
        throw invalidRequest('Redemption pages hold 1 to 50 entries.', endpoint);
      const path = `${base}/redemptions${query([
        ['broadcaster_id', broadcasterId],
        ['reward_id', rewardId],
        ['status', options.status],
        ...(options.ids ?? []).map((id) => ['id', id] as const),
        ['first', first === undefined ? undefined : String(first)],
        ['after', options.after],
      ])}`;
      const payload = await explained(request('GET', path, endpoint));
      const parsed = parseResponse(redemptionsResponse, payload, endpoint);
      return {
        redemptions: parsed.data.map(toRedemption),
        cursor: parsed.pagination?.cursor ?? null,
      };
    },
    async updateRedemptionStatus(broadcasterId, rewardId, redemptionIds, status) {
      const endpoint = 'PATCH /channel_points/custom_rewards/redemptions';
      if (
        redemptionIds.length < 1 ||
        redemptionIds.length > CHANNEL_POINTS_LIMITS.redemptionIdsPerUpdate
      )
        throw invalidRequest('Update 1 to 50 redemptions at a time.', endpoint);
      const path = `${base}/redemptions${query([
        ['broadcaster_id', broadcasterId],
        ['reward_id', rewardId],
        ...redemptionIds.map((id) => ['id', id] as const),
      ])}`;
      // Idempotent by Twitch's rules: only UNFULFILLED redemptions change (else 404).
      const payload = await explained(request('PATCH', path, endpoint, { status }));
      return parseResponse(redemptionsResponse, payload, endpoint).data.map(toRedemption);
    },
  };
}
