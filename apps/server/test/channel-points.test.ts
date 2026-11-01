import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { createApp, type RiffApp } from '../src/app.js';
import { createSealer } from '../src/services/auth/secrets.js';

type Json = Record<string, unknown>;
const fixture = (name: string) => {
  const raw = JSON.parse(
    readFileSync(new URL(`../../../packages/twitch/fixtures/${name}`, import.meta.url), 'utf8'),
  ) as Json;
  delete raw['_source'];
  delete raw['_note'];
  return raw as Json & {
    event: Json;
    subscription: Json;
    data: Json[];
    metadata: unknown;
    payload: unknown;
  };
};
const SECRET = 'y'.repeat(43); // Deterministic test data, never a credential.
const headers = { 'x-riff-request': '1' };
const HYDRATE = "When someone redeems 'Hydrate', show a water splash.";
const PREDICT =
  "When I type !predict, propose a prediction 'Will we beat the boss?' with 'Yes' and 'No' for 90 seconds.";
const BROADCASTER = String(fixture('channel.chat.message.json').event.broadcaster_user_id);
const SCOPES = ['user:read:chat', 'channel:manage:redemptions', 'channel:manage:predictions'];
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean, tries = 150) {
  for (let i = 0; i < tries && !check(); i++) await wait(20);
}

interface Call {
  method: string;
  path: string;
  search: URLSearchParams;
  body: Json | undefined;
}
/** A stateful stand-in for the documented Helix responses, built from sourced fixtures. */
function fakeHelix(options: { broadcasterType?: string } = {}) {
  const calls: Call[] = [];
  const rewards = new Map<string, Json>();
  let prediction: Json | null = null;
  let nextReward = 1;
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetch = async (raw: string, init?: RequestInit) => {
    const url = new URL(raw);
    const path = url.pathname.replace(/^\/helix/, '');
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Json) : undefined;
    const method = init?.method ?? 'GET';
    calls.push({ method, path, search: url.searchParams, body });
    if (path === '/eventsub/subscriptions')
      return json(fixture('helix.create-eventsub-subscription.json'), 202);
    if (path === '/users') {
      const users = fixture('helix.get-users.json');
      return json({
        data: users.data.map((u) => ({
          ...u,
          id: BROADCASTER,
          broadcaster_type: options.broadcasterType ?? 'affiliate',
        })),
      });
    }
    if (path === '/channel_points/custom_rewards') {
      const id = url.searchParams.get('id');
      if (method === 'POST') {
        const reward = {
          ...fixture('helix.create-custom-rewards.json').data[0],
          id: `00000000-0000-4000-8000-00000000000${nextReward++}`,
          broadcaster_id: BROADCASTER,
          title: body?.['title'],
          cost: body?.['cost'],
          prompt: body?.['prompt'] ?? '',
        };
        rewards.set(String(reward.id), reward);
        return json({ data: [reward] });
      }
      if (method === 'PATCH') {
        const reward = id ? rewards.get(id) : undefined;
        if (!reward) return json({ error: 'Forbidden', status: 403, message: 'not yours' }, 403);
        if (body?.['is_paused'] !== undefined) reward['is_paused'] = body['is_paused'];
        if (body?.['cost'] !== undefined) reward['cost'] = body['cost'];
        return json({ data: [reward] });
      }
      if (method === 'DELETE') {
        rewards.delete(String(id));
        return new Response(null, { status: 204 });
      }
      return json({ data: [...rewards.values()] });
    }
    if (path === '/channel_points/custom_rewards/redemptions' && method === 'PATCH') {
      const updated = structuredClone(fixture('helix.update-redemption-status.json').data[0]!);
      updated['id'] = url.searchParams.get('id');
      updated['status'] = body?.['status'];
      return json({ data: [updated] });
    }
    if (path === '/predictions') {
      if (method === 'POST') {
        const created = structuredClone(fixture('helix.create-prediction.json').data[0]!);
        created['title'] = body?.['title'];
        created['prediction_window'] = body?.['prediction_window'];
        created['outcomes'] = (body?.['outcomes'] as { title: string }[]).map((o, i) => ({
          ...(created['outcomes'] as Json[])[i % 2],
          id: `outcome-${i}`,
          title: o.title,
        }));
        prediction = created;
        return json({ data: [created] });
      }
      if (method === 'PATCH') {
        if (!prediction) return json({ message: 'not found' }, 404);
        prediction = {
          ...prediction,
          status: body?.['status'],
          winning_outcome_id: body?.['winning_outcome_id'] ?? null,
        };
        return json({ data: [prediction] });
      }
      return json({ data: prediction ? [prediction] : [], pagination: {} });
    }
    return json({}, 404);
  };
  return { fetch, calls, rewards };
}

let app: RiffApp | undefined;
let server: WebSocketServer | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
  await new Promise((resolve) => (server ? server.close(resolve) : resolve(null)));
  server = undefined;
});

async function boot(helix = fakeHelix(), scopes = SCOPES) {
  server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  const sockets: WebSocket[] = [];
  server.on('connection', (socket) => {
    sockets.push(socket);
    const welcome = fixture('session_welcome.json');
    socket.send(JSON.stringify({ metadata: welcome.metadata, payload: welcome.payload }));
  });
  await new Promise((resolve) => server!.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  app = await createApp({
    logger: false,
    secret: SECRET,
    twitch: {
      clientId: 'client',
      clientSecret: 'secret',
      redirectUri: 'http://localhost:8787/auth/twitch/callback',
      eventSubUrl: `ws://127.0.0.1:${port}/ws`,
      helixBaseUrl: 'http://helix.test/helix',
    },
    fetch: helix.fetch,
  });
  app.riff.repo.updateState({
    twitchUserId: BROADCASTER,
    twitchLogin: 'streamer',
    twitchTokens: createSealer(SECRET).seal({
      accessToken: 'token',
      refreshToken: 'refresh',
      expiresAt: Date.now() + 3_600_000,
      scopes,
    }),
  });
  const effects: unknown[] = [];
  app.riff.overlay.attach(
    {
      send: (data) => JSON.parse(data).type === 'effect' && effects.push(data),
      close: () => undefined,
    },
    'home',
  );
  return { app, sockets, effects };
}
async function approve(intent: string) {
  const run = await app!.inject({
    method: 'POST',
    url: '/api/compile-runs',
    headers,
    payload: { intent },
  });
  const runId = run.json<{ id: string }>().id;
  await until(() => Boolean(app!.riff.authoring.runs().find((r) => r.id === runId)?.result), 300);
  const studio = (await app!.inject({ method: 'GET', url: '/api/studio' })).json<{
    automations: {
      id: string;
      title: string;
      versions: { id: string; artifactId: string; verification?: { ok: boolean } }[];
    }[];
  }>();
  const automation = studio.automations.find((a) =>
    a.versions.some((v) => app!.riff.repo.version(v.id)?.intent === intent),
  )!;
  const version = automation.versions[0]!;
  const approved = await app!.inject({
    method: 'POST',
    url: `/api/versions/${version.id}/approve`,
    headers,
    payload: { artifactId: version.artifactId, expectedActiveVersionId: null },
  });
  expect(approved.statusCode, approved.body).toBe(200);
  return { automationId: automation.id, versionId: version.id };
}
const notify = (socket: WebSocket, type: string, messageId: string, event: Json) =>
  socket.send(
    JSON.stringify({
      metadata: {
        message_id: messageId,
        message_type: 'notification',
        message_timestamp: new Date().toISOString(),
        subscription_type: type,
        subscription_version: '1',
      },
      payload: {
        subscription: {
          ...fixture('channel.chat.message.json').subscription,
          type,
          condition: { broadcaster_user_id: BROADCASTER },
        },
        event,
      },
    }),
  );

describe('Channel Points', () => {
  it('creates a Riff reward, links it, and fulfils or refunds redemptions by host policy', async () => {
    const helix = fakeHelix();
    const { sockets, effects } = await boot(helix);
    const { automationId } = await approve(HYDRATE);
    await app!.ready();
    await until(() => helix.calls.filter((c) => c.path === '/eventsub/subscriptions').length >= 2);
    const subscriptions = helix.calls.filter((c) => c.path === '/eventsub/subscriptions');
    expect(subscriptions[1]?.body).toMatchObject({
      type: 'channel.channel_points_custom_reward_redemption.add',
      version: '1',
      condition: { broadcaster_user_id: BROADCASTER },
    });

    const created = await app!.inject({
      method: 'POST',
      url: '/api/channel-points/rewards',
      headers,
      payload: { title: 'Hydrate', cost: 100 },
    });
    expect(created.statusCode, created.body).toBe(200);
    const view = created.json<{
      rewards: { id: string; title: string }[];
      eligibility: string;
      automations: { id: string; reward: string }[];
    }>();
    expect(view.eligibility).toBe('affiliate');
    expect(view.automations).toEqual([
      expect.objectContaining({ id: automationId, reward: 'Hydrate' }),
    ]);
    const rewardId = view.rewards[0]!.id;
    expect(
      helix.calls.find((c) => c.method === 'POST' && c.path === '/channel_points/custom_rewards')
        ?.body,
    ).toMatchObject({
      should_redemptions_skip_request_queue: false,
    });
    const linked = await app!.inject({
      method: 'POST',
      url: `/api/channel-points/rewards/${rewardId}/link`,
      headers,
      payload: { automationId, policy: 'auto' },
    });
    expect(linked.statusCode, linked.body).toBe(200);

    const base = fixture('channel.channel_points_custom_reward_redemption.add.json').event;
    const redeem = (messageId: string, redemptionId: string, viewer = 'v1', reward = rewardId) =>
      notify(sockets[0]!, 'channel.channel_points_custom_reward_redemption.add', messageId, {
        ...base,
        id: redemptionId,
        broadcaster_user_id: BROADCASTER,
        user_id: viewer,
        user_input: '',
        reward: { ...(base['reward'] as Json), id: reward },
      });
    const statusUpdates = () =>
      helix.calls.filter((c) => c.path === '/channel_points/custom_rewards/redemptions');
    for (const n of [1, 2, 3, 4]) redeem(`m${n}`, `r${n}`);
    redeem('m1', 'r1'); // EventSub redelivery
    redeem('m9', 'r1'); // same redemption, new envelope
    await until(() => statusUpdates().length >= 4);
    await wait(200);
    expect(effects).toHaveLength(3);
    const updates = statusUpdates().map((c) => [c.search.get('id'), c.body?.['status']]);
    expect(updates).toEqual([
      ['r1', 'FULFILLED'],
      ['r2', 'FULFILLED'],
      ['r3', 'FULFILLED'],
      ['r4', 'CANCELED'],
    ]);

    // Rewards Riff did not create are ignored entirely: no admission and no status update.
    redeem('m5', 'r5', 'v1', 'someone-elses-reward');
    await wait(200);
    expect(statusUpdates()).toHaveLength(4);

    // Ownership is checked before any Helix call.
    const before = helix.calls.length;
    const foreign = await app!.inject({
      method: 'POST',
      url: '/api/channel-points/rewards/someone-elses-reward',
      headers,
      payload: { cost: 5 },
    });
    expect(foreign.statusCode).toBe(403);
    expect(foreign.json()).toMatchObject({ code: 'OWNERSHIP' });
    expect(helix.calls.length).toBe(before);

    const queue = (await app!.inject({ method: 'GET', url: '/api/channel-points' })).json<{
      redemptions: { id: string; status: string }[];
    }>();
    expect(Object.fromEntries(queue.redemptions.map((r) => [r.id, r.status]))).toEqual({
      r1: 'fulfilled',
      r2: 'fulfilled',
      r3: 'fulfilled',
      r4: 'refunded',
    });

    // Panic pauses Riff rewards and later redemptions are refunded without reaching guests.
    await app!.inject({ method: 'POST', url: '/api/channel/panic', headers, payload: {} });
    await until(() =>
      helix.calls.some((c) => c.method === 'PATCH' && c.body?.['is_paused'] === true),
    );
    redeem('m6', 'r6', 'v2');
    await until(() => statusUpdates().length >= 5);
    expect(statusUpdates().at(-1)?.body).toEqual({ status: 'CANCELED' });
    expect(effects).toHaveLength(3);
  }, 45_000);

  it('manual policy waits for the creator, who fulfils or refunds explicitly', async () => {
    const helix = fakeHelix();
    const { sockets } = await boot(helix);
    const { automationId } = await approve(HYDRATE);
    await app!.ready();
    await until(() => helix.calls.filter((c) => c.path === '/eventsub/subscriptions').length >= 2);
    const view = (
      await app!.inject({
        method: 'POST',
        url: '/api/channel-points/rewards',
        headers,
        payload: { title: 'Hydrate', cost: 100 },
      })
    ).json<{ rewards: { id: string }[] }>();
    const rewardId = view.rewards[0]!.id;
    await app!.inject({
      method: 'POST',
      url: `/api/channel-points/rewards/${rewardId}/link`,
      headers,
      payload: { automationId, policy: 'manual' },
    });
    const base = fixture('channel.channel_points_custom_reward_redemption.add.json').event;
    notify(sockets[0]!, 'channel.channel_points_custom_reward_redemption.add', 'm1', {
      ...base,
      id: 'r1',
      broadcaster_user_id: BROADCASTER,
      reward: { ...(base['reward'] as Json), id: rewardId },
    });
    await until(() =>
      app!.riff.channelPoints
        .view()
        .redemptions.some((r) => r.id === 'r1' && r.code === 'ACCEPTED'),
    );
    expect(app!.riff.channelPoints.view().redemptions[0]).toMatchObject({ status: 'queued' });
    expect(helix.calls.some((c) => c.path === '/channel_points/custom_rewards/redemptions')).toBe(
      false,
    );
    const settled = await app!.inject({
      method: 'POST',
      url: '/api/channel-points/redemptions/r1',
      headers,
      payload: { action: 'refund' },
    });
    expect(settled.statusCode, settled.body).toBe(200);
    expect(helix.calls.at(-1)?.body).toEqual({ status: 'CANCELED' });
    const again = await app!.inject({
      method: 'POST',
      url: '/api/channel-points/redemptions/r1',
      headers,
      payload: { action: 'fulfil' },
    });
    expect(again.statusCode).toBe(409);
  }, 45_000);

  it('surfaces missing consent and Affiliate/Partner eligibility before mutating', async () => {
    const helix = fakeHelix({ broadcasterType: '' });
    await boot(helix, ['user:read:chat']);
    await app!.ready();
    await until(() => app!.riff.twitch.api() !== null);
    const noConsent = await app!.inject({
      method: 'POST',
      url: '/api/channel-points/rewards',
      headers,
      payload: { title: 'Hydrate', cost: 100 },
    });
    expect(noConsent.json()).toMatchObject({ code: 'CONSENT' });
    const view = (await app!.inject({ method: 'GET', url: '/api/channel-points' })).json<{
      consent: { granted: boolean; url: string };
    }>();
    expect(view.consent).toEqual({ granted: false, url: '/auth/twitch?features=channel-points' });
    const authorize = await app!.inject({ method: 'GET', url: view.consent.url });
    expect(decodeURIComponent(authorize.headers.location ?? '').replace(/\+/g, ' ')).toContain(
      'scope=user:read:chat channel:manage:redemptions',
    );
    // Eligibility: with consent but a non-affiliate broadcaster, nothing is created.
    app!.riff.repo.updateState({
      twitchTokens: createSealer(SECRET).seal({
        accessToken: 'token',
        refreshToken: 'refresh',
        expiresAt: Date.now() + 3_600_000,
        scopes: SCOPES,
      }),
    });
    const ineligible = await app!.inject({
      method: 'POST',
      url: '/api/channel-points/rewards',
      headers,
      payload: { title: 'Hydrate', cost: 100 },
    });
    expect(ineligible.json()).toMatchObject({ code: 'INELIGIBLE' });
    expect(helix.calls.some((c) => c.path === '/channel_points/custom_rewards')).toBe(false);
  }, 45_000);

  it('rehearses a redemption privately with no Helix call', async () => {
    const helix = fakeHelix();
    await boot(helix);
    const { versionId } = await approve(HYDRATE);
    const before = helix.calls.length;
    const preview = await app!.inject({
      method: 'POST',
      url: `/api/versions/${versionId}/preview`,
      headers,
      payload: {
        seed: 7,
        events: [
          {
            id: 'p1',
            channelId: 'preview',
            viewerId: 'ada',
            roles: ['viewer'],
            text: '',
            at: 0,
            kind: 'points.redeem',
          },
          {
            id: 'p2',
            channelId: 'preview',
            viewerId: 'ada',
            roles: ['viewer'],
            text: '!hydrate',
            at: 1,
          },
        ],
      },
    });
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json<{ decisions: { code: string }[] }>().decisions.map((d) => d.code)).toEqual([
      'ACCEPTED',
      'UNRELATED',
    ]);
    expect(helix.calls.length).toBe(before);
  }, 45_000);
});

describe('Predictions', () => {
  it('records automation proposals, opens only on creator action and settles only with confirmation', async () => {
    const helix = fakeHelix();
    const { sockets } = await boot(helix);
    await approve(PREDICT);
    await app!.ready();
    await until(() => helix.calls.filter((c) => c.path === '/eventsub/subscriptions').length >= 2);
    const chat = fixture('channel.chat.message.json');
    notify(sockets[0]!, 'channel.chat.message', 'c1', {
      ...chat.event,
      badges: [{ set_id: 'broadcaster', id: '1', info: '' }],
      message_id: 'chat-c1',
      message: { text: '!predict', fragments: [] },
    });
    await until(() => app!.riff.predictions.view().requests.length > 0);
    const proposal = app!.riff.predictions.view().requests[0]!;
    expect(proposal).toMatchObject({
      source: 'automation',
      status: 'proposed',
      title: 'Will we beat the boss?',
      outcomes: ['Yes', 'No'],
      windowSeconds: 90,
    });
    // Proposing never reaches Twitch.
    expect(helix.calls.some((c) => c.path === '/predictions' && c.method === 'POST')).toBe(false);

    const opened = await app!.inject({
      method: 'POST',
      url: `/api/predictions/proposals/${proposal.id}/open`,
      headers,
      payload: {},
    });
    expect(opened.statusCode, opened.body).toBe(200);
    expect(helix.calls.find((c) => c.path === '/predictions' && c.method === 'POST')?.body).toEqual(
      {
        broadcaster_id: BROADCASTER,
        title: 'Will we beat the boss?',
        outcomes: [{ title: 'Yes' }, { title: 'No' }],
        prediction_window: 90,
      },
    );
    const current = opened.json<{
      current: { id: string; status: string; outcomes: { id: string }[] };
    }>().current;
    expect(current.status).toBe('ACTIVE');

    // One at a time.
    const second = await app!.inject({
      method: 'POST',
      url: '/api/predictions',
      headers,
      payload: { title: 'Another?', outcomes: ['a', 'b'], windowSeconds: 60 },
    });
    expect(second.statusCode).toBe(409);

    // Settlement needs explicit confirmation and a real outcome of this prediction.
    const unconfirmed = await app!.inject({
      method: 'POST',
      url: '/api/predictions/end',
      headers,
      payload: {
        action: 'resolve',
        predictionId: current.id,
        winningOutcomeId: current.outcomes[0]!.id,
      },
    });
    expect(unconfirmed.statusCode).toBe(400);
    const wrongWinner = await app!.inject({
      method: 'POST',
      url: '/api/predictions/end',
      headers,
      payload: {
        action: 'resolve',
        predictionId: current.id,
        winningOutcomeId: 'made-up',
        confirm: true,
      },
    });
    expect(wrongWinner.json()).toMatchObject({ code: 'INVALID' });
    expect(helix.calls.some((c) => c.path === '/predictions' && c.method === 'PATCH')).toBe(false);
    const resolved = await app!.inject({
      method: 'POST',
      url: '/api/predictions/end',
      headers,
      payload: {
        action: 'resolve',
        predictionId: current.id,
        winningOutcomeId: current.outcomes[1]!.id,
        confirm: true,
      },
    });
    expect(resolved.statusCode, resolved.body).toBe(200);
    expect(helix.calls.at(-1)?.body).toEqual({
      broadcaster_id: BROADCASTER,
      id: current.id,
      status: 'RESOLVED',
      winning_outcome_id: current.outcomes[1]!.id,
    });
  }, 45_000);

  it('locks an open prediction and dismisses proposals on panic', async () => {
    const helix = fakeHelix();
    await boot(helix);
    await app!.ready();
    await until(() => app!.riff.twitch.api() !== null);
    const opened = await app!.inject({
      method: 'POST',
      url: '/api/predictions',
      headers,
      payload: { title: 'Clutch?', outcomes: ['Yes', 'No'], windowSeconds: 120 },
    });
    expect(opened.statusCode, opened.body).toBe(200);
    await app!.inject({ method: 'POST', url: '/api/channel/panic', headers, payload: {} });
    await until(() =>
      helix.calls.some((c) => c.method === 'PATCH' && c.body?.['status'] === 'LOCKED'),
    );
    expect(app!.riff.predictions.view().current?.status).toBe('LOCKED');
    // A stopped channel opens nothing new.
    const blocked = await app!.inject({
      method: 'POST',
      url: '/api/predictions',
      headers,
      payload: { title: 'Again?', outcomes: ['Yes', 'No'], windowSeconds: 120 },
    });
    expect(blocked.json()).toMatchObject({ code: 'BLOCKED' });
  }, 45_000);
});
