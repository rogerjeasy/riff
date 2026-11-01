import {
  CHANNEL_POINTS_LIMITS,
  CHANNEL_POINTS_SCOPES,
  type CustomReward,
  type NormalizedRedemption,
} from '@riff/twitch';
import type { ExecutionDecision, PermissionManifest } from '@riff/sdk';
import type { DatabaseConnection } from '../../db/client.js';
import {
  channelPointsRepository,
  type RedemptionRow,
  type RewardRow,
} from '../../db/repositories/channel-points.js';
import type { ChannelRepository } from '../../db/repositories/studio.js';
import type { LiveRedemption } from '../live/runtime.js';
import {
  consentUrl,
  createEligibility,
  FeatureError,
  requireAccess,
  twitchFailure,
  type FeatureAccess,
} from '../twitch/features.js';

export interface RewardInput {
  title: string;
  cost: number;
  prompt: string;
  inputRequired: boolean;
  cooldownSeconds: number | null;
}
export type RedemptionPolicy = RewardRow['policy'];
export type SettleAction = 'fulfil' | 'refund';

/**
 * F22 Channel Points. Authority and outcomes are separate: generated automations only
 * see admitted redemptions as events; this host service owns reward management,
 * ownership checks and the fulfil/refund decision. Guests can never settle a redemption.
 */
export function createChannelPointsService(deps: {
  database: DatabaseConnection;
  repo: ChannelRepository;
  access: FeatureAccess;
  route: (redemption: LiveRedemption) => Promise<ExecutionDecision | null>;
  blocked: () => boolean;
  changed: () => void;
  subscription: () => 'unrequested' | 'subscribed' | 'failed';
  now?: () => number;
}) {
  const now = deps.now ?? Date.now;
  const store = channelPointsRepository(deps.database, deps.repo.channelId);
  const eligibility = createEligibility(deps.access, now);
  let lastError: string | null = null;

  const consented = () =>
    CHANNEL_POINTS_SCOPES.every((scope) => deps.access.api()?.scopes.includes(scope) ?? false);
  const api = () =>
    requireAccess(deps.access, CHANNEL_POINTS_SCOPES, eligibility.get(), 'channel-points');
  /** Riff manages only rewards it created; anything else is someone else's reward. */
  function owned(rewardId: string): RewardRow {
    const row = store.reward(rewardId);
    if (!row)
      throw new FeatureError(
        'OWNERSHIP',
        'Riff can only manage rewards it created. Edit other rewards in the Twitch dashboard.',
      );
    return row;
  }
  const pointsTrigger = (automationId: string) => {
    const automation = deps.repo.automation(automationId);
    if (!automation) return null;
    const version =
      (automation.activeVersionId && deps.repo.version(automation.activeVersionId)) ||
      deps.repo.versions(automationId)[0];
    const trigger = (version?.manifest as PermissionManifest | undefined)?.trigger;
    return trigger?.kind === 'points.redeem' ? { automation, reward: trigger.reward ?? '' } : null;
  };
  function store_(reward: CustomReward, extra: Partial<RewardRow> = {}): Partial<RewardRow> {
    return {
      title: reward.title,
      cost: reward.cost,
      prompt: reward.prompt,
      inputRequired: reward.isUserInputRequired,
      cooldownSeconds: reward.globalCooldownSeconds,
      enabled: reward.isEnabled,
      paused: reward.isPaused,
      updatedAt: now(),
      ...extra,
    };
  }
  function validInput(input: RewardInput) {
    const title = input.title.trim();
    if (!title || Array.from(title).length > CHANNEL_POINTS_LIMITS.titleLength)
      throw new FeatureError('INVALID', 'Reward titles need 1 to 45 characters.');
    if (store.rewards().some((r) => r.title.toLowerCase() === title.toLowerCase()))
      throw new FeatureError('CONFLICT', 'A Riff reward already uses this title.');
    return title;
  }

  /** Apply the host refund/fulfil policy to a recorded redemption. */
  async function settle(row: RedemptionRow, action: SettleAction, reason: string) {
    const reward = store.reward(row.rewardId);
    const access = deps.access.api();
    if (!reward || !access) {
      store.updateRedemption(row.redemptionId, {
        status: 'failed',
        reason: `${reason} Twitch was unavailable; retry from the queue.`,
        updatedAt: now(),
      });
      return;
    }
    try {
      await access.helix.updateRedemptionStatus(
        access.broadcasterId,
        row.rewardId,
        [row.redemptionId],
        action === 'fulfil' ? 'FULFILLED' : 'CANCELED',
      );
      store.updateRedemption(row.redemptionId, {
        status: action === 'fulfil' ? 'fulfilled' : 'refunded',
        reason,
        updatedAt: now(),
      });
    } catch (error) {
      store.updateRedemption(row.redemptionId, {
        status: 'failed',
        reason: `${reason} ${twitchFailure(error).message}`,
        updatedAt: now(),
      });
    }
  }

  const service = {
    view() {
      const automations = deps.repo
        .automations()
        .map((a) => {
          const points = pointsTrigger(a.id);
          return points
            ? { id: a.id, title: a.title, status: a.status, reward: points.reward }
            : null;
        })
        .filter((a) => a !== null);
      const titles = new Map(deps.repo.automations().map((a) => [a.id, a.title]));
      return {
        connected: deps.access.api() !== null,
        configured: deps.access.configured,
        consent: { granted: consented(), url: consentUrl('channel-points') },
        eligibility: eligibility.get(),
        subscription: deps.subscription(),
        panicked: deps.blocked(),
        lastError,
        limits: {
          titleLength: CHANNEL_POINTS_LIMITS.titleLength,
          promptLength: CHANNEL_POINTS_LIMITS.promptLength,
          rewards: CHANNEL_POINTS_LIMITS.rewardsPerChannel,
        },
        rewards: store.rewards().map((r) => ({
          id: r.rewardId,
          title: r.title,
          cost: r.cost,
          prompt: r.prompt,
          inputRequired: r.inputRequired,
          cooldownSeconds: r.cooldownSeconds,
          enabled: r.enabled,
          paused: r.paused,
          policy: r.policy,
          automationId: r.automationId,
          automationTitle: r.automationId ? (titles.get(r.automationId) ?? null) : null,
        })),
        automations,
        redemptions: store.redemptions(50).map((r) => ({
          id: r.redemptionId,
          rewardId: r.rewardId,
          rewardTitle: store.reward(r.rewardId)?.title ?? 'Removed reward',
          viewerName: r.viewerName,
          input: r.input,
          status: r.status,
          code: r.code,
          reason: r.reason,
          redeemedAt: r.redeemedAt,
          receivedAt: r.receivedAt,
        })),
      };
    },
    /** Re-read eligibility and reconcile Riff rewards with what Twitch lets Riff manage. */
    async refresh() {
      const access = deps.access.api();
      if (!access) return service.view();
      await eligibility.refresh(true);
      if (!consented() || eligibility.get() === 'ineligible') return service.view();
      try {
        const manageable = await access.helix.getCustomRewards(access.broadcasterId, {
          onlyManageable: true,
        });
        const byId = new Map(manageable.map((r) => [r.id, r]));
        for (const row of store.rewards()) {
          const reward = byId.get(row.rewardId);
          if (reward) store.updateReward(row.rewardId, store_(reward));
          // Deleted on Twitch (or by another tool): forget it so it cannot be linked.
          else if (row.broadcasterId === access.broadcasterId) store.deleteReward(row.rewardId);
        }
        lastError = null;
      } catch (error) {
        lastError = twitchFailure(error).message;
      }
      return service.view();
    },
    async createReward(input: RewardInput) {
      if (deps.blocked())
        throw new FeatureError('BLOCKED', 'Resume the channel before adding rewards.');
      await eligibility.refresh();
      const access = api();
      if (store.rewards().length >= CHANNEL_POINTS_LIMITS.rewardsPerChannel)
        throw new FeatureError('CONFLICT', 'Twitch allows at most 50 custom rewards per channel.');
      const title = validInput(input);
      try {
        const reward = await access.helix.createCustomReward(access.broadcasterId, {
          title,
          cost: input.cost,
          prompt: input.prompt,
          isUserInputRequired: input.inputRequired,
          globalCooldownSeconds: input.cooldownSeconds,
        });
        store.insertReward({
          rewardId: reward.id,
          broadcasterId: access.broadcasterId,
          createdAt: now(),
          automationId: null,
          policy: 'auto',
          ...(store_(reward) as Omit<
            RewardRow,
            'channelId' | 'rewardId' | 'broadcasterId' | 'createdAt' | 'automationId' | 'policy'
          >),
        });
      } catch (error) {
        throw twitchFailure(error);
      }
      deps.changed();
      return service.view();
    },
    async updateReward(
      rewardId: string,
      patch: { [K in keyof RewardInput]?: RewardInput[K] | undefined } & {
        paused?: boolean | undefined;
        enabled?: boolean | undefined;
      },
    ) {
      owned(rewardId);
      await eligibility.refresh();
      const access = api();
      if (patch.paused === false && deps.blocked())
        throw new FeatureError('BLOCKED', 'Resume the channel before un-pausing rewards.');
      if (patch.title !== undefined) {
        const title = patch.title.trim();
        if (
          store
            .rewards()
            .some((r) => r.rewardId !== rewardId && r.title.toLowerCase() === title.toLowerCase())
        )
          throw new FeatureError('CONFLICT', 'A Riff reward already uses this title.');
      }
      try {
        const reward = await access.helix.updateCustomReward(access.broadcasterId, rewardId, {
          ...(patch.title !== undefined ? { title: patch.title.trim() } : {}),
          ...(patch.cost !== undefined ? { cost: patch.cost } : {}),
          ...(patch.prompt !== undefined ? { prompt: patch.prompt } : {}),
          ...(patch.inputRequired !== undefined
            ? { isUserInputRequired: patch.inputRequired }
            : {}),
          ...(patch.cooldownSeconds !== undefined
            ? { globalCooldownSeconds: patch.cooldownSeconds }
            : {}),
          ...(patch.paused !== undefined ? { isPaused: patch.paused } : {}),
          ...(patch.enabled !== undefined ? { isEnabled: patch.enabled } : {}),
        });
        store.updateReward(rewardId, store_(reward));
      } catch (error) {
        throw twitchFailure(error);
      }
      deps.changed();
      return service.view();
    },
    async deleteReward(rewardId: string) {
      owned(rewardId);
      const access = api();
      try {
        await access.helix.deleteCustomReward(access.broadcasterId, rewardId);
      } catch (error) {
        const failure = twitchFailure(error);
        // Already gone on Twitch: forget the local record too.
        if (failure.code !== 'CONFLICT' || !/not found/i.test(failure.message)) throw failure;
      }
      store.deleteReward(rewardId);
      deps.changed();
      return service.view();
    },
    /** Host-owned link; the automation must use a points.redeem trigger. */
    link(rewardId: string, automationId: string | null, policy: RedemptionPolicy) {
      owned(rewardId);
      if (automationId) {
        const points = pointsTrigger(automationId);
        if (!points)
          throw new FeatureError(
            'INVALID',
            'Link a reward only to an interaction made for Channel Points redemptions.',
          );
      }
      store.link(rewardId, automationId, policy, now());
      deps.changed();
      return service.view();
    },
    /** EventSub redemption: dedupe, route through admission, then fulfil or refund. */
    async handleRedemption(redemption: NormalizedRedemption) {
      const access = deps.access.api();
      if (!access || redemption.channelId !== access.broadcasterId) return null;
      // Rewards Riff did not create cannot be updated by Riff; leave them to their owner.
      const reward = store.reward(redemption.rewardId);
      if (!reward) return null;
      const row: Omit<RedemptionRow, 'channelId'> = {
        redemptionId: redemption.id,
        rewardId: redemption.rewardId,
        automationId: reward.automationId,
        viewerId: redemption.viewerId,
        viewerName: redemption.viewerName,
        input: redemption.text,
        redeemedAt: redemption.redeemedAt,
        receivedAt: redemption.at,
        status: 'queued',
        code: null,
        reason: '',
        updatedAt: now(),
      };
      if (!store.claimRedemption(row)) return 'duplicate' as const;
      deps.changed();
      // Twitch only lets UNFULFILLED redemptions change status.
      if (redemption.status !== 'unfulfilled') {
        store.updateRedemption(row.redemptionId, {
          status: redemption.status === 'canceled' ? 'refunded' : 'fulfilled',
          reason: 'Twitch already settled this redemption.',
          updatedAt: now(),
        });
        deps.changed();
        return 'settled' as const;
      }
      let decision: ExecutionDecision | null = null;
      if (!deps.blocked() && reward.automationId && !reward.paused)
        decision = await deps.route({
          id: redemption.id,
          channelId: redemption.channelId,
          viewerId: redemption.viewerId,
          viewerName: redemption.viewerName,
          text: redemption.text,
          automationId: reward.automationId,
        });
      const stored = store.redemption(row.redemptionId);
      if (!stored) return null;
      if (!decision) {
        await settle(
          stored,
          'refund',
          deps.blocked()
            ? 'Riff is stopped, so the points were refunded.'
            : reward.automationId
              ? 'The linked interaction is not live, so the points were refunded.'
              : 'No interaction is linked to this reward, so the points were refunded.',
        );
      } else if (decision.code === 'DUPLICATE') {
        store.updateRedemption(row.redemptionId, { code: decision.code, updatedAt: now() });
      } else if (decision.code === 'ACCEPTED') {
        store.updateRedemption(row.redemptionId, { code: decision.code, updatedAt: now() });
        if (reward.policy === 'auto')
          await settle(stored, 'fulfil', 'Accepted and shown; fulfilled automatically.');
        else
          store.updateRedemption(row.redemptionId, {
            reason: 'Accepted and shown. Waiting for you to fulfil or refund.',
            updatedAt: now(),
          });
      } else {
        store.updateRedemption(row.redemptionId, { code: decision.code, updatedAt: now() });
        await settle(stored, 'refund', `${decision.reason} The points were refunded.`);
      }
      deps.changed();
      return decision?.code ?? 'refunded';
    },
    /** Explicit creator settlement from the redemption queue. */
    async settle(redemptionId: string, action: SettleAction) {
      const row = store.redemption(redemptionId);
      if (!row) throw new FeatureError('NOT_FOUND', 'That redemption is no longer in the queue.');
      if (row.status !== 'queued' && row.status !== 'failed')
        throw new FeatureError('CONFLICT', 'This redemption was already settled.');
      owned(row.rewardId);
      api();
      await settle(row, action, action === 'fulfil' ? 'Fulfilled by you.' : 'Refunded by you.');
      deps.changed();
      const after = store.redemption(redemptionId);
      if (after?.status === 'failed') throw new FeatureError('TWITCH', after.reason);
      return service.view();
    },
    /** Panic: stop spending first (pause rewards), then refund anything still waiting. */
    async onPanic() {
      const access = deps.access.api();
      if (!access) return;
      for (const reward of store.rewards()) {
        if (reward.paused) continue;
        try {
          const updated = await access.helix.updateCustomReward(
            access.broadcasterId,
            reward.rewardId,
            {
              isPaused: true,
            },
          );
          store.updateReward(reward.rewardId, store_(updated));
        } catch {
          /* Best effort; redemptions during panic are refunded anyway. */
        }
      }
      for (const row of store.queued())
        await settle(row, 'refund', 'Riff was stopped, so the points were refunded.');
      deps.changed();
    },
  };
  return service;
}
export type ChannelPointsService = ReturnType<typeof createChannelPointsService>;
