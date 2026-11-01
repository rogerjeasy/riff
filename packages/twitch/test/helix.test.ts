import { describe, expect, it } from 'vitest';
import { TwitchError } from '../src/errors.js';
import { createHelixClient, type HelixClientOptions } from '../src/helix.js';
import { TRIGGERS } from '../src/triggers.js';
import { fixture } from './support.js';

const TOKEN = 'user-token-should-never-leak';

interface Call {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
  body: unknown;
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function setup(responses: Response[], overrides: Partial<HelixClientOptions> = {}) {
  const calls: Call[] = [];
  const sleeps: number[] = [];
  const queue = [...responses];
  const client = createHelixClient({
    clientId: 'fake-client-id',
    getAccessToken: () => TOKEN,
    fetch: async (url, init) => {
      calls.push({
        url,
        method: init?.method,
        headers: init?.headers as Record<string, string>,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      });
      const next = queue.shift();
      if (!next) throw new Error('unexpected request');
      return next;
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0,
    now: () => 1_000_000_000,
    ...overrides,
  });
  return { client, calls, sleeps };
}

const subscriptionInput = {
  type: TRIGGERS['chat.message'].type,
  version: TRIGGERS['chat.message'].version,
  condition: { broadcaster_user_id: '1971641', user_id: '1971641' },
  sessionId: 'AQoQexAWVYKSTIu4ec_2VAxyuhAB',
};

async function rejection(promise: Promise<unknown>): Promise<TwitchError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof TwitchError) return error;
    throw error;
  }
  throw new Error('expected a TwitchError');
}

describe('Helix client', () => {
  it('creates a websocket EventSub subscription with the documented request shape', async () => {
    const { client, calls } = setup([
      json(fixture('helix.create-eventsub-subscription.json'), 202),
    ]);
    const result = await client.createEventSubSubscription(subscriptionInput);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      url: 'https://api.twitch.tv/helix/eventsub/subscriptions',
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Client-Id': 'fake-client-id',
        'Content-Type': 'application/json',
      },
      body: {
        type: 'channel.chat.message',
        version: '1',
        condition: { broadcaster_user_id: '1971641', user_id: '1971641' },
        transport: { method: 'websocket', session_id: 'AQoQexAWVYKSTIu4ec_2VAxyuhAB' },
      },
    });
    expect(result).toEqual({
      subscription: {
        id: '26b1c993-bfcf-44d9-b876-379dacafe75a',
        status: 'enabled',
        type: 'user.update',
        version: '1',
        condition: { user_id: '1234' },
        createdAt: '2020-11-10T14:32:18.730260295Z',
        transport: { method: 'websocket', sessionId: 'AgoQD6Q1d5Q6TpaD6JknqX2a0hIGY2VsbC1z' },
        cost: 1,
      },
      total: 1,
      totalCost: 1,
      maxTotalCost: 10000,
    });
  });

  it('targets the Twitch CLI mock server when baseUrl is overridden', async () => {
    const { client, calls } = setup(
      [json(fixture('helix.create-eventsub-subscription.json'), 202)],
      {
        baseUrl: 'http://127.0.0.1:8080/',
      },
    );
    await client.createEventSubSubscription(subscriptionInput);
    expect(calls[0]?.url).toBe('http://127.0.0.1:8080/eventsub/subscriptions');
  });

  it('retries 429 after the Ratelimit-Reset time', async () => {
    const { client, calls, sleeps } = setup([
      json({ error: 'Too Many Requests', status: 429, message: '' }, 429, {
        'Ratelimit-Reset': String(1_000_000_000 / 1000 + 5),
      }),
      json(fixture('helix.get-users.json')),
    ]);
    const users = await client.getUsers({ ids: ['141981764'] });
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([5000]);
    expect(users[0]).toMatchObject({
      id: '141981764',
      login: 'twitchdev',
      displayName: 'TwitchDev',
    });
  });

  it('gives up instead of sleeping past maxDelayMs for a far Ratelimit-Reset', async () => {
    const { client, sleeps } = setup(
      [json({}, 429, { 'Ratelimit-Reset': String(1_000_000_000 / 1000 + 3600) })],
      { maxDelayMs: 30_000 },
    );
    const error = await rejection(client.getUsers({ ids: ['1'] }));
    expect(error.code).toBe('TWITCH_UNAVAILABLE');
    expect(error.detail.retryAfterMs).toBe(3_600_000);
    expect(sleeps).toEqual([]);
  });

  it('retries 5xx with jittered exponential backoff, then reports TWITCH_UNAVAILABLE', async () => {
    const { client, calls, sleeps } = setup(
      [json({}, 500), json({}, 502), json({}, 503), json({}, 503)],
      { random: () => 0.5 },
    );
    const error = await rejection(client.createEventSubSubscription(subscriptionInput));
    expect(calls).toHaveLength(4);
    // base 500: 2^n * 500 jittered into [half, full] with random 0.5.
    expect(sleeps).toEqual([375, 750, 1500]);
    expect(error.code).toBe('TWITCH_UNAVAILABLE');
    expect(error.detail).toMatchObject({ status: 503, attempts: 4 });
  });

  it('recovers when a retry succeeds', async () => {
    const { client, calls } = setup([json({}, 503), json(fixture('helix.get-users.json'))]);
    await expect(client.getUsers({ logins: ['twitchdev'] })).resolves.toHaveLength(1);
    expect(calls).toHaveLength(2);
  });

  it.each([
    [400, 'TWITCH_REJECTED'],
    [401, 'TWITCH_UNAUTHORIZED'],
    [403, 'TWITCH_FORBIDDEN'],
    [409, 'TWITCH_REJECTED'],
    [410, 'TWITCH_REJECTED'],
  ] as const)('never retries %i', async (status, code) => {
    const { client, calls, sleeps } = setup([
      json({ error: 'x', status, message: 'The access token is not valid.' }, status),
    ]);
    const error = await rejection(client.createEventSubSubscription(subscriptionInput));
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
    expect(error.code).toBe(code);
    expect(error.detail).toMatchObject({ status, twitchMessage: 'The access token is not valid.' });
    expect(JSON.stringify({ message: error.message, detail: error.detail })).not.toContain(TOKEN);
  });

  it('does not retry network failures (a mutation may already have applied)', async () => {
    const client = createHelixClient({
      clientId: 'id',
      getAccessToken: () => TOKEN,
      fetch: () => Promise.reject(new Error(`socket hang up ${TOKEN}`)),
    });
    const error = await rejection(client.createEventSubSubscription(subscriptionInput));
    expect(error.code).toBe('TWITCH_UNAVAILABLE');
    expect(error.message + JSON.stringify(error.detail)).not.toContain(TOKEN);
  });

  it('builds repeated id/login query parameters for Get Users', async () => {
    const { client, calls } = setup([json(fixture('helix.get-users.json'))]);
    await client.getUsers({ ids: ['1', '2'], logins: ['a b'] });
    expect(calls[0]?.url).toBe('https://api.twitch.tv/helix/users?id=1&id=2&login=a+b');
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.headers['Content-Type']).toBeUndefined();
  });

  it('refuses more than 100 users without calling Twitch', async () => {
    const { client, calls } = setup([]);
    const ids = Array.from({ length: 60 }, (_, i) => String(i));
    const error = await rejection(client.getUsers({ ids, logins: ids }));
    expect(error.code).toBe('TWITCH_INVALID_REQUEST');
    expect(calls).toHaveLength(0);
  });

  it('allows unknown response fields but fails on missing required ones', async () => {
    const users = fixture('helix.get-users.json');
    const firstUser = (body: Record<string, unknown>): Record<string, unknown> => {
      const [user] = body['data'] as Record<string, unknown>[];
      if (!user) throw new Error('fixture has no user');
      return user;
    };
    const withExtra = structuredClone(users);
    firstUser(withExtra)['future_field'] = true;
    const missing = structuredClone(users);
    delete firstUser(missing)['login'];
    const { client } = setup([json(withExtra), json(missing)]);
    await expect(client.getUsers({ ids: ['141981764'] })).resolves.toHaveLength(1);
    const error = await rejection(client.getUsers({ ids: ['141981764'] }));
    expect(error.code).toBe('TWITCH_INVALID_RESPONSE');
    expect(error.detail.issues?.join()).toContain('data.0.login');
  });
});

describe('Helix Send Chat Message', () => {
  it('posts the documented body as the token user and parses the sent result', async () => {
    const { client, calls } = setup([json(fixture('helix.send-chat-message.json'))]);
    const result = await client.sendChatMessage({
      broadcasterId: '12826',
      senderId: '12826',
      message: 'Riff · Compiling…',
      replyParentMessageId: 'parent-1',
    });
    expect(result).toEqual({ messageId: 'abc-123-def', isSent: true, dropReason: null });
    expect(calls[0]).toEqual({
      url: 'https://api.twitch.tv/helix/chat/messages',
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Client-Id': 'fake-client-id',
        'Content-Type': 'application/json',
      },
      // for_source_only is rejected with a user access token, so it is never sent.
      body: {
        broadcaster_id: '12826',
        sender_id: '12826',
        message: 'Riff · Compiling…',
        reply_parent_message_id: 'parent-1',
      },
    });
  });

  it('reports a dropped message with its documented reason', async () => {
    const dropped = structuredClone(fixture('helix.send-chat-message.json'));
    const [row] = dropped['data'] as Record<string, unknown>[];
    row!['is_sent'] = false;
    row!['drop_reason'] = { code: 'msg_rejected', message: 'held for review' };
    const { client } = setup([json(dropped)]);
    await expect(
      client.sendChatMessage({ broadcasterId: '1', senderId: '1', message: 'Riff · hi' }),
    ).resolves.toEqual({
      messageId: 'abc-123-def',
      isSent: false,
      dropReason: { code: 'msg_rejected', message: 'held for review' },
    });
  });

  it('never retries a chat mutation after a server error and refuses oversized text', async () => {
    const { client, calls } = setup([json({ message: 'boom' }, 503), json({}, 200)]);
    const error = await rejection(
      client.sendChatMessage({ broadcasterId: '1', senderId: '1', message: 'Riff · hi' }),
    );
    expect(error.code).toBe('TWITCH_UNAVAILABLE');
    expect(calls).toHaveLength(1);
    const long = await rejection(
      client.sendChatMessage({ broadcasterId: '1', senderId: '1', message: 'x'.repeat(501) }),
    );
    expect(long.code).toBe('TWITCH_INVALID_REQUEST');
    expect(calls).toHaveLength(1);
  });
});
