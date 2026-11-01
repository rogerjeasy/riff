import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { TWITCH_EVENT_KINDS } from '@riff/sdk';
import { EVENT_TRIGGER_NAMES, TRIGGERS } from '@riff/twitch';
import { createApp, type RiffApp } from '../src/app.js';
import { createSealer } from '../src/services/auth/secrets.js';

type Fixture = Record<string, unknown> & {
  event: Record<string, unknown>;
  subscription: Record<string, unknown>;
  payload: { session: Record<string, unknown> };
  metadata: unknown;
};
const fixture = (name: string) =>
  JSON.parse(
    readFileSync(new URL(`../../../packages/twitch/fixtures/${name}`, import.meta.url), 'utf8'),
  ) as Fixture;
const SECRET = 'x'.repeat(43); // Deterministic test data, never a credential.
const headers = { 'x-riff-request': '1' };
// Every F19 doc fixture uses this broadcaster id.
const BROADCASTER = '1337';
const CONFETTI = 'When someone cheers 100+ bits, rain confetti';
const RAID = 'When we get raided, show a welcome banner';

let app: RiffApp | undefined;
let server: WebSocketServer | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
  await new Promise((resolve) => (server ? server.close(resolve) : resolve(null)));
  server = undefined;
});

const wait = async (done: () => boolean, ms = 60_000) => {
  for (const start = Date.now(); !done() && Date.now() - start < ms;)
    await new Promise((resolve) => setTimeout(resolve, 25));
};

async function boot(scopes: string[]) {
  server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  const sockets: WebSocket[] = [];
  server.on('connection', (socket) => {
    sockets.push(socket);
    const welcome = fixture('session_welcome.json');
    socket.send(JSON.stringify({ metadata: welcome.metadata, payload: welcome.payload }));
  });
  await new Promise((resolve) => server!.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  const subscriptions: { type: string; condition: Record<string, string> }[] = [];
  const fakeFetch = async (url: string, init?: RequestInit) => {
    if (url.endsWith('/eventsub/subscriptions') && init?.method === 'POST') {
      subscriptions.push(JSON.parse(String(init.body)));
      const body = fixture('helix.create-eventsub-subscription.json');
      return new Response(JSON.stringify({ ...body, _source: undefined }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('{}', { status: 404 });
  };
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
    fetch: fakeFetch,
  });
  app.riff.repo.updateState({
    twitchUserId: BROADCASTER,
    twitchLogin: 'cooler_user',
    twitchTokens: createSealer(SECRET).seal({
      accessToken: 'token',
      refreshToken: 'refresh',
      expiresAt: Date.now() + 3_600_000,
      scopes,
    }),
  });
  const effects: { viewer: string | null }[] = [];
  app.riff.overlay.attach(
    {
      send: (data) => {
        const message = JSON.parse(data) as { type: string; payload: { viewer: string | null } };
        if (message.type === 'effect') effects.push(message.payload);
      },
      close: () => undefined,
    },
    'home',
  );
  return { sockets, subscriptions, effects };
}

async function approve(intent: string) {
  const riff = app!;
  const run = await riff.inject({
    method: 'POST',
    url: '/api/compile-runs',
    headers,
    payload: { intent },
  });
  const id = run.json<{ id: string }>().id;
  await wait(() => Boolean(riff.riff.authoring.runs().find((r) => r.id === id)?.result));
  const studio = (await riff.inject({ method: 'GET', url: '/api/studio' })).json<{
    automations: { versions: { id: string; artifactId: string; intent: string }[] }[];
  }>();
  const version = studio.automations
    .flatMap((automation) => automation.versions)
    .find((v) => v.intent === intent)!;
  const approved = await riff.inject({
    method: 'POST',
    url: `/api/versions/${version.id}/approve`,
    headers,
    payload: { artifactId: version.artifactId, expectedActiveVersionId: null },
  });
  expect(approved.statusCode).toBe(200);
  return version;
}

function notify(socket: WebSocket, name: keyof typeof TRIGGERS, messageId: string, edit = {}) {
  const sample = fixture(TRIGGERS[name].fixture);
  socket.send(
    JSON.stringify({
      metadata: {
        message_id: messageId,
        message_type: 'notification',
        message_timestamp: new Date().toISOString(),
        subscription_type: TRIGGERS[name].type,
        subscription_version: TRIGGERS[name].version,
      },
      payload: { subscription: sample.subscription, event: { ...sample.event, ...edit } },
    }),
  );
}

describe('F19 trigger names', () => {
  it('keeps the SDK event kinds and the Twitch trigger table in sync', () => {
    expect([...EVENT_TRIGGER_NAMES].sort()).toEqual([...TWITCH_EVENT_KINDS].sort());
  });
});

describe('F19 live routing', () => {
  it('subscribes to channel.cheer for a live cheer interaction and routes cheers to the overlay', async () => {
    const { sockets, subscriptions, effects } = await boot(['user:read:chat', 'bits:read']);
    await approve(CONFETTI);
    await app!.ready();
    await wait(() => subscriptions.some((s) => s.type === 'channel.cheer'));
    expect(subscriptions.find((s) => s.type === 'channel.cheer')).toMatchObject({
      version: '1',
      condition: { broadcaster_user_id: BROADCASTER },
      transport: { method: 'websocket' },
    });
    // No consent-free extra families are created for interactions nobody runs.
    expect(subscriptions.some((s) => s.type === 'channel.raid')).toBe(false);

    notify(sockets[0]!, 'cheer', 'cheer-1'); // documented example: 1000 bits → 5 stars
    notify(sockets[0]!, 'cheer', 'cheer-1'); // EventSub redelivery: same message_id
    notify(sockets[0]!, 'cheer', 'cheer-2', { bits: 50 }); // below the 100-bit minimum
    notify(sockets[0]!, 'cheer', 'cheer-3', {
      is_anonymous: true,
      user_id: null,
      user_login: null,
      user_name: null,
      bits: 100,
    });
    notify(sockets[0]!, 'cheer', 'cheer-4', { broadcaster_user_id: 'someone-else' });
    await wait(() => effects.length >= 6, 30_000);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(effects).toHaveLength(6);
    expect(effects.filter((e) => e.viewer === 'Cool_User')).toHaveLength(5);
    expect(effects.filter((e) => e.viewer === 'Anonymous')).toHaveLength(1);

    const triggers = (await app!.inject({ method: 'GET', url: '/api/twitch/triggers' })).json<{
      triggers: { name: string; inUse: boolean; subscription: string; missingScopes: string[] }[];
    }>().triggers;
    expect(triggers.find((t) => t.name === 'cheer')).toMatchObject({
      inUse: true,
      subscription: 'active',
      missingScopes: [],
    });
    expect(triggers.find((t) => t.name === 'gift')).toMatchObject({
      inUse: false,
      subscription: 'missing-consent',
      missingScopes: ['channel:read:subscriptions'],
    });
    const activity = (await app!.inject({ method: 'GET', url: '/api/studio' })).json<{
      activity: { code: string | null; message: string }[];
    }>().activity;
    expect(activity.some((a) => a.message.startsWith('Cool_User cheered 1000 bits'))).toBe(true);
    expect(activity.filter((a) => a.code === 'BELOW_MINIMUM')).toHaveLength(1);
  }, 180_000);

  it('surfaces missing consent instead of subscribing, and raids need no extra scope', async () => {
    const { sockets, subscriptions, effects } = await boot(['user:read:chat']);
    await approve(CONFETTI);
    await approve(RAID);
    await app!.ready();
    await wait(() => subscriptions.some((s) => s.type === 'channel.raid'));
    expect(subscriptions.find((s) => s.type === 'channel.raid')).toMatchObject({
      condition: { to_broadcaster_user_id: BROADCASTER },
    });
    expect(subscriptions.some((s) => s.type === 'channel.cheer')).toBe(false);
    const triggers = (await app!.inject({ method: 'GET', url: '/api/twitch/triggers' })).json<{
      triggers: { name: string; inUse: boolean; subscription: string; missingScopes: string[] }[];
    }>().triggers;
    expect(triggers.find((t) => t.name === 'cheer')).toMatchObject({
      inUse: true,
      subscription: 'missing-consent',
      missingScopes: ['bits:read'],
    });
    notify(sockets[0]!, 'raid', 'raid-1');
    await wait(() => effects.length >= 5, 30_000);
    expect(effects).toHaveLength(5);
    expect(effects.every((e) => e.viewer === 'Cool_User')).toBe(true);
  }, 180_000);

  it('records incoming raids for the “raiders only” shoutout policy, even with no raid interaction', async () => {
    const { sockets, subscriptions } = await boot(['user:read:chat']);
    await app!.ready();
    expect(subscriptions.some((s) => s.type === 'channel.raid')).toBe(false);
    // Choosing the raiders policy makes the host listen for raids on its own.
    await app!.riff.twitchFeatures.setShoutoutPolicy('raiders', []);
    await wait(() => subscriptions.some((s) => s.type === 'channel.raid'));
    expect(subscriptions.find((s) => s.type === 'channel.raid')).toMatchObject({
      condition: { to_broadcaster_user_id: BROADCASTER },
    });
    notify(sockets[0]!, 'raid', 'raid-policy-1');
    await wait(() => app!.riff.twitchFeatures.snapshot().shoutout.raiders.length > 0, 30_000);
    expect(app!.riff.twitchFeatures.snapshot().shoutout.raiders).toEqual([
      expect.objectContaining({ login: 'cool_user', displayName: 'Cool_User' }),
    ]);
  }, 180_000);

  it('drops platform events while panicked and never routes them to chat commands', async () => {
    const { effects } = await boot(['user:read:chat']);
    await approve('Let viewers throw tomatoes with !tomato, three per person per minute.');
    const twitch = {
      kind: 'cheer' as const,
      amount: 500,
      tier: null,
      anonymous: false,
      gift: false,
    };
    const base = {
      channelId: BROADCASTER,
      viewerId: '1234',
      viewerName: 'Cool_User',
      text: '!tomato',
      twitch,
      source: 'twitch' as const,
    };
    const decisions = await app!.riff.runtime.handleTwitchEvent({ ...base, id: 'evt-1' });
    expect(decisions.map((d) => d.code)).toEqual(['UNRELATED']);
    app!.riff.runtime.panic('test');
    expect(await app!.riff.runtime.handleTwitchEvent({ ...base, id: 'evt-2' })).toEqual([]);
    expect(effects).toHaveLength(0);
  }, 180_000);
});

describe('F19 consent and preview routes', () => {
  it('requests only the scopes the chosen families need, keeping earlier consent', async () => {
    await boot(['user:read:chat', 'bits:read']);
    const redirect = await app!.inject({ method: 'GET', url: '/auth/twitch?triggers=gift,raid' });
    expect(redirect.statusCode).toBe(302);
    const scope = new URL(String(redirect.headers.location)).searchParams.get('scope');
    expect(scope?.split(' ').sort()).toEqual(
      ['bits:read', 'channel:read:subscriptions', 'user:read:chat'].sort(),
    );
    expect(
      (await app!.inject({ method: 'GET', url: '/auth/twitch?triggers=follow' })).statusCode,
    ).toBe(400);
  }, 60_000);

  it('rehearses labeled synthetic cheers privately through the same engine', async () => {
    await boot(['user:read:chat']);
    const version = await approve(CONFETTI);
    const event = (id: string, at: number, amount: number | null) => ({
      id,
      channelId: 'rehearsal',
      viewerId: 'alice',
      roles: ['viewer'],
      text: amount === null ? '!cheer' : '',
      at,
      ...(amount === null
        ? {}
        : { twitch: { kind: 'cheer', amount, tier: null, anonymous: false, gift: false } }),
    });
    const response = await app!.inject({
      method: 'POST',
      url: `/api/versions/${version.id}/preview`,
      headers,
      payload: { seed: 7, events: [event('a', 0, 300), event('b', 1, 99), event('c', 2, null)] },
    });
    expect(response.statusCode).toBe(200);
    const result = response.json<{
      provenance: string;
      decisions: { code: string; effects: unknown[]; mode: string }[];
    }>();
    expect(result.provenance).toBe('synthetic');
    expect(result.decisions.map((d) => [d.code, d.effects.length, d.mode])).toEqual([
      ['ACCEPTED', 3, 'preview'],
      ['BELOW_MINIMUM', 0, 'preview'],
      ['UNRELATED', 0, 'preview'],
    ]);
    // Invalid synthetic detail (a tier on a cheer) fails closed at the boundary.
    const invalid = await app!.inject({
      method: 'POST',
      url: `/api/versions/${version.id}/preview`,
      headers,
      payload: {
        seed: 7,
        events: [
          {
            ...event('x', 0, 100),
            twitch: { kind: 'cheer', amount: 100, tier: '1000', anonymous: false, gift: false },
          },
        ],
      },
    });
    expect(invalid.statusCode).toBe(400);
  }, 180_000);
});
