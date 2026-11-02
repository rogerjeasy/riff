import { afterEach, expect, it } from 'vitest';
import { compileOffline, createOfflineTransport } from '@riff/compiler';
import { verifyCandidate } from '@riff/sandbox';
import { createApp, type RiffApp } from '../src/app.js';
const apps: RiffApp[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
const post = (app: RiffApp, path: string, payload: unknown) =>
  app.inject({
    method: 'POST',
    url: `/api/recipes/${path}`,
    headers: { 'x-riff-request': '1' },
    payload: payload as object,
  });
async function source(app: RiffApp) {
  const out = compileOffline({
    intent:
      'Let viewers throw tomatoes with !tomato, limited to three throws per person in any rolling 60 seconds.',
    base: null,
  });
  const verified = await verifyCandidate({
    source: out.source!,
    manifest: out.manifest,
    tests: out.tests,
  });
  expect(verified.ok).toBe(true);
  const v = app.riff.repo.insertVersion({
    automationId: app.riff.repo.createAutomation('Share tomatoes').id,
    parentVersionId: null,
    artifactId: verified.artifactId,
    title: 'Share tomatoes',
    intent: 'PRIVATE PROMPT MUST STAY PRIVATE',
    source: out.source!,
    manifest: out.manifest,
    tests: out.tests,
    behavior: out.behavior,
    assumptions: [],
    evidence: { verification: verified, intent: [] },
    origin: 'manual',
    compileRunId: null,
    status: 'candidate',
  });
  app.riff.studio.approve(v.id, {
    artifactId: v.artifactId!,
    reportHash: v.reportHash!,
    approvedBy: 'console',
    activeVersionId: null,
  });
  return v;
}
it('keeps public directory access separate from hosted console and requires guarded owner publication', async () => {
  const app = await createApp({
    logger: false,
    secret: 'r'.repeat(32),
    console: { password: 'a-test-password-long-enough', accessToken: null },
  });
  apps.push(app);
  expect((await app.inject('/api/recipes')).statusCode).toBe(401);
  const directory = await app.inject('/directory/recipes');
  expect(directory.statusCode).toBe(200);
  expect(directory.json()).toEqual({ recipes: [] });
  expect((await post(app, 'publish', { package: {} })).statusCode).toBe(401);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: `/directory/recipes/${'a'.repeat(64)}/report`,
        payload: { reason: 'Licensing concern' },
      })
    ).statusCode,
  ).toBe(403);
  expect((await app.inject(`/directory/recipes/${'a'.repeat(64)}`)).statusCode).toBe(404);
});
it('exports, privately adapts on a second channel, installs and activates with reviewed scene presentation', async () => {
  const a = await createApp({ logger: false, transport: createOfflineTransport() }),
    b = await createApp({ logger: false, transport: createOfflineTransport() });
  apps.push(a, b);
  const v = await source(a);
  const exported = await post(a, 'export', {
    versionId: v.id,
    title: 'Public tomatoes',
    description: 'A public sample',
    author: 'Publisher credit',
    license: 'MIT',
    rightsAttested: true,
  });
  expect(exported.statusCode).toBe(200);
  const pack = exported.json().package;
  expect(JSON.stringify(pack)).not.toMatch(/PRIVATE PROMPT|approvedAt|participant/);
  expect((await a.inject('/directory/recipes')).json()).toEqual({ recipes: [] });
  expect((await post(a, 'publish', { package: pack })).statusCode).toBe(200);
  const listed = await a.inject(`/directory/recipes/${pack.digest}`);
  expect(listed.statusCode).toBe(200);
  expect(listed.json().recipe.proof.synthetic).toBe(true);
  expect(listed.json().recipe.proof.steps[0].text).toBe('!tomato');
  expect((await post(b, 'import', { package: pack })).statusCode).toBe(200);
  const initial = (await b.inject('/api/recipes')).json().state.profile;
  const { revision, ...profile } = initial;
  expect(
    (
      await post(b, 'profile', {
        expectedRevision: revision,
        profile: {
          ...profile,
          language: 'fr',
          reducedMotion: true,
          command: '!tomate',
          audience: ['subscriber'],
          maxPerViewer: 2,
          windowMs: 30000,
        },
      })
    ).statusCode,
  ).toBe(200);
  const adapted = await post(b, 'adapt', {
    sourceDigest: pack.digest,
    profileRevision: 1,
    generate: true,
  });
  expect(adapted.statusCode).toBe(200);
  const review = adapted.json().review;
  expect(review.passed).toBe(true);
  expect(review.manifest.trigger.command).toBe('!tomate');
  expect(review.proof.steps[0].text).toBe('!tomate');
  const installed = await post(b, 'install', { reviewId: review.id, digest: review.digest });
  expect(installed.statusCode).toBe(200);
  const candidate = b.riff.repo.version(installed.json().versionId)!;
  expect(candidate.status).toBe('candidate');
  expect(b.riff.runtime.running()).toHaveLength(0);
  expect(b.riff.studio.snapshot().automations[0]?.versions[0]?.blockers).toEqual([]);
  b.riff.studio.approve(candidate.id, {
    artifactId: candidate.artifactId!,
    reportHash: candidate.reportHash!,
    approvedBy: 'console',
    activeVersionId: null,
  });
  const canvas = b.riff.scenes.view(candidate.id);
  b.riff.scenes.apply(candidate.id, canvas.revision, canvas.digest);
  const messages: { type: string; payload: unknown }[] = [];
  b.riff.overlay.attach({ send: (s) => messages.push(JSON.parse(s)), close() {} }, 'home');
  const scenes = messages.find((m) => m.type === 'scenes')!.payload as {
    scenes: { instructions: string[]; reducedMotion?: boolean }[];
  };
  expect(scenes.scenes[0]?.reducedMotion).toBe(true);
  expect(scenes.scenes[0]?.instructions.join(' ')).toContain('!tomate');
  expect(scenes.scenes[0]?.instructions.join(' ')).toMatch(/Tapez|tapez/);
  const decisions = await b.riff.runtime.handleChat({
    id: 'authenticated-local-test',
    channelId: 'home',
    viewerId: 'viewer',
    viewerName: 'Viewer',
    text: '!tomate',
    roles: ['viewer', 'subscriber'],
    source: 'twitch',
  });
  expect(decisions[0]?.code).toBe('ACCEPTED');
  const credit = b.riff.recipes.export({
    versionId: candidate.id,
    title: 'French tomatoes',
    description: 'Reviewed French adaptation',
    author: 'Remixer',
    license: 'MIT',
    rightsAttested: true,
  });
  expect(credit.lineage).toContainEqual(
    expect.objectContaining({ digest: pack.digest, author: 'Publisher credit' }),
  );
});
it('keeps round instructions truthful and identity-specific after descendant edits', async () => {
  const app = await createApp({ logger: false, transport: createOfflineTransport() });
  apps.push(app);
  const v = await source(app);
  const pack = app.riff.recipes.export({
    versionId: v.id,
    title: 'Tomatoes',
    description: 'Synthetic sample',
    author: 'Creator',
    license: 'MIT',
    rightsAttested: true,
  });
  app.riff.recipes.import(pack);
  const { revision, ...profile } = app.riff.recipes.state().profile;
  app.riff.recipes.saveProfile(revision, {
    ...profile,
    displayName: 'The Orchard',
    language: 'fr',
    command: '!orchard',
  });
  const review = await app.riff.recipes.adapt({
    sourceDigest: pack.digest,
    profileRevision: 1,
    generate: true,
  });
  const installed = app.riff.recipes.install({ reviewId: review.id, digest: review.digest });
  const parent = app.riff.repo.version(installed.versionId)!;
  const manifest = {
    ...(parent.manifest as object),
    sdkVersion: '0.4.0',
    capabilities: ['overlay', 'session'],
    experience: {
      version: 1,
      title: 'Orchard goal',
      durationMs: 120000,
      maxParticipants: 50,
      teams: [],
      resource: { name: 'throws', perParticipant: 3 },
      contribution: { command: '!orchard', points: 1 },
      objective: { kind: 'collective-goal', target: 100 },
    },
  };
  const child = app.riff.repo.insertVersion({
    ...parent,
    parentVersionId: parent.id,
    manifest,
    status: 'candidate',
  });
  const text = app.riff.recipes.presentation(child.id)!.instructions.join(' ');
  expect(text).toContain('The Orchard');
  expect(text).toContain('par manche');
  expect(text).not.toContain('/ 60s');
});
it('gives forwarded visitors independent public report allowances behind the deployment proxy', async () => {
  const app = await createApp({ logger: false, transport: createOfflineTransport() });
  apps.push(app);
  const v = await source(app),
    pack = app.riff.recipes.export({
      versionId: v.id,
      title: 'Reports',
      description: 'Public sample',
      author: 'Creator',
      license: 'MIT',
      rightsAttested: true,
    });
  await app.riff.recipes.publish(pack);
  const report = (n: number, ip: string, remoteAddress = '172.18.0.2') =>
    app.inject({
      method: 'POST',
      url: `/directory/recipes/${pack.digest}/report`,
      remoteAddress,
      headers: { 'x-riff-request': '1', 'x-forwarded-for': ip },
      payload: { reason: `Licensing concern number ${n}` },
    });
  for (let n = 0; n < 5; n++) expect((await report(n, '198.51.100.1')).statusCode).toBe(200);
  expect((await report(5, '198.51.100.1')).statusCode).toBe(429);
  expect((await report(6, '198.51.100.2')).statusCode).toBe(200);
  for (let n = 10; n < 15; n++)
    expect((await report(n, `198.51.100.${n}`, '203.0.113.9')).statusCode).toBe(200);
  expect((await report(15, '198.51.100.15', '203.0.113.9')).statusCode).toBe(429);
});

it('answers a full import library with 409 and a room-making message, then removes via the private route', async () => {
  const app = await createApp({ logger: false, transport: createOfflineTransport() });
  apps.push(app);
  const v = await source(app);
  const editions = Array.from({ length: 51 }, (_, n) => {
    const pack = app.riff.recipes.export({
      versionId: v.id,
      title: `Edition ${n}`,
      description: 'Public sample',
      author: 'Creator',
      license: 'MIT',
      rightsAttested: true,
    });
    if (n < 50) app.riff.recipes.remove('export', pack.digest);
    return pack;
  });
  for (const pack of editions.slice(0, 50)) app.riff.recipes.import(pack);
  const full = await post(app, 'import', { package: editions[50] });
  expect(full.statusCode).toBe(409);
  expect(full.json()).toMatchObject({
    code: 'LIMIT',
    message: expect.stringMatching(/Remove an older import/),
  });
  const removed = await post(app, 'remove', { kind: 'import', digest: editions[0]!.digest });
  expect(removed.statusCode).toBe(200);
  expect(removed.json().state.imports).toHaveLength(49);
  expect(removed.json().state.limits.imports).toBe(50);
  expect(removed.json().state.exports).toEqual([
    expect.objectContaining({ digest: editions[50]!.digest, revision: 1, title: 'Edition 50' }),
  ]);
  expect((await post(app, 'import', { package: editions[50] })).statusCode).toBe(200);
  const missing = await post(app, 'remove', { kind: 'export', digest: 'f'.repeat(64) });
  expect(missing.statusCode).toBe(404);
  const malformed = await post(app, 'remove', { kind: 'review', digest: 'f'.repeat(64) });
  expect(malformed.statusCode).toBe(400);
  expect(malformed.json().message).toMatch(/kind/);
  const unguarded = await app.inject({
    method: 'POST',
    url: '/api/recipes/remove',
    payload: { kind: 'import', digest: editions[1]!.digest },
  });
  expect(unguarded.statusCode).toBe(403);
});

it('shares one report allowance across an IPv6 /64 behind the proxy', async () => {
  const app = await createApp({ logger: false, transport: createOfflineTransport() });
  apps.push(app);
  const v = await source(app),
    pack = app.riff.recipes.export({
      versionId: v.id,
      title: 'Reports v6',
      description: 'Public sample',
      author: 'Creator',
      license: 'MIT',
      rightsAttested: true,
    });
  await app.riff.recipes.publish(pack);
  const report = (n: number, ip: string) =>
    app.inject({
      method: 'POST',
      url: `/directory/recipes/${pack.digest}/report`,
      remoteAddress: '172.18.0.2',
      headers: { 'x-riff-request': '1', 'x-forwarded-for': ip },
      payload: { reason: `Licensing concern number ${n}` },
    });
  for (let n = 0; n < 5; n++)
    expect((await report(n, `2001:db8:1:2::${n + 1}`)).statusCode).toBe(200);
  const limited = await report(5, '2001:0db8:0001:0002:ffff:1:2:3');
  expect(limited.statusCode).toBe(429);
  expect(limited.json().message).toMatch(/per hour/);
  expect((await report(6, '2001:db8:1:3::1')).statusCode).toBe(200);
});

it('normalizes report clients to IPv4 or an IPv6 /64', async () => {
  const { rateClient } = await import('../src/routes/report-client.js');
  expect(rateClient('::ffff:198.51.100.7')).toBe('198.51.100.7');
  expect(rateClient('2001:db8:1:2:3:4:5:6')).toBe(rateClient('2001:db8:1:2::9'));
  expect(rateClient('2001:db8::1')).toBe('2001:0db8:0000:0000::/64');
  expect(rateClient('::1')).toBe('0000:0000:0000:0000::/64');
  expect(rateClient('2001:db8:1:2::9')).not.toBe(rateClient('2001:db8:1:3::9'));
});
