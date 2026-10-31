import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { createApp, type RiffApp } from '../src/app.js';
import { createSealer } from '../src/services/auth/secrets.js';

const fixture = (name: string) =>
  JSON.parse(
    readFileSync(new URL(`../../../packages/twitch/fixtures/${name}`, import.meta.url), 'utf8'),
  ) as Record<string, unknown> & {
    event: Record<string, unknown>;
    subscription: Record<string, unknown>;
    payload: { session: Record<string, unknown> };
    metadata: unknown;
  };
const SECRET = 'x'.repeat(43); // Deterministic test data, never a credential.
const headers = { 'x-riff-request': '1' };
let app: RiffApp | undefined;
let server: WebSocketServer | undefined;
afterEach(async () => {
  await app?.close();
  await new Promise((resolve) => server?.close(resolve));
});

it('drives the approved version from authenticated EventSub chat to the overlay', async () => {
  // A local stand-in for wss://eventsub.wss.twitch.tv speaking the documented protocol.
  server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  const sockets: WebSocket[] = [];
  server.on('connection', (socket) => {
    sockets.push(socket);
    const welcome = fixture('session_welcome.json');
    socket.send(JSON.stringify({ metadata: welcome.metadata, payload: welcome.payload }));
  });
  await new Promise((resolve) => server!.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  const subscriptions: unknown[] = [];
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
  const chat = fixture('channel.chat.message.json');
  const broadcaster = String(chat.event.broadcaster_user_id);
  app.riff.repo.updateState({
    twitchUserId: broadcaster,
    twitchLogin: 'streamer',
    twitchTokens: createSealer(SECRET).seal({
      accessToken: 'token',
      refreshToken: 'refresh',
      expiresAt: Date.now() + 3_600_000,
      scopes: ['user:read:chat'],
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

  // Approve Tomato Toss through the normal API.
  const run = await app.inject({
    method: 'POST',
    url: '/api/compile-runs',
    headers,
    payload: {
      intent:
        'Let viewers throw tomatoes with !tomato, limited to three throws per person in any rolling 60 seconds.',
    },
  });
  for (
    let i = 0;
    i < 100 &&
    !app.riff.authoring.runs().find((r) => r.id === run.json<{ id: string }>().id)?.result;
    i++
  )
    await new Promise((resolve) => setTimeout(resolve, 50));
  const studio = (await app.inject({ method: 'GET', url: '/api/studio' })).json<{
    automations: { versions: { id: string; artifactId: string }[] }[];
  }>();
  const version = studio.automations[0]!.versions[0]!;
  expect(
    (
      await app.inject({
        method: 'POST',
        url: `/api/versions/${version.id}/approve`,
        headers,
        payload: { artifactId: version.artifactId, expectedActiveVersionId: null },
      })
    ).statusCode,
  ).toBe(200);

  await app.ready(); // starts the EventSub client
  for (let i = 0; i < 100 && subscriptions.length === 0; i++)
    await new Promise((resolve) => setTimeout(resolve, 20));
  expect(subscriptions[0]).toMatchObject({
    type: 'channel.chat.message',
    version: '1',
    condition: { broadcaster_user_id: broadcaster, user_id: broadcaster },
    transport: { method: 'websocket', session_id: 'AQoQILE98gtqShGmLD7AM6yJThAB' },
  });

  const send = (messageId: string, text: string) =>
    sockets[0]!.send(
      JSON.stringify({
        metadata: {
          message_id: messageId,
          message_type: 'notification',
          message_timestamp: new Date().toISOString(),
          subscription_type: 'channel.chat.message',
          subscription_version: '1',
        },
        payload: {
          subscription: chat.subscription,
          event: {
            ...chat.event,
            badges: [],
            message_id: `chat-${messageId}`,
            message: {
              text,
              fragments: [{ type: 'text', text, cheermote: null, emote: null, mention: null }],
            },
          },
        },
      }),
    );
  for (const id of ['m1', 'm2', 'm3', 'm4']) send(id, '!tomato');
  send('m1', '!tomato'); // EventSub redelivery: same message_id
  send('m5', 'Hi chat');
  for (let i = 0; i < 100 && effects.length < 3; i++)
    await new Promise((resolve) => setTimeout(resolve, 20));
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(effects).toHaveLength(3);
  const activity = (await app.inject({ method: 'GET', url: '/api/studio' })).json<{
    activity: { code: string | null }[];
  }>().activity;
  expect(activity.filter((a) => a.code === 'ACCEPTED')).toHaveLength(3);
  expect(activity.filter((a) => a.code === 'VIEWER_LIMIT')).toHaveLength(1);
}, 30_000);
