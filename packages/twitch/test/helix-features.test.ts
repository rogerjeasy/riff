import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { TwitchError } from '../src/errors.js';
import { createHelixClient, TWITCH_FEATURE_LIMITS } from '../src/helix.js';
import { TWITCH_FEATURE_SCOPES } from '../src/auth.js';
import { fixture } from './support.js';

const TOKEN = 'user-token-should-never-leak';
const BASE = 'https://api.twitch.tv/helix';
const BROADCASTER = '141981764';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

interface Seen {
  method: string;
  url: URL;
  body: unknown;
  headers: Headers;
}
const seen: Seen[] = [];
afterEach(() => {
  seen.length = 0;
});
async function record(request: Request) {
  const text = await request.text();
  seen.push({
    method: request.method,
    url: new URL(request.url),
    body: text ? (JSON.parse(text) as unknown) : undefined,
    headers: request.headers,
  });
}

/** The documented Twitch error body with only status and message (the fields under test) changed. */
function twitchError(status: number, message: string) {
  const body = fixture('oauth.token.refresh-error.json');
  return HttpResponse.json({ ...body, status, message }, { status });
}

const client = (overrides: { maxRetries?: number } = {}) =>
  createHelixClient({
    clientId: 'fake-client-id',
    getAccessToken: () => TOKEN,
    fetch: (input, init) => globalThis.fetch(input, init),
    sleep: async () => undefined,
    random: () => 0,
    ...overrides,
  });

async function rejection(promise: Promise<unknown>): Promise<TwitchError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof TwitchError) return error;
    throw error;
  }
  throw new Error('expected a TwitchError');
}

describe('feature scopes', () => {
  it('names one documented scope per feature', () => {
    expect(TWITCH_FEATURE_SCOPES).toEqual({
      polls: ['channel:manage:polls'],
      announcements: ['moderator:manage:announcements'],
      shoutouts: ['moderator:manage:shoutouts'],
    });
  });
});

describe('Create Poll', () => {
  it('posts the documented body and parses the documented response', async () => {
    server.use(
      http.post(`${BASE}/polls`, async ({ request }) => {
        await record(request);
        return HttpResponse.json(fixture('helix.create-poll.json'));
      }),
    );
    const result = await client().createPoll({
      broadcasterId: BROADCASTER,
      title: ' Heads or Tails? ',
      choices: ['Heads', 'Tails'],
      durationSeconds: 1800,
    });
    expect(seen[0]?.body).toEqual({
      broadcaster_id: BROADCASTER,
      title: 'Heads or Tails?',
      choices: [{ title: 'Heads' }, { title: 'Tails' }],
      duration: 1800,
    });
    expect(seen[0]?.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(seen[0]?.headers.get('client-id')).toBe('fake-client-id');
    expect(result).toEqual({
      recovered: false,
      poll: {
        id: 'ed961efd-8a3f-4cf5-a9d0-e616c590cd2a',
        broadcasterId: BROADCASTER,
        title: 'Heads or Tails?',
        choices: [
          {
            id: '4c123012-1351-4f33-84b7-43856e7a0f47',
            title: 'Heads',
            votes: 0,
            channelPointsVotes: 0,
          },
          {
            id: '279087e3-54a7-467e-bcd0-c1393fcea4f0',
            title: 'Tails',
            votes: 0,
            channelPointsVotes: 0,
          },
        ],
        status: 'ACTIVE',
        durationSeconds: 1800,
        startedAt: '2021-03-19T06:08:33.871278372Z',
        endedAt: null,
      },
    });
  });

  it.each([
    ['a title over 60 characters', { title: 'x'.repeat(61) }],
    ['one choice', { choices: ['Only'] }],
    ['six choices', { choices: ['a', 'b', 'c', 'd', 'e', 'f'] }],
    ['a choice over 25 characters', { choices: ['ok', 'y'.repeat(26)] }],
    ['duplicate choices', { choices: ['Same', 'same'] }],
    ['a duration under 15 seconds', { durationSeconds: 14 }],
    ['a duration over 1800 seconds', { durationSeconds: 1801 }],
    ['control characters', { title: 'bad\u0007title' }],
  ])('refuses %s without calling Twitch', async (_name, change) => {
    const error = await rejection(
      client().createPoll({
        broadcasterId: BROADCASTER,
        title: 'Next game?',
        choices: ['A', 'B'],
        durationSeconds: 60,
        ...change,
      }),
    );
    expect(error.code).toBe('TWITCH_INVALID_REQUEST');
    expect(seen).toHaveLength(0);
  });

  it('accepts the documented bounds exactly', async () => {
    server.use(http.post(`${BASE}/polls`, () => HttpResponse.json(fixture('helix.create-poll.json'))));
    const { poll } = TWITCH_FEATURE_LIMITS;
    await expect(
      client().createPoll({
        broadcasterId: BROADCASTER,
        title: 't'.repeat(poll.titleLength),
        choices: ['a', 'b', 'c', 'd', 'c'.repeat(poll.choiceLength)],
        durationSeconds: poll.durationSeconds.min,
      }),
    ).resolves.toMatchObject({ recovered: false });
  });

  it('maps an already-running poll to a typed refusal', async () => {
    server.use(
      http.post(`${BASE}/polls`, () =>
        twitchError(
          400,
          "The broadcaster already has a poll that's running; you may not create another poll until the current poll completes.",
        ),
      ),
    );
    const error = await rejection(
      client().createPoll({
        broadcasterId: BROADCASTER,
        title: 'Next?',
        choices: ['A', 'B'],
        durationSeconds: 60,
      }),
    );
    expect(error.code).toBe('TWITCH_REJECTED');
    expect(error.detail.reason).toBe('poll_active');
    expect(error.message).toMatch(/already running/);
  });

  it('maps a missing scope (documented as 401) to a grant prompt, not a reconnect', async () => {
    server.use(
      http.post(`${BASE}/polls`, () =>
        twitchError(401, 'The user access token is missing the channel:manage:polls scope.'),
      ),
    );
    const error = await rejection(
      client().createPoll({
        broadcasterId: BROADCASTER,
        title: 'Next?',
        choices: ['A', 'B'],
        durationSeconds: 60,
      }),
    );
    expect(error.code).toBe('TWITCH_FORBIDDEN');
    expect(error.detail.reason).toBe('missing_scope');
    expect(JSON.stringify({ m: error.message, d: error.detail })).not.toContain(TOKEN);
  });

  it('never retries the mutation; a 5xx is resolved by an idempotency read', async () => {
    let posts = 0;
    server.use(
      http.post(`${BASE}/polls`, () => {
        posts++;
        return twitchError(503, 'Service Unavailable');
      }),
      http.get(`${BASE}/polls`, async ({ request }) => {
        await record(request);
        const body = fixture('helix.get-polls.json');
        return HttpResponse.json(body);
      }),
    );
    const result = await client().createPoll({
      broadcasterId: BROADCASTER,
      title: 'Heads or Tails?',
      choices: ['Heads', 'Tails'],
      durationSeconds: 60,
    });
    expect(posts).toBe(1);
    expect(result.recovered).toBe(true);
    expect(seen[0]?.url.searchParams.get('first')).toBe('1');
  });

  it('reports unavailability when the idempotency read finds no matching poll', async () => {
    let posts = 0;
    server.use(
      http.post(`${BASE}/polls`, () => {
        posts++;
        return twitchError(500, 'Internal Server Error');
      }),
      http.get(`${BASE}/polls`, () => HttpResponse.json(fixture('helix.get-polls.json'))),
    );
    const error = await rejection(
      client().createPoll({
        broadcasterId: BROADCASTER,
        title: 'Something else?',
        choices: ['Yes', 'No'],
        durationSeconds: 60,
      }),
    );
    expect(posts).toBe(1);
    expect(error.code).toBe('TWITCH_UNAVAILABLE');
  });
});

describe('Get Polls and End Poll', () => {
  it('reads polls by id and passes unknown fields', async () => {
    server.use(
      http.get(`${BASE}/polls`, async ({ request }) => {
        await record(request);
        const body = fixture('helix.get-polls.json');
        const data = body['data'] as Record<string, unknown>[];
        if (data[0]) data[0]['future_field'] = 1;
        return HttpResponse.json(body);
      }),
    );
    const polls = await client().getPolls({
      broadcasterId: BROADCASTER,
      ids: ['ed961efd-8a3f-4cf5-a9d0-e616c590cd2a'],
    });
    expect(seen[0]?.url.search).toBe(
      '?broadcaster_id=141981764&id=ed961efd-8a3f-4cf5-a9d0-e616c590cd2a',
    );
    expect(polls[0]?.status).toBe('ACTIVE');
  });

  it('fails closed on a missing required field', async () => {
    server.use(
      http.get(`${BASE}/polls`, () => {
        const body = fixture('helix.get-polls.json');
        const data = body['data'] as Record<string, unknown>[];
        if (data[0]) delete data[0]['status'];
        return HttpResponse.json(body);
      }),
    );
    const error = await rejection(client().getPolls({ broadcasterId: BROADCASTER }));
    expect(error.code).toBe('TWITCH_INVALID_RESPONSE');
    expect(error.detail.issues?.join()).toContain('data.0.status');
  });

  it('refuses more than 20 ids', async () => {
    const ids = Array.from({ length: 21 }, (_, i) => String(i));
    const error = await rejection(client().getPolls({ broadcasterId: BROADCASTER, ids }));
    expect(error.code).toBe('TWITCH_INVALID_REQUEST');
  });

  it('ends a poll with PATCH and returns its final results', async () => {
    server.use(
      http.patch(`${BASE}/polls`, async ({ request }) => {
        await record(request);
        return HttpResponse.json(fixture('helix.end-poll.json'));
      }),
    );
    const poll = await client().endPoll({
      broadcasterId: BROADCASTER,
      id: 'ed961efd-8a3f-4cf5-a9d0-e616c590cd2a',
      status: 'TERMINATED',
    });
    expect(seen[0]?.method).toBe('PATCH');
    expect(seen[0]?.body).toEqual({
      broadcaster_id: BROADCASTER,
      id: 'ed961efd-8a3f-4cf5-a9d0-e616c590cd2a',
      status: 'TERMINATED',
    });
    expect(poll).toMatchObject({ status: 'TERMINATED', endedAt: '2021-03-19T06:11:26.746889614Z' });
  });

  it('maps ending an inactive poll to poll_not_active', async () => {
    server.use(
      http.patch(`${BASE}/polls`, () =>
        twitchError(400, 'The poll must be active to terminate or archive it.'),
      ),
    );
    const error = await rejection(
      client().endPoll({ broadcasterId: BROADCASTER, id: 'x', status: 'TERMINATED' }),
    );
    expect(error.detail.reason).toBe('poll_not_active');
  });
});

describe('Send Chat Announcement', () => {
  it('sends the documented query and body and accepts 204', async () => {
    server.use(
      http.post(`${BASE}/chat/announcements`, async ({ request }) => {
        await record(request);
        return new HttpResponse(null, { status: 204 });
      }),
    );
    await client().sendChatAnnouncement({
      broadcasterId: '11111',
      moderatorId: '11111',
      message: 'Hello chat!',
      color: 'purple',
    });
    expect(seen[0]?.url.search).toBe('?broadcaster_id=11111&moderator_id=11111');
    // for_source_only is refused for user tokens, so it must never be sent.
    expect(seen[0]?.body).toEqual({ message: 'Hello chat!', color: 'purple' });
  });

  it('refuses text Twitch would truncate', async () => {
    const error = await rejection(
      client().sendChatAnnouncement({
        broadcasterId: '11111',
        moderatorId: '11111',
        message: 'x'.repeat(501),
      }),
    );
    expect(error.code).toBe('TWITCH_INVALID_REQUEST');
    expect(seen).toHaveLength(0);
  });

  it('treats 429 as a cooldown and never retries it', async () => {
    let calls = 0;
    server.use(
      http.post(`${BASE}/chat/announcements`, () => {
        calls++;
        return twitchError(
          429,
          'The sender has exceeded the number of announcements they may send to this broadcaster_id within a given window.',
        );
      }),
    );
    const error = await rejection(
      client().sendChatAnnouncement({ broadcasterId: '1', moderatorId: '1', message: 'hi' }),
    );
    expect(calls).toBe(1);
    expect(error.detail.reason).toBe('cooldown');
  });

  it('never retries after a 5xx (the announcement may already be posted)', async () => {
    let calls = 0;
    server.use(
      http.post(`${BASE}/chat/announcements`, () => {
        calls++;
        return twitchError(502, 'Bad Gateway');
      }),
    );
    const error = await rejection(
      client().sendChatAnnouncement({ broadcasterId: '1', moderatorId: '1', message: 'hi' }),
    );
    expect(calls).toBe(1);
    expect(error.code).toBe('TWITCH_UNAVAILABLE');
  });

  it('maps a failed review to content_refused', async () => {
    server.use(
      http.post(`${BASE}/chat/announcements`, () =>
        twitchError(400, 'The string in the message field failed review.'),
      ),
    );
    const error = await rejection(
      client().sendChatAnnouncement({ broadcasterId: '1', moderatorId: '1', message: 'hi' }),
    );
    expect(error.detail.reason).toBe('content_refused');
  });
});

describe('Send a Shoutout', () => {
  it('sends the documented query parameters without a body', async () => {
    server.use(
      http.post(`${BASE}/chat/shoutouts`, async ({ request }) => {
        await record(request);
        return new HttpResponse(null, { status: 204 });
      }),
    );
    await client().sendShoutout({
      fromBroadcasterId: '12345',
      toBroadcasterId: '626262',
      moderatorId: '12345',
    });
    expect(seen[0]?.url.search).toBe(
      '?from_broadcaster_id=12345&to_broadcaster_id=626262&moderator_id=12345',
    );
    expect(seen[0]?.body).toBeUndefined();
  });

  it('refuses a self shoutout locally', async () => {
    const error = await rejection(
      client().sendShoutout({ fromBroadcasterId: '1', toBroadcasterId: '1', moderatorId: '1' }),
    );
    expect(error.detail.reason).toBe('self_shoutout');
  });

  it.each([
    [400, 'The broadcaster is not streaming live or does not have one or more viewers.', 'not_live'],
    [403, "The user in moderator_id is not one of the broadcaster's moderators.", 'not_moderator'],
    [403, 'The broadcaster may not send the specified broadcaster a Shoutout.', 'target_refused'],
    [
      429,
      'The broadcaster exceeded the number of Shoutouts they may send the same broadcaster within a given window.',
      'cooldown',
    ],
    [401, 'The user access token must include the moderator:manage:shoutouts scope.', 'missing_scope'],
  ] as const)('maps %i "%s" to %s without retrying', async (status, message, reason) => {
    let calls = 0;
    server.use(
      http.post(`${BASE}/chat/shoutouts`, () => {
        calls++;
        return twitchError(status, message);
      }),
    );
    const error = await rejection(
      client().sendShoutout({ fromBroadcasterId: '1', toBroadcasterId: '2', moderatorId: '1' }),
    );
    expect(calls).toBe(1);
    expect(error.detail.reason).toBe(reason);
  });
});
