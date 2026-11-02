import { afterEach, expect, it, vi } from 'vitest';
import { createApp, type RiffApp } from '../src/app.js';
const apps: RiffApp[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
});
it('guards production operations and makes panic independent of connector health', async () => {
  const disconnect = vi.fn(() => {
    throw Error('broken socket');
  });
  const app = await createApp({
    logger: false,
    secret: 's'.repeat(32),
    production: {
      obsFactory: () => ({
        connect: async () => {},
        disconnect,
        scenes: async () => ['Live'],
        input: async () => null,
        write: async () => {},
        remove: async () => {},
      }),
    },
  });
  apps.push(app);
  const body = {
    kind: 'obs',
    url: 'ws://127.0.0.1:4455',
    password: 'test-password-only',
    discover: true,
  };
  expect(
    (await app.inject({ method: 'POST', url: '/api/production/connect', payload: body }))
      .statusCode,
  ).toBe(403);
  const connected = await app.inject({
    method: 'POST',
    url: '/api/production/connect',
    headers: { 'x-riff-request': '1' },
    payload: body,
  });
  expect(connected.statusCode).toBe(200);
  expect(JSON.stringify(connected.json())).not.toContain('test-password-only');
  expect(connected.json().state.connections.obs.status).toBe('connected');
  app.riff.studio.panic('operator stop');
  expect(app.riff.runtime.panicked).toBe(true);
  expect(disconnect).toHaveBeenCalled();
  expect((await app.inject('/api/production')).json().state.connections.obs.status).toBe(
    'disconnected',
  );
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/production/obs/review',
        headers: { 'x-riff-request': '1' },
        payload: { sceneName: 'Live', inputName: 'Riff', width: 1920, height: 1080 },
      })
    ).statusCode,
  ).toBe(409);
});
it('keeps production secrets private behind hosted-console authentication', async () => {
  const app = await createApp({
    logger: false,
    secret: 's'.repeat(32),
    console: { password: 'a-long-test-password', accessToken: null },
  });
  apps.push(app);
  expect((await app.inject('/api/production')).statusCode).toBe(401);
  expect((await app.inject('/participation')).statusCode).toBe(200);
});
it('runs approved mapped operations through the real local control gate without activating candidates', async () => {
  const { compileOffline } = await import('@riff/compiler');
  const { verifyCandidate } = await import('@riff/sandbox');
  const app = await createApp({
    logger: false,
    secret: 's'.repeat(32),
    production: {
      botFactory: () => ({
        connect: async () => {},
        disconnect: () => {},
        actions: async () => [],
        invoke: async () => {},
      }),
    },
  });
  apps.push(app);
  const out = compileOffline({
    intent: 'Let viewers throw tomatoes with !tomato, three times per person per 60 seconds.',
    base: null,
  });
  const verification = await verifyCandidate({
    source: out.source!,
    manifest: out.manifest,
    tests: out.tests,
  });
  const v = app.riff.repo.insertVersion({
    automationId: app.riff.repo.createAutomation('Mapped tomatoes').id,
    parentVersionId: null,
    artifactId: verification.artifactId,
    title: 'Mapped tomatoes',
    intent: 'Tomatoes',
    source: out.source!,
    manifest: out.manifest,
    tests: out.tests,
    behavior: out.behavior,
    assumptions: [],
    evidence: { verification, intent: [] },
    origin: 'manual',
    compileRunId: null,
    status: 'candidate',
  });
  await app.riff.production.connect({
    kind: 'streamerbot',
    url: 'ws://127.0.0.1:8080',
    password: 'test-password-only',
    discover: true,
  });
  const mapping = {
    id: 'start',
    eventName: 'Start',
    versionId: v.id,
    control: 'start' as const,
    actionId: null,
  };
  expect(() => app.riff.production.reviewMappings([mapping])).toThrow();
  app.riff.studio.approve(v.id, {
    artifactId: v.artifactId!,
    reportHash: v.reportHash!,
    approvedBy: 'console',
    activeVersionId: null,
  });
  app.riff.studio.pause(v.automationId);
  app.riff.production.reviewMappings([mapping]);
  app.riff.production.approveMappings(app.riff.production.view().mappingReview!.digest);
  const event = {
    eventName: 'Start',
    args: {
      riff: {
        eventId: 'event-one',
        causalId: 'cause-one',
        origin: 'creator-tool',
        hops: 0,
        at: Date.now(),
      },
    },
  };
  await app.riff.production.receive(event);
  expect(app.riff.repo.automation(v.automationId)?.status).toBe('live');
  app.riff.studio.pause(v.automationId);
  await app.riff.production.receive(event);
  expect(app.riff.repo.automation(v.automationId)?.status).toBe('paused');
  app.riff.studio.panic('test');
  await app.riff.production.receive({
    ...event,
    args: { riff: { ...event.args.riff, eventId: 'new', causalId: 'new' } },
  });
  expect(app.riff.runtime.panicked).toBe(true);
});
it('discards a pending mapping review through the guarded route', async () => {
  const app = await createApp({
    logger: false,
    secret: 's'.repeat(32),
    production: {
      botFactory: () => ({
        connect: async () => {},
        disconnect: () => {},
        actions: async () => [],
        invoke: async () => {},
      }),
    },
  });
  apps.push(app);
  const headers = { 'x-riff-request': '1' };
  const staged = await app.inject({
    method: 'POST',
    url: '/api/production/import',
    headers,
    payload: { document: { format: 'firebot', scripts: ['never'] } },
  });
  const digest = staged.json().state.mappingReview.digest as string;
  const stale = await app.inject({
    method: 'POST',
    url: '/api/production/mappings/discard',
    headers,
    payload: { digest: 'f'.repeat(64) },
  });
  expect(stale.statusCode).toBe(409);
  const discarded = await app.inject({
    method: 'POST',
    url: '/api/production/mappings/discard',
    headers,
    payload: { digest },
  });
  expect(discarded.statusCode).toBe(200);
  expect(discarded.json().state.mappingReview).toBeNull();
});
