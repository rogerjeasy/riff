import { describe, expect, it } from 'vitest';
import { TwitchError } from '../src/errors.js';
import { createHelixClient } from '../src/helix.js';
import { CHANNEL_POINTS_LIMITS, PREDICTION_LIMITS } from '../src/helix/limits.js';
import { normalizeRedemption } from '../src/normalize.js';
import { TRIGGERS, triggerForSubscription } from '../src/triggers.js';
import { fixture } from './support.js';

const TOKEN = 'user-token-should-never-leak';
interface Call {
  url: string;
  method: string | undefined;
  body: unknown;
}
const json = (body: unknown, status = 200) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
function setup(responses: Response[]) {
  const calls: Call[] = [];
  const queue = [...responses];
  const client = createHelixClient({
    clientId: 'fake-client-id',
    getAccessToken: () => TOKEN,
    fetch: async (url, init) => {
      calls.push({
        url,
        method: init?.method,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      });
      const next = queue.shift();
      if (!next) throw new Error('unexpected request');
      return next;
    },
    sleep: async () => undefined,
    random: () => 0,
    now: () => 1_000_000_000,
  });
  return { client, calls };
}
async function rejection(promise: Promise<unknown>): Promise<TwitchError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof TwitchError) return error;
    throw error;
  }
  throw new Error('expected a TwitchError');
}
const BROADCASTER = '274637212';
const REWARD = '92af127c-7326-4483-a52b-b0da0be61c01';

describe('points.redeem trigger', () => {
  it('maps to the documented redemption subscription with a sourced fixture', () => {
    const trigger = TRIGGERS['points.redeem'];
    const payload = fixture(trigger.fixture);
    const subscription = payload['subscription'] as Record<string, unknown>;
    expect(subscription['type']).toBe('channel.channel_points_custom_reward_redemption.add');
    expect(subscription['version']).toBe(trigger.version);
    expect(trigger.scopes).toEqual(['channel:manage:redemptions']);
    expect(triggerForSubscription(trigger.type, '1')).toBe('points.redeem');
  });

  it('normalizes the documented event, sanitizing viewer input', () => {
    const event = structuredClone(fixture(TRIGGERS['points.redeem'].fixture)['event']) as Record<
      string,
      unknown
    >;
    expect(normalizeRedemption(event, { messageId: 'm-1', receivedAt: 1000 })).toEqual({
      id: '17fa2df1-ad76-4804-bfa5-a40ef63efe63',
      deliveryId: 'm-1',
      channelId: '1337',
      viewerId: '9001',
      viewerLogin: 'cooler_user',
      viewerName: 'Cooler_User',
      rewardId: REWARD,
      rewardTitle: 'title',
      rewardCost: 100,
      text: 'pogchamp',
      status: 'unfulfilled',
      redeemedAt: '2020-07-15T17:16:03.17106713Z',
      at: 1000,
    });
    event['user_input'] = `a\u0007b${'x'.repeat(600)}`;
    expect(normalizeRedemption(event, { messageId: 'm', receivedAt: 1 })?.text).toHaveLength(500);
    expect(normalizeRedemption({ ...event, reward: null }, { messageId: 'm', receivedAt: 1 })).toBe(
      null,
    );
  });
});

describe('Channel Points Helix endpoints', () => {
  it('creates a reward that always keeps the request queue so refunds stay possible', async () => {
    const { client, calls } = setup([json(fixture('helix.create-custom-rewards.json'))]);
    const reward = await client.createCustomReward(BROADCASTER, {
      title: 'Hydrate',
      cost: 500,
      prompt: 'Remind me to drink water',
      globalCooldownSeconds: 60,
    });
    expect(calls[0]).toEqual({
      url: `https://api.twitch.tv/helix/channel_points/custom_rewards?broadcaster_id=${BROADCASTER}`,
      method: 'POST',
      body: {
        title: 'Hydrate',
        cost: 500,
        prompt: 'Remind me to drink water',
        is_global_cooldown_enabled: true,
        global_cooldown_seconds: 60,
        should_redemptions_skip_request_queue: false,
      },
    });
    expect(reward).toMatchObject({
      id: 'afaa7e34-6b17-49f0-a19a-d1e76eaaf673',
      title: 'game analysis 1v1',
      cost: 50000,
      isEnabled: true,
      isPaused: false,
      skipsQueue: false,
      globalCooldownSeconds: null,
    });
  });

  it('refuses invalid reward input before calling Twitch', async () => {
    const { client, calls } = setup([]);
    for (const input of [
      { title: '', cost: 1 },
      { title: 'x'.repeat(CHANNEL_POINTS_LIMITS.titleLength + 1), cost: 1 },
      { title: 'ok', cost: 0 },
      { title: 'ok', cost: 1, prompt: 'p'.repeat(201) },
    ])
      expect((await rejection(client.createCustomReward(BROADCASTER, input))).code).toBe(
        'TWITCH_INVALID_REQUEST',
      );
    expect(calls).toHaveLength(0);
  });

  it('does not retry a reward creation after a server error (it may have applied)', async () => {
    const { client, calls } = setup([json({}, 500)]);
    const error = await rejection(client.createCustomReward(BROADCASTER, { title: 'a', cost: 1 }));
    expect(error.code).toBe('TWITCH_UNAVAILABLE');
    expect(calls).toHaveLength(1);
  });

  it('lists only rewards Riff may manage, tolerating the documented missing login', async () => {
    const { client, calls } = setup([json(fixture('helix.get-custom-reward.json'))]);
    const rewards = await client.getCustomRewards(BROADCASTER, { onlyManageable: true });
    expect(calls[0]?.url).toBe(
      `https://api.twitch.tv/helix/channel_points/custom_rewards?broadcaster_id=${BROADCASTER}&only_manageable_rewards=true`,
    );
    expect(rewards).toHaveLength(1);
    expect(rewards[0]?.id).toBe(REWARD);
  });

  it('updates and pauses with PATCH carrying only changed fields', async () => {
    const { client, calls } = setup([json(fixture('helix.update-custom-reward.json'))]);
    const reward = await client.updateCustomReward(BROADCASTER, REWARD, { isPaused: true });
    expect(calls[0]?.method).toBe('PATCH');
    expect(calls[0]?.url).toBe(
      `https://api.twitch.tv/helix/channel_points/custom_rewards?broadcaster_id=${BROADCASTER}&id=${REWARD}`,
    );
    expect(calls[0]?.body).toEqual({ is_paused: true });
    expect(reward.maxPerStream).toBe(60);
    expect(reward.skipsQueue).toBe(true);
  });

  it('deletes with DELETE and accepts 204', async () => {
    const { client, calls } = setup([new Response(null, { status: 204 })]);
    await client.deleteCustomReward(BROADCASTER, REWARD);
    expect(calls[0]?.method).toBe('DELETE');
  });

  it('explains the ownership and eligibility constraint on 403', async () => {
    const { client } = setup([
      json({ error: 'Forbidden', status: 403, message: 'client id mismatch' }, 403),
    ]);
    const error = await rejection(client.updateCustomReward(BROADCASTER, REWARD, { cost: 2 }));
    expect(error.code).toBe('TWITCH_FORBIDDEN');
    expect(error.message).toMatch(/created by Riff/);
    expect(error.message).toMatch(/Affiliate or Partner/);
  });

  it('updates redemption status to FULFILLED or CANCELED (refund)', async () => {
    const { client, calls } = setup([json(fixture('helix.update-redemption-status.json'))]);
    const [updated] = await client.updateRedemptionStatus(BROADCASTER, REWARD, ['r1'], 'CANCELED');
    expect(calls[0]?.url).toBe(
      `https://api.twitch.tv/helix/channel_points/custom_rewards/redemptions?broadcaster_id=${BROADCASTER}&reward_id=${REWARD}&id=r1`,
    );
    expect(calls[0]?.body).toEqual({ status: 'CANCELED' });
    expect(updated).toMatchObject({ status: 'CANCELED', rewardId: REWARD, viewerId: BROADCASTER });
    await expect(
      client.updateRedemptionStatus(BROADCASTER, REWARD, [], 'FULFILLED'),
    ).rejects.toThrow();
  });

  it('pages unfulfilled redemptions', async () => {
    const { client, calls } = setup([json(fixture('helix.get-custom-reward-redemption.json'))]);
    const page = await client.getRedemptions(BROADCASTER, REWARD, { status: 'UNFULFILLED' });
    expect(calls[0]?.url).toContain('status=UNFULFILLED');
    expect(page.cursor).toBe('fake-cursor-0001');
    expect(page.redemptions[0]?.id).toBe('17fa2df1-ad76-4804-bfa5-a40ef63efe63');
  });
});

describe('Predictions Helix endpoints', () => {
  it('creates a prediction with the documented body', async () => {
    const { client, calls } = setup([json(fixture('helix.create-prediction.json'))]);
    const prediction = await client.createPrediction('141981764', {
      title: 'Any leeks in the stream?',
      outcomes: ['Yes, give it time.', 'Definitely not.'],
      windowSeconds: 120,
    });
    expect(calls[0]).toEqual({
      url: 'https://api.twitch.tv/helix/predictions',
      method: 'POST',
      body: {
        broadcaster_id: '141981764',
        title: 'Any leeks in the stream?',
        outcomes: [{ title: 'Yes, give it time.' }, { title: 'Definitely not.' }],
        prediction_window: 120,
      },
    });
    expect(prediction).toMatchObject({
      id: 'bc637af0-7766-4525-9308-4112f4cbf178',
      status: 'ACTIVE',
      windowSeconds: 120,
      winningOutcomeId: null,
    });
    expect(prediction.outcomes.map((o) => o.title)).toEqual([
      'Yes, give it time.',
      'Definitely not.',
    ]);
  });

  it('validates documented title, outcome and window bounds locally', async () => {
    const { client, calls } = setup([]);
    const base = { title: 'Ok?', outcomes: ['a', 'b'], windowSeconds: 60 };
    for (const input of [
      { ...base, title: 'x'.repeat(PREDICTION_LIMITS.titleLength + 1) },
      { ...base, outcomes: ['only'] },
      { ...base, outcomes: Array.from({ length: 11 }, (_, i) => `o${i}`) },
      { ...base, outcomes: ['a', 'y'.repeat(26)] },
      { ...base, windowSeconds: 29 },
      { ...base, windowSeconds: 1801 },
    ])
      expect((await rejection(client.createPrediction('1', input))).code).toBe(
        'TWITCH_INVALID_REQUEST',
      );
    expect(calls).toHaveLength(0);
  });

  it('gets predictions and ends one as RESOLVED with a winner', async () => {
    const { client, calls } = setup([
      json(fixture('helix.get-predictions.json')),
      json(fixture('helix.end-prediction.json')),
    ]);
    const [current] = await client.getPredictions('55696719', { first: 1 });
    expect(current?.status).toBe('ACTIVE');
    expect(calls[0]?.url).toBe(
      'https://api.twitch.tv/helix/predictions?broadcaster_id=55696719&first=1',
    );
    const ended = await client.endPrediction('141981764', {
      id: 'bc637af0-7766-4525-9308-4112f4cbf178',
      status: 'RESOLVED',
      winningOutcomeId: '73085848-a94d-4040-9d21-2cb7a89374b7',
    });
    expect(calls[1]).toMatchObject({
      method: 'PATCH',
      body: {
        broadcaster_id: '141981764',
        id: 'bc637af0-7766-4525-9308-4112f4cbf178',
        status: 'RESOLVED',
        winning_outcome_id: '73085848-a94d-4040-9d21-2cb7a89374b7',
      },
    });
    expect(ended.status).toBe('RESOLVED');
  });

  it('requires a winner to resolve and never sends one for lock or cancel', async () => {
    const { client, calls } = setup([json(fixture('helix.end-prediction.json'))]);
    await expect(client.endPrediction('1', { id: 'p', status: 'RESOLVED' })).rejects.toBeInstanceOf(
      TwitchError,
    );
    await client.endPrediction('1', { id: 'p', status: 'LOCKED', winningOutcomeId: 'x' });
    expect(calls[0]?.body).toEqual({ broadcaster_id: '1', id: 'p', status: 'LOCKED' });
  });
});
