import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import type { PermissionManifest } from '@riff/sdk';
import { createApp, type RiffApp } from '../src/app.js';
import { createSealer } from '../src/services/auth/secrets.js';
import { ECHO_WINDOW_MS } from '../src/services/twitch/echo-ledger.js';
import { ECHO_ACTIVITY_INTERVAL_MS, type LiveChatMessage } from '../src/services/live/runtime.js';

const fixture = (name: string) =>
  JSON.parse(
    readFileSync(new URL(`../../../packages/twitch/fixtures/${name}`, import.meta.url), 'utf8'),
  ) as Record<string, unknown> & {
    event: Record<string, unknown>;
    subscription: Record<string, unknown>;
    payload: { session: Record<string, unknown> };
    metadata: unknown;
    data: Record<string, unknown>[];
  };
const SECRET = 'x'.repeat(43); // Deterministic test data, never a credential.
const headers = { 'x-riff-request': '1' };
const chatFixture = fixture('channel.chat.message.json');
const BROADCASTER = String(chatFixture.event.broadcaster_user_id);
const SENT_ID = String(fixture('helix.send-chat-message.json').data[0]!['message_id']);
const OWNER_BADGES = [{ set_id: 'broadcaster', id: '1', info: '' }];
const clock = { at: Date.parse('2026-11-02T20:00:00Z') };

let app: RiffApp | undefined;
let server: WebSocketServer | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
  await new Promise((resolve) => (server ? server.close(resolve) : resolve(undefined)));
  server = undefined;
});
const until = async (done: () => boolean, tries = 150) => {
  for (let i = 0; i < tries && !done(); i++)
    await new Promise((resolve) => setTimeout(resolve, 20));
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 200));

/** Boot the app against a local stand-in for the EventSub WebSocket and a fake Helix. */
async function connect() {
  server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  const sockets: WebSocket[] = [];
  server.on('connection', (socket) => {
    sockets.push(socket);
    const welcome = fixture('session_welcome.json');
    socket.send(JSON.stringify({ metadata: welcome.metadata, payload: welcome.payload }));
  });
  await new Promise((resolve) => server!.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  const sent: { url: string; body: Record<string, unknown> }[] = [];
  const fakeFetch = async (url: string, init?: RequestInit) => {
    const reply = (body: Record<string, unknown>, status = 200) =>
      new Response(JSON.stringify({ ...body, _source: undefined }), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    if (url.endsWith('/eventsub/subscriptions') && init?.method === 'POST')
      return reply(fixture('helix.create-eventsub-subscription.json'), 202);
    if (url.endsWith('/chat/messages') && init?.method === 'POST') {
      sent.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
      return reply(fixture('helix.send-chat-message.json'));
    }
    // Send Chat Announcement: "204 No Content", "Response Body None".
    if (url.includes('/chat/announcements') && init?.method === 'POST') {
      sent.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
      return new Response(null, { status: 204 });
    }
    return new Response('{}', { status: 404 });
  };
  app = await createApp({
    logger: false,
    secret: SECRET,
    now: () => clock.at,
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
    twitchLogin: 'streamer',
    twitchTokens: createSealer(SECRET).seal({
      accessToken: 'token',
      refreshToken: 'refresh',
      expiresAt: Date.now() + 3_600_000,
      scopes: ['user:read:chat', 'user:write:chat', 'moderator:manage:announcements'],
    }),
  });
  await app.ready();
  await until(() => app!.riff.twitch.status.state === 'connected');
  let n = 0;
  /** A documented `channel.chat.message` notification typed by the broadcaster. */
  const typed = (text: string, messageId = `chat-${++n}`) =>
    sockets[0]!.send(
      JSON.stringify({
        metadata: {
          message_id: `envelope-${++n}`,
          message_type: 'notification',
          message_timestamp: new Date().toISOString(),
          subscription_type: 'channel.chat.message',
          subscription_version: '1',
        },
        payload: {
          subscription: chatFixture.subscription,
          event: {
            ...chatFixture.event,
            chatter_user_id: BROADCASTER,
            chatter_user_login: 'streamer',
            chatter_user_name: 'streamer',
            badges: OWNER_BADGES,
            message_id: messageId,
            message: {
              text,
              fragments: [{ type: 'text', text, cheermote: null, emote: null, mention: null }],
            },
          },
        },
      }),
    );
  return { app, sent, typed };
}

function install(target: RiffApp, source: string, manifest: PermissionManifest) {
  const automation = target.riff.repo.createAutomation('Loop bait');
  const version = target.riff.repo.insertVersion({
    automationId: automation.id,
    parentVersionId: null,
    artifactId: null,
    title: 'Loop bait',
    intent: 'Loop bait',
    source,
    manifest,
    tests: [],
    behavior: {},
    assumptions: [],
    evidence: {},
    origin: 'manual',
    compileRunId: null,
    status: 'candidate',
  });
  target.riff.repo.activate(automation.id, version.id);
  target.riff.runtime.activate(automation.id, target.riff.repo.version(version.id)!);
  return automation.id;
}
const tomato: PermissionManifest = {
  sdkVersion: '0.4.0',
  capabilities: ['overlay'],
  trigger: { command: '!tomato', audience: ['viewer'], maxPerViewer: 20, windowMs: 60_000 },
  limits: { effectsPerEvent: 1, effectsPerMinute: 60 },
};
const throwTomato = `async (event, riff) => {
  await riff.overlay.emit({ kind: 'projectile', asset: 'tomato', x: 0.5 });
}`;
const echoes = (target: RiffApp) =>
  target.riff.repo.activity(100).filter((a) => a.code === 'ECHO_SUPPRESSED');
const accepted = (target: RiffApp) =>
  target.riff.repo.activity(100).filter((a) => a.code === 'ACCEPTED');

describe('F11 bot-loop suppression', () => {
  it('drops an announcement echo carrying a live command, but not the broadcaster typing it later', async () => {
    const { app, sent, typed } = await connect();
    install(app, throwTomato, tomato);
    const deliver = vi.spyOn(app.riff.overlay, 'deliver');
    const announced = await app.inject({
      method: 'POST',
      url: '/api/twitch/announcements',
      headers,
      payload: { message: '!tomato' },
    });
    expect(announced.statusCode).toBe(200);
    expect(sent.filter((s) => s.url.includes('/chat/announcements'))).toHaveLength(1);
    // Twitch shows the announcement in chat as the broadcaster's line.
    typed('!tomato');
    await until(() => echoes(app).length > 0);
    await settle();
    expect(deliver).not.toHaveBeenCalled();
    expect(accepted(app)).toHaveLength(0);
    expect(echoes(app)).toMatchObject([
      { kind: 'system', viewer: 'streamer', message: expect.stringContaining('announcement') },
    ]);
    // The same text typed by the broadcaster outside the window is a genuine command.
    clock.at += ECHO_WINDOW_MS + 1;
    typed('!tomato');
    await until(() => accepted(app).length > 0);
    expect(accepted(app)).toHaveLength(1);
  }, 30_000);

  it('drops a Send Chat Message echo by its returned message_id and notes echoes at most once a minute', async () => {
    const { app, sent, typed } = await connect();
    install(app, throwTomato, tomato);
    await app.riff.twitch.sendChat('Riff · Throw with !tomato');
    expect(sent[0]?.body).toMatchObject({ sender_id: BROADCASTER });
    // Matched by id even if Twitch altered the visible text.
    typed('!tomato', SENT_ID);
    await app.riff.twitch.sendChat('Riff · second');
    typed('Riff · second', SENT_ID);
    await until(() => echoes(app).length > 0);
    await settle();
    expect(accepted(app)).toHaveLength(0);
    expect(echoes(app)).toHaveLength(1);
    clock.at += ECHO_ACTIVITY_INTERVAL_MS;
    await app.riff.twitch.sendChat('Riff · third');
    typed('Riff · third', SENT_ID);
    await until(() => echoes(app).length > 1);
    expect(echoes(app)[0]?.message).toContain('1 more since the last note');
  }, 30_000);

  it('a timer-fired announcement of its own trigger command does not re-trigger itself', async () => {
    const { app, sent, typed } = await connect();
    const automationId = install(
      app,
      `async (event, riff) => {
        if (event.source === 'timer.fired') {
          await riff.chat.announce({ message: '!hydrate' });
          return;
        }
        await riff.timer.start('sip', 5000);
      }`,
      {
        sdkVersion: '0.4.0',
        capabilities: ['chat.announce', 'timer'],
        trigger: { command: '!hydrate', audience: ['viewer'], maxPerViewer: 20, windowMs: 60_000 },
        limits: { effectsPerEvent: 2, effectsPerMinute: 60 },
      },
    );
    typed('!hydrate');
    await until(() => app.riff.runtime.timers(automationId).length > 0);
    expect(app.riff.runtime.timers(automationId)).toHaveLength(1);
    clock.at += 5_000;
    await app.riff.runtime.tick();
    const announcements = () => sent.filter((s) => s.url.includes('/chat/announcements'));
    await until(() => announcements().length > 0);
    expect(announcements()[0]?.body).toMatchObject({ message: '!hydrate' });
    expect(app.riff.runtime.timers(automationId)).toHaveLength(0);
    // The announcement comes back over EventSub as the broadcaster's "!hydrate".
    typed('!hydrate');
    await until(() => echoes(app).length > 0);
    await settle();
    expect(app.riff.runtime.timers(automationId)).toHaveLength(0);
    clock.at += 60_000;
    await app.riff.runtime.tick();
    await settle();
    expect(announcements()).toHaveLength(1);
  }, 30_000);

  it('chat carrying hop metadata never reaches authoring, help, proposals or dispatch', async () => {
    const { app } = await connect();
    install(app, throwTomato, tomato);
    const message = (text: string): LiveChatMessage => ({
      id: `hop-${text}`,
      channelId: BROADCASTER,
      viewerId: BROADCASTER,
      viewerName: 'streamer',
      roles: ['viewer', 'broadcaster'],
      text,
      source: 'twitch',
      causal: { hop: 1, origin: 'announcement' },
    });
    for (const text of ['!tomato', '!riff help', '!riff create a confetti cannon', '!suggest x'])
      expect(await app.riff.runtime.handleChat(message(text))).toEqual([]);
    expect(accepted(app)).toHaveLength(0);
    expect(app.riff.authoring.runs()).toHaveLength(0);
    // Panic stays fail-safe: it is never suppressed.
    await app.riff.runtime.handleChat(message('!riff panic'));
    expect(app.riff.runtime.panicked).toBe(true);
  }, 30_000);
});
