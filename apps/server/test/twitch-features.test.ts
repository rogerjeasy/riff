import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { TwitchError, type HelixPoll } from '@riff/twitch';
import { openDatabase } from '../src/db/client.js';
import { forChannel } from '../src/db/repositories/studio.js';
import { twitchFeaturesRepository } from '../src/db/repositories/twitch-features.js';
import { createApp, migrateConnection, type RiffApp } from '../src/app.js';
import { createSealer } from '../src/services/auth/secrets.js';
import {
  createTwitchFeatureService,
  type HelixPort,
} from '../src/services/twitch-features/service.js';
import { RiffError } from '../src/services/twitch-features/errors.js';

const fixture = (name: string) => {
  const raw = JSON.parse(
    readFileSync(new URL(`../../../packages/twitch/fixtures/${name}`, import.meta.url), 'utf8'),
  ) as Record<string, unknown>;
  delete raw['_source'];
  return raw;
};
const docPoll = (name: string): Record<string, unknown> =>
  (fixture(name)['data'] as Record<string, unknown>[])[0]!;
const docUser = (fixture('helix.get-users.json')['data'] as Record<string, unknown>[])[0]!;

const BROADCASTER = '141981764';
const ALL_SCOPES = [
  'user:read:chat',
  'channel:manage:polls',
  'moderator:manage:announcements',
  'moderator:manage:shoutouts',
];
const toPoll = (raw: Record<string, unknown>, change: Partial<HelixPoll> = {}): HelixPoll => ({
  id: String(raw['id']),
  broadcasterId: BROADCASTER,
  title: String(raw['title']),
  choices: (raw['choices'] as { id: string; title: string; votes: number }[]).map((c) => ({
    id: c.id,
    title: c.title,
    votes: c.votes,
    channelPointsVotes: 0,
  })),
  status: raw['status'] as HelixPoll['status'],
  durationSeconds: Number(raw['duration']),
  startedAt: new Date(clock.now).toISOString(),
  endedAt: (raw['ended_at'] as string | undefined) ?? null,
  ...change,
});
const clock = { now: Date.parse('2026-11-01T20:00:00Z') };

function fakeHelix(overrides: Partial<HelixPort> = {}) {
  const calls: { method: string; input: unknown }[] = [];
  const helix: HelixPort = {
    async getUsers(query) {
      calls.push({ method: 'getUsers', input: query });
      if (query.ids?.includes(BROADCASTER))
        return [{ ...userOf(docUser), id: BROADCASTER, broadcasterType: 'affiliate' }];
      return (query.logins ?? [])
        .filter((l) => l !== 'ghost')
        .map((login, i) => ({
          ...userOf(docUser),
          id: String(900 + i),
          login,
          displayName: login,
        }));
    },
    async createPoll(input) {
      calls.push({ method: 'createPoll', input });
      return {
        poll: toPoll(docPoll('helix.create-poll.json'), {
          title: input.title,
          durationSeconds: input.durationSeconds,
        }),
        recovered: false,
      };
    },
    async getPolls(query) {
      calls.push({ method: 'getPolls', input: query });
      return [toPoll(docPoll('helix.get-polls.json'))];
    },
    async endPoll(input) {
      calls.push({ method: 'endPoll', input });
      return toPoll(docPoll('helix.end-poll.json'));
    },
    async sendChatAnnouncement(input) {
      calls.push({ method: 'sendChatAnnouncement', input });
    },
    async sendShoutout(input) {
      calls.push({ method: 'sendShoutout', input });
    },
    ...overrides,
  };
  return { helix, calls };
}
function userOf(raw: Record<string, unknown>) {
  return {
    id: String(raw['id']),
    login: String(raw['login']),
    displayName: String(raw['display_name']),
    type: '',
    broadcasterType: String(raw['broadcaster_type']),
    description: '',
    profileImageUrl: '',
    offlineImageUrl: '',
    createdAt: String(raw['created_at']),
  };
}

function setup(
  options: {
    scopes?: string[];
    helix?: Partial<HelixPort>;
    connected?: boolean;
    blocked?: () => boolean;
  } = {},
) {
  const database = openDatabase(':memory:');
  migrateConnection(database);
  forChannel(database, 'home').ensure('Home');
  const { helix, calls } = fakeHelix(options.helix);
  const activity: { kind: string; code: string; automationId: string | null }[] = [];
  const disabled: string[] = [];
  const scopes = options.scopes ?? ALL_SCOPES;
  const connected = options.connected ?? true;
  const service = createTwitchFeatureService({
    storage: twitchFeaturesRepository(database, 'home'),
    connection: {
      identity: () => (connected ? { userId: BROADCASTER, login: 'streamer' } : null),
      grantedScopes: () => scopes,
      helix: () => (connected ? helix : null),
    },
    blocked: options.blocked ?? (() => false),
    automations: () => [
      { automationId: 'auto-1', title: 'Channel Poll', capabilities: ['polls'], live: true },
    ],
    record: (entry) => activity.push(entry),
    disable: (id) => disabled.push(id),
    changed: () => undefined,
    now: () => clock.now,
  });
  return { service, calls, activity, disabled, database };
}
const poll = { title: 'Next game?', choices: ['Speedrun', 'Hardcore'], durationSeconds: 120 };
async function code(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (error instanceof RiffError) return error.code;
    throw error;
  }
  return 'OK';
}
afterEach(() => {
  clock.now = Date.parse('2026-11-01T20:00:00Z');
});

describe('feature consent and eligibility', () => {
  it('reports each feature separately: connection, grant, eligibility and readiness', async () => {
    expect(
      setup({ connected: false })
        .service.snapshot()
        .features.map((f) => f.state),
    ).toEqual(['not-connected', 'not-connected', 'not-connected']);
    const partial = setup({ scopes: ['user:read:chat', 'moderator:manage:announcements'] });
    expect(partial.service.snapshot().features.map((f) => [f.feature, f.state])).toEqual([
      ['polls', 'needs-grant'],
      ['announcements', 'ready'],
      ['shoutouts', 'needs-grant'],
    ]);
    expect(await code(partial.service.startPoll(poll))).toBe('SCOPE_MISSING');
    expect(partial.calls).toEqual([]);
    const full = setup();
    expect(full.service.snapshot().features[0]).toMatchObject({
      state: 'checking',
      capability: 'polls',
      scope: 'channel:manage:polls',
      usedBy: [{ automationId: 'auto-1', title: 'Channel Poll', live: true }],
    });
    await full.service.refreshEligibility();
    expect(full.service.snapshot().features[0]?.state).toBe('ready');
  });

  it('refuses polls on channels that are not Affiliates or Partners before calling Twitch', async () => {
    const { service, calls } = setup({
      helix: {
        async getUsers() {
          return [{ ...userOf(docUser), id: BROADCASTER, broadcasterType: '' }];
        },
      },
    });
    expect(await code(service.startPoll(poll))).toBe('NOT_ELIGIBLE');
    expect(service.snapshot().features[0]).toMatchObject({ state: 'ineligible' });
    expect(calls.filter((c) => c.method === 'createPoll')).toEqual([]);
  });

  it('lets the creator turn a granted feature off without revoking the grant', async () => {
    const { service, calls } = setup();
    await service.setFeature('announcements', false);
    expect(service.snapshot().features[1]?.state).toBe('disabled');
    expect(await code(service.announce({ message: 'hi', color: 'primary' }))).toBe(
      'FEATURE_DISABLED',
    );
    await service.setFeature('announcements', true);
    expect(await code(service.announce({ message: 'hi', color: 'primary' }))).toBe('OK');
    expect(calls.filter((c) => c.method === 'sendChatAnnouncement')).toHaveLength(1);
  });
});

describe('polls', () => {
  it('starts one poll at a time, refreshes live results and ends it early', async () => {
    const { service, calls } = setup();
    await service.startPoll(poll);
    expect(calls.find((c) => c.method === 'createPoll')?.input).toEqual({
      broadcasterId: BROADCASTER,
      ...poll,
    });
    expect(service.snapshot().poll).toMatchObject({ status: 'ACTIVE', origin: 'manual' });
    expect(await code(service.startPoll(poll))).toBe('POLL_ACTIVE');
    clock.now += 6000;
    await service.tick();
    expect(calls.find((c) => c.method === 'getPolls')?.input).toMatchObject({
      ids: ['ed961efd-8a3f-4cf5-a9d0-e616c590cd2a'],
    });
    await service.endPoll();
    expect(calls.find((c) => c.method === 'endPoll')?.input).toMatchObject({
      status: 'TERMINATED',
    });
    expect(service.snapshot().poll?.status).toBe('TERMINATED');
    expect(await code(service.endPoll())).toBe('NO_ACTIVE_POLL');
  });

  it('maps Twitch refusals to typed errors and records them in history', async () => {
    const { service } = setup({
      helix: {
        async createPoll() {
          throw new TwitchError('TWITCH_REJECTED', 'A poll is already running on this channel.', {
            endpoint: 'POST /polls',
            status: 400,
            reason: 'poll_active',
          });
        },
      },
    });
    expect(await code(service.startPoll(poll))).toBe('POLL_ACTIVE');
    expect(service.snapshot().history[0]).toMatchObject({
      kind: 'poll.start',
      outcome: 'refused',
      code: 'POLL_ACTIVE',
    });
  });

  it('enforces the hourly channel poll budget', async () => {
    const { service } = setup();
    for (let i = 0; i < 12; i++) {
      await service.startPoll({ ...poll, durationSeconds: 15 });
      clock.now += 16_000;
    }
    expect(await code(service.startPoll(poll))).toBe('LIMIT_EXCEEDED');
  });
});

describe('announcements', () => {
  it('applies the 2-second Twitch interval and the per-minute channel budget', async () => {
    const { service, calls } = setup();
    expect(await code(service.announce({ message: 'one', color: 'purple' }))).toBe('OK');
    expect(await code(service.announce({ message: 'two', color: 'purple' }))).toBe('COOLDOWN');
    for (let i = 0; i < 5; i++) {
      clock.now += 2000;
      expect(await code(service.announce({ message: `m${i}`, color: 'blue' }))).toBe('OK');
    }
    clock.now += 2000;
    expect(await code(service.announce({ message: 'over', color: 'blue' }))).toBe('LIMIT_EXCEEDED');
    expect(calls.filter((c) => c.method === 'sendChatAnnouncement')).toHaveLength(6);
    expect(calls[0]?.input).toEqual({
      broadcasterId: BROADCASTER,
      moderatorId: BROADCASTER,
      message: 'one',
      color: 'purple',
    });
  });

  it('spends budget on an ambiguous failure because the message may have posted', async () => {
    const { service } = setup({
      helix: {
        async sendChatAnnouncement() {
          throw new TwitchError('TWITCH_UNAVAILABLE', 'Could not reach Twitch.');
        },
      },
    });
    expect(await code(service.announce({ message: 'hi', color: 'primary' }))).toBe(
      'TWITCH_UNAVAILABLE',
    );
    expect(service.snapshot().budgets.announcements.used).toBe(1);
  });
});

describe('shoutouts', () => {
  it('requires an approved target policy and resolves logins to stable ids', async () => {
    const { service, calls } = setup();
    expect(await code(service.shoutout('twitchdev'))).toBe('POLICY_DENIED');
    expect(await code(service.setShoutoutPolicy('allowlist', ['ghost']))).toBe('INVALID_REQUEST');
    expect(await code(service.setShoutoutPolicy('allowlist', ['streamer']))).toBe(
      'INVALID_REQUEST',
    );
    await service.setShoutoutPolicy('allowlist', ['TwitchDev']);
    expect(service.snapshot().shoutout.allowlist).toEqual([
      { id: '900', login: 'twitchdev', displayName: 'twitchdev' },
    ]);
    expect(await code(service.shoutout('someoneelse'))).toBe('POLICY_DENIED');
    expect(await code(service.shoutout('twitchdev'))).toBe('OK');
    expect(calls.find((c) => c.method === 'sendShoutout')?.input).toEqual({
      fromBroadcasterId: BROADCASTER,
      toBroadcasterId: '900',
      moderatorId: BROADCASTER,
    });
  });

  it('applies Twitch cooldowns: 2 minutes globally and 60 minutes per target', async () => {
    const { service } = setup();
    await service.setShoutoutPolicy('allowlist', ['alpha', 'beta']);
    expect(await code(service.shoutout('alpha'))).toBe('OK');
    clock.now += 60_000;
    expect(await code(service.shoutout('beta'))).toBe('COOLDOWN');
    clock.now += 61_000;
    expect(await code(service.shoutout('alpha'))).toBe('COOLDOWN');
    expect(await code(service.shoutout('beta'))).toBe('OK');
    expect(service.snapshot().shoutout.availableAt).toBe(clock.now + 120_000);
  });

  it('does not consume the cooldown when Twitch definitely refused', async () => {
    let attempts = 0;
    const { service } = setup({
      helix: {
        async sendShoutout() {
          attempts++;
          if (attempts === 1)
            throw new TwitchError('TWITCH_REJECTED', 'Shoutouts work only while you are live.', {
              endpoint: 'POST /chat/shoutouts',
              status: 400,
              reason: 'not_live',
            });
        },
      },
    });
    await service.setShoutoutPolicy('allowlist', ['alpha']);
    expect(await code(service.shoutout('alpha'))).toBe('TWITCH_REJECTED');
    expect(await code(service.shoutout('alpha'))).toBe('OK');
  });

  it('“raiders only” accepts only channels that raided within the hour', async () => {
    const { service } = setup();
    await service.setShoutoutPolicy('raiders', []);
    expect(await code(service.shoutout('raider'))).toBe('POLICY_DENIED');
    await service.recordRaid({ id: '777', login: 'Raider', displayName: 'Raider' });
    expect(await code(service.shoutout('raider'))).toBe('OK');
    clock.now += 61 * 60_000;
    expect(service.snapshot().shoutout.raiders).toEqual([]);
  });
});

describe('automation dispatch and panic', () => {
  it('executes staged actions in order and disables the automation that overruns a budget', async () => {
    const { service, activity, disabled } = setup();
    for (let i = 0; i < 6; i++) {
      await service.dispatch([{ kind: 'announce', message: `hype ${i}`, color: 'primary' }], {
        automationId: 'auto-1',
        viewer: 'ada',
      });
      clock.now += 2500;
    }
    await service.dispatch([{ kind: 'announce', message: 'too many', color: 'primary' }], {
      automationId: 'auto-1',
      viewer: 'ada',
    });
    expect(disabled).toEqual(['auto-1']);
    expect(activity.at(-1)).toMatchObject({ kind: 'incident', code: 'LIMIT_EXCEEDED' });
    expect(service.snapshot().history[0]).toMatchObject({
      origin: 'automation',
      outcome: 'refused',
    });
  });

  it('one automation cannot end a poll another automation started', async () => {
    const { service } = setup();
    await service.dispatch(
      [{ kind: 'poll.start', title: 'Next?', choices: ['A', 'B'], durationSeconds: 60 }],
      { automationId: 'auto-a', viewer: 'owner' },
    );
    expect(service.snapshot().poll).toMatchObject({ origin: 'automation', automationId: 'auto-a' });
    await service.dispatch([{ kind: 'poll.end' }], { automationId: 'auto-b', viewer: 'owner' });
    expect(service.snapshot().poll?.status).toBe('ACTIVE');
    expect(service.snapshot().history[0]).toMatchObject({ code: 'POLICY_DENIED' });
    await service.dispatch([{ kind: 'poll.end' }], { automationId: 'auto-a', viewer: 'owner' });
    expect(service.snapshot().poll?.status).toBe('TERMINATED');
  });

  it('automations may end only polls they started', async () => {
    const { service } = setup();
    await service.startPoll(poll);
    await service.dispatch([{ kind: 'poll.end' }], { automationId: 'auto-1', viewer: 'mod' });
    expect(service.snapshot().poll?.status).toBe('ACTIVE');
    expect(service.snapshot().history[0]).toMatchObject({ code: 'POLICY_DENIED' });
  });

  it('panic fences queued actions, ends the active poll and blocks manual actions', async () => {
    let stopped = false;
    const { service, calls } = setup({ blocked: () => stopped });
    await service.startPoll(poll);
    stopped = true;
    const queued = service.dispatch([{ kind: 'announce', message: 'late', color: 'primary' }], {
      automationId: 'auto-1',
      viewer: 'ada',
    });
    await service.panic();
    await queued;
    expect(calls.filter((c) => c.method === 'sendChatAnnouncement')).toEqual([]);
    expect(calls.find((c) => c.method === 'endPoll')?.input).toMatchObject({
      status: 'TERMINATED',
    });
    expect(service.snapshot().history[0]).toMatchObject({ kind: 'poll.end', origin: 'panic' });
    expect(await code(service.announce({ message: 'hi', color: 'primary' }))).toBe('STOPPED');
  });

  it('survives restart: budgets and cooldowns come from the durable row', async () => {
    const first = setup();
    await first.service.announce({ message: 'one', color: 'primary' });
    const again = createTwitchFeatureService({
      storage: twitchFeaturesRepository(first.database, 'home'),
      connection: {
        identity: () => ({ userId: BROADCASTER, login: 'streamer' }),
        grantedScopes: () => ALL_SCOPES,
        helix: () => fakeHelix().helix,
      },
      blocked: () => false,
      automations: () => [],
      record: () => undefined,
      disable: () => undefined,
      changed: () => undefined,
      now: () => clock.now,
    });
    expect(await code(again.announce({ message: 'two', color: 'primary' }))).toBe('COOLDOWN');
  });
});

describe('routes and live automation', () => {
  let app: RiffApp | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });
  const SECRET = 'x'.repeat(43); // Deterministic test data, never a credential.
  const headers = { 'x-riff-request': '1' };

  it('validates bodies, requires the mutation header and explains disconnected state', async () => {
    app = await createApp({ logger: false });
    const status = await app.inject({ method: 'GET', url: '/api/twitch/features' });
    expect(status.json().features.features[0]).toMatchObject({ state: 'not-connected' });
    expect(
      (await app.inject({ method: 'POST', url: '/api/twitch/polls', payload: poll })).statusCode,
    ).toBe(403);
    const invalid = await app.inject({
      method: 'POST',
      url: '/api/twitch/polls',
      headers,
      payload: { ...poll, choices: ['only one'] },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().code).toBe('INVALID_REQUEST');
    const disconnected = await app.inject({
      method: 'POST',
      url: '/api/twitch/polls',
      headers,
      payload: poll,
    });
    expect(disconnected.statusCode).toBe(409);
    expect(disconnected.json()).toEqual({
      code: 'NOT_CONNECTED',
      message: 'Connect Twitch first.',
    });
  });

  it('requests each feature scope separately on top of existing grants', async () => {
    app = await createApp({
      logger: false,
      secret: SECRET,
      twitch: {
        clientId: 'client',
        clientSecret: 'secret',
        redirectUri: 'http://localhost:8787/auth/twitch/callback',
        eventSubUrl: 'ws://127.0.0.1:9/ws',
        helixBaseUrl: null,
      },
    });
    app.riff.repo.updateState({
      twitchUserId: BROADCASTER,
      twitchLogin: 'streamer',
      twitchTokens: createSealer(SECRET).seal({
        accessToken: 'token',
        refreshToken: 'refresh',
        expiresAt: Date.now() + 3_600_000,
        scopes: ['user:read:chat', 'moderator:manage:announcements'],
      }),
    });
    const redirect = await app.inject({ method: 'GET', url: '/auth/twitch?feature=polls' });
    const scope = new URL(String(redirect.headers.location)).searchParams.get('scope');
    expect(scope?.split(' ').sort()).toEqual([
      'channel:manage:polls',
      'moderator:manage:announcements',
      'user:read:chat',
    ]);
    expect((await app.inject({ method: 'GET', url: '/auth/twitch?feature=bits' })).statusCode).toBe(
      400,
    );
  });

  it('runs an approved poll automation from broadcaster chat and ends the poll on panic', async () => {
    const requests: { method: string; url: string; body: unknown }[] = [];
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    const fakeFetch = async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      requests.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (url.includes('/users?'))
        return json({ data: [{ ...docUser, id: BROADCASTER, broadcaster_type: 'partner' }] });
      if (url.endsWith('/polls') && method === 'POST')
        return json(fixture('helix.create-poll.json'));
      if (url.endsWith('/polls') && method === 'PATCH') return json(fixture('helix.end-poll.json'));
      return json({}, 404);
    };
    app = await createApp({
      logger: false,
      secret: SECRET,
      twitch: {
        clientId: 'client',
        clientSecret: 'secret',
        redirectUri: 'http://localhost:8787/auth/twitch/callback',
        eventSubUrl: 'ws://127.0.0.1:9/ws',
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
        scopes: ALL_SCOPES,
      }),
    });
    const run = await app.inject({
      method: 'POST',
      url: '/api/compile-runs',
      headers,
      payload: {
        intent:
          'When I type !nextgame, start a Twitch poll "What should we play next?" with choices "Speedrun" and "Hardcore" for 2 minutes.',
      },
    });
    const id = run.json<{ id: string }>().id;
    for (let i = 0; i < 200 && !app.riff.authoring.runs().find((r) => r.id === id)?.result; i++)
      await new Promise((resolve) => setTimeout(resolve, 50));
    const studio = (await app.inject({ method: 'GET', url: '/api/studio' })).json<{
      automations: { versions: { id: string; artifactId: string }[] }[];
    }>();
    const version = studio.automations[0]!.versions[0]!;
    const approved = await app.inject({
      method: 'POST',
      url: `/api/versions/${version.id}/approve`,
      headers,
      payload: { artifactId: version.artifactId, expectedActiveVersionId: null },
    });
    expect(approved.statusCode).toBe(200);
    const chat = (messageId: string, roles: ('viewer' | 'broadcaster')[]) =>
      app!.riff.runtime.handleChat({
        id: messageId,
        channelId: BROADCASTER,
        viewerId: roles.includes('broadcaster') ? BROADCASTER : '555',
        viewerName: 'someone',
        roles,
        text: '!nextgame',
        source: 'twitch',
      });
    const [viewer] = await chat('v1', ['viewer']);
    expect(viewer?.code).toBe('AUDIENCE');
    const [owner] = await chat('b1', ['viewer', 'broadcaster']);
    expect(owner?.code).toBe('ACCEPTED');
    expect(owner?.actions).toEqual([
      {
        kind: 'poll.start',
        title: 'What should we play next?',
        choices: ['Speedrun', 'Hardcore'],
        durationSeconds: 120,
      },
    ]);
    for (
      let i = 0;
      i < 100 && !requests.some((r) => r.method === 'POST' && r.url.endsWith('/polls'));
      i++
    )
      await new Promise((resolve) => setTimeout(resolve, 20));
    expect(requests.find((r) => r.method === 'POST' && r.url.endsWith('/polls'))).toMatchObject({
      url: 'http://helix.test/helix/polls',
      body: {
        broadcaster_id: BROADCASTER,
        title: 'What should we play next?',
        choices: [{ title: 'Speedrun' }, { title: 'Hardcore' }],
        duration: 120,
      },
    });
    for (let i = 0; i < 100 && !app.riff.twitchFeatures.snapshot().poll; i++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    expect(app.riff.twitchFeatures.snapshot().poll).toMatchObject({ origin: 'automation' });

    const panic = await app.inject({
      method: 'POST',
      url: '/api/channel/panic',
      headers,
      payload: {},
    });
    expect(panic.statusCode).toBe(200);
    for (let i = 0; i < 100 && !requests.some((r) => r.method === 'PATCH'); i++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    expect(requests.find((r) => r.method === 'PATCH')?.body).toMatchObject({
      status: 'TERMINATED',
    });
    const after = await app.inject({
      method: 'POST',
      url: '/api/twitch/announcements',
      headers,
      payload: { message: 'still there?' },
    });
    expect(after.statusCode).toBe(423);
  }, 30_000);

  it('previews a native action through a simulated sink without calling Twitch', async () => {
    const requests: string[] = [];
    app = await createApp({
      logger: false,
      fetch: async (url: string) => {
        requests.push(url);
        return new Response('{}', { status: 404 });
      },
    });
    const run = await app.inject({
      method: 'POST',
      url: '/api/compile-runs',
      headers,
      payload: { intent: 'When anyone types !hype, announce "Hype train incoming!" in chat.' },
    });
    const id = run.json<{ id: string }>().id;
    for (let i = 0; i < 200 && !app.riff.authoring.runs().find((r) => r.id === id)?.result; i++)
      await new Promise((resolve) => setTimeout(resolve, 50));
    const studio = (await app.inject({ method: 'GET', url: '/api/studio' })).json<{
      automations: { versions: { id: string }[] }[];
    }>();
    const version = studio.automations[0]!.versions[0]!;
    const preview = await app.inject({
      method: 'POST',
      url: `/api/versions/${version.id}/preview`,
      headers,
      payload: {
        seed: 7,
        events: [
          {
            id: 'p1',
            channelId: 'preview',
            viewerId: 'ada',
            roles: ['viewer'],
            text: '!hype',
            at: 0,
          },
        ],
      },
    });
    expect(preview.statusCode).toBe(200);
    expect(JSON.stringify(preview.json())).toContain('Hype train incoming!');
    expect(requests).toEqual([]);
  }, 30_000);
});
