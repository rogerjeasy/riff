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
const TOMATO =
  'Let viewers throw tomatoes with !tomato, limited to three throws per person in any rolling 60 seconds.';
let app: RiffApp | undefined;
let server: WebSocketServer | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
  await new Promise((resolve) => (server ? server.close(resolve) : resolve(undefined)));
  server = undefined;
});

async function connect(scopes: string[]) {
  server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  const sockets: WebSocket[] = [];
  server.on('connection', (socket) => {
    sockets.push(socket);
    const welcome = fixture('session_welcome.json');
    socket.send(JSON.stringify({ metadata: welcome.metadata, payload: welcome.payload }));
  });
  await new Promise((resolve) => server!.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  const replies: Record<string, unknown>[] = [];
  const fakeFetch = async (url: string, init?: RequestInit) => {
    const reply = (body: Record<string, unknown>, status = 200) =>
      new Response(JSON.stringify({ ...body, _source: undefined }), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    if (url.endsWith('/eventsub/subscriptions') && init?.method === 'POST')
      return reply(fixture('helix.create-eventsub-subscription.json'), 202);
    if (url.endsWith('/chat/messages') && init?.method === 'POST') {
      replies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return reply(fixture('helix.send-chat-message.json'));
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
      scopes,
    }),
  });
  await app.ready();
  for (let i = 0; i < 100 && app.riff.twitch.status.state !== 'connected'; i++)
    await new Promise((resolve) => setTimeout(resolve, 20));
  const send = (
    messageId: string,
    text: string,
    chatter: { id: string; name: string; badges: { set_id: string; id: string; info: string }[] },
  ) =>
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
            chatter_user_id: chatter.id,
            chatter_user_login: chatter.name.toLowerCase(),
            chatter_user_name: chatter.name,
            badges: chatter.badges,
            message_id: `chat-${messageId}`,
            message: {
              text,
              fragments: [{ type: 'text', text, cheermote: null, emote: null, mention: null }],
            },
          },
        },
      }),
    );
  return { app, broadcaster, replies, send };
}
const enable = async (target: RiffApp) =>
  target.inject({
    method: 'POST',
    url: '/api/chat-authoring/settings',
    headers,
    payload: { enabled: true, expectedRevision: target.riff.chatAuthoring.snapshot().revision },
  });

it('authors from badge-verified EventSub chat and replies through Helix as the broadcaster', async () => {
  const { app, broadcaster, replies, send } = await connect(['user:read:chat', 'user:write:chat']);
  expect(app.riff.chatAuthoring.snapshot().replies).toMatchObject({ available: true });
  await enable(app);
  const owner = {
    id: broadcaster,
    name: 'Streamer',
    badges: [{ set_id: 'broadcaster', id: '1', info: '' }],
  };
  // A viewer named "broadcaster" with no broadcaster badge is never the owner.
  send('v1', `!riff create ${TOMATO}`, { id: '4145994', name: 'broadcaster', badges: [] });
  send('o1', `!riff create ${TOMATO}`, owner);
  for (let i = 0; i < 800 && !app.riff.chatAuthoring.snapshot().activeCode; i++)
    await new Promise((resolve) => setTimeout(resolve, 25));
  const code = app.riff.chatAuthoring.snapshot().activeCode!;
  for (let i = 0; i < 100 && replies.length < 2; i++)
    await new Promise((resolve) => setTimeout(resolve, 20));
  expect(app.riff.authoring.runs()).toHaveLength(1);
  expect(replies[0]).toEqual({
    broadcaster_id: broadcaster,
    sender_id: broadcaster,
    message: 'Riff · Compiling… I will post an approval code here if it passes verification.',
    reply_parent_message_id: 'chat-o1',
  });
  expect(replies[1]?.['message']).toBe(
    `Riff · Ready: approve with !riff approve ${code.code} (expires in 5 min). Full evidence is in your console.`,
  );
  // Riff's own reply echoes back with broadcaster badges, but is never a command.
  send('echo', String(replies[1]?.['message']), owner);
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(app.riff.chatAuthoring.snapshot().activeCode?.id).toBe(code.id);
  send('o2', `!riff approve ${code.code}`, owner);
  for (let i = 0; i < 100 && app.riff.repo.version(code.versionId)?.status !== 'active'; i++)
    await new Promise((resolve) => setTimeout(resolve, 20));
  expect(app.riff.repo.version(code.versionId)?.status).toBe('active');
}, 30_000);

it('surfaces the missing user:write:chat scope and requests it only after opt-in', async () => {
  const { app } = await connect(['user:read:chat']);
  expect(app.riff.chatAuthoring.snapshot().replies).toMatchObject({
    available: false,
    reason: 'Reconnect Twitch and approve “Send chat messages” (user:write:chat).',
  });
  const scopeOf = () =>
    new URL(app.riff.twitch.beginAuthorization()).searchParams.get('scope')?.split(' ');
  expect(scopeOf()).toEqual(['user:read:chat']);
  await enable(app);
  expect(scopeOf()).toEqual(['user:read:chat', 'user:write:chat']);
}, 30_000);
