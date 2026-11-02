import { afterEach, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { compileOffline, createOfflineTransport, createCompileQueue } from '@riff/compiler';
import { artifactIdentity } from '@riff/sandbox';
import type { RecipePackage } from '@riff/sdk';
import { openDatabase, type DatabaseConnection } from '../src/db/client.js';
import { forChannel } from '../src/db/repositories/studio.js';
import { createRecipeService } from '../src/services/recipes/service.js';
import { compatibilityFor, scopeDiff, type TwitchAccess } from '../src/services/recipes/install.js';
import { digest } from '../src/services/recipes/contract.js';
import { createApp, type RiffApp } from '../src/app.js';

const databases: DatabaseConnection[] = [];
const apps: RiffApp[] = [];
afterEach(async () => {
  databases.splice(0).forEach((db) => db.close());
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
function channel(id: string, access?: TwitchAccess) {
  const database = openDatabase(':memory:');
  databases.push(database);
  migrate(database.db, { migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url)) });
  const repo = forChannel(database, id);
  repo.ensure(id);
  const service = createRecipeService({
    database,
    repo,
    transport: createOfflineTransport(),
    queue: createCompileQueue(),
    saveScene: () => undefined,
    ...(access ? { twitchAccess: () => access } : {}),
  });
  return { repo, service };
}
function local(c: ReturnType<typeof channel>, intent = 'PRIVATE CREATOR PROMPT') {
  const output = compileOffline({
    intent: 'Let viewers throw tomatoes with !tomato, three times per person per 60 seconds.',
    base: null,
  });
  return c.repo.insertVersion({
    automationId: c.repo.createAutomation('Public tomatoes').id,
    parentVersionId: null,
    artifactId: artifactIdentity({ source: output.source!, manifest: output.manifest }),
    title: 'Public tomatoes',
    intent,
    source: output.source!,
    manifest: output.manifest,
    tests: output.tests,
    behavior: output.behavior,
    assumptions: [],
    evidence: { private: 'PRIVATE EVIDENCE' },
    origin: 'manual',
    compileRunId: null,
    status: 'candidate',
  });
}
async function published(c: ReturnType<typeof channel>) {
  const source = local(c);
  const pack = c.service.export({
    versionId: source.id,
    title: 'Tomatoes',
    description: 'Synthetic public demonstration',
    author: 'Declared creator',
    license: 'CC-BY-4.0',
    rightsAttested: true,
  });
  await c.service.publish(pack);
  return pack;
}
const snapshot = (c: ReturnType<typeof channel>) => JSON.stringify(c.service.state());

it('previews a pinned directory edition with author, license, compatibility and scope, writing nothing', async () => {
  const c = channel('install-preview');
  const pack = await published(c);
  // The source automation is not live, so its command does not conflict.
  const before = snapshot(c);
  const preview = await c.service.installPreview({ digest: pack.digest });
  expect(snapshot(c)).toBe(before);
  expect(c.service.state().imports).toEqual([]);
  expect(preview.source).toBe('directory');
  expect(preview.package.digest).toBe(pack.digest);
  expect(preview.package.author).toBe('Declared creator');
  expect(preview.package.license).toBe('CC-BY-4.0');
  expect(preview.proof?.synthetic).toBe(true);
  expect(JSON.stringify(preview)).not.toMatch(/PRIVATE|install-preview|rateKeys|reports/);
  expect(preview.compatibility.installable).toBe(true);
  expect(preview.compatibility.checks.find((check) => check.id === 'sdk')?.status).toBe('ok');
  const chat = preview.compatibility.checks.find((check) => check.id === 'trigger');
  expect(chat).toMatchObject({ status: 'warn', grantUrl: '/auth/twitch' });
  expect(preview.existing.status).toBe('none');
  const commands = preview.scope.find((row) => row.field === 'commands');
  expect(commands).toMatchObject({ before: null, after: '!tomato', changed: true });
  expect(preview.scope.map((row) => row.field)).toEqual([
    'capabilities',
    'trigger',
    'commands',
    'audience',
    'limits',
    'experience',
    'twitchScopes',
  ]);
});

it('rejects unavailable editions, digest mismatches and tampered files without writing', async () => {
  const c = channel('install-mismatch');
  const pack = await published(c);
  const before = snapshot(c);
  await expect(c.service.installPreview({ digest: 'b'.repeat(64) })).rejects.toMatchObject({
    code: 'NOT_FOUND',
  });
  await expect(
    c.service.installPreview({ digest: 'c'.repeat(64), package: pack }),
  ).rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringMatching(/Digest mismatch/) });
  await expect(
    c.service.installPreview({ digest: pack.digest, package: { ...pack, title: 'Swapped' } }),
  ).rejects.toMatchObject({ code: 'INVALID', message: expect.stringMatching(/digest/) });
  await expect(
    c.service.installFromLink({ digest: 'c'.repeat(64), package: pack, profileRevision: 0 }),
  ).rejects.toMatchObject({ code: 'CONFLICT' });
  expect(snapshot(c)).toBe(before);
});

it('installs a pinned file as a private candidate on another channel, once, and reports it installed', async () => {
  const a = channel('install-source'),
    b = channel('install-recipient');
  const pack = await published(a);
  await expect(
    b.service.installFromLink({ digest: pack.digest, package: pack, profileRevision: 3 }),
  ).rejects.toMatchObject({ code: 'STALE' });
  expect(b.service.state().imports).toEqual([]);
  const result = await b.service.installFromLink({
    digest: pack.digest,
    package: pack,
    profileRevision: 0,
  });
  expect(result.alreadyInstalled).toBe(false);
  expect(result.review?.passed).toBe(true);
  const version = b.repo.version(result.versionId);
  expect(version?.status).toBe('candidate');
  expect(b.repo.automation(version!.automationId)?.activeVersionId).toBeNull();
  const preview = await b.service.installPreview({ digest: pack.digest, package: pack });
  expect(preview.existing).toMatchObject({ status: 'installed', versionId: result.versionId });
  expect(preview.scope.every((row) => row.before !== null && !row.changed)).toBe(true);
  const again = await b.service.installFromLink({
    digest: pack.digest,
    package: pack,
    profileRevision: 0,
  });
  expect(again).toMatchObject({ alreadyInstalled: true, versionId: result.versionId });
  expect(b.service.state().imports).toHaveLength(1);
});

it('leaves nothing behind when validation fails after confirmation', async () => {
  const a = channel('rollback-source'),
    b = channel('rollback-recipient');
  const pack = await published(a);
  // A live !tomato interaction on the recipient makes the pinned command conflict.
  const live = local(b, 'Recipient tomatoes');
  b.repo.activate(live.automationId, live.id, 'console');
  const preview = await b.service.installPreview({ digest: pack.digest, package: pack });
  expect(preview.compatibility.installable).toBe(false);
  expect(preview.compatibility.checks.find((check) => check.id === 'command')?.status).toBe(
    'blocked',
  );
  await expect(
    b.service.installFromLink({ digest: pack.digest, package: pack, profileRevision: 0 }),
  ).rejects.toMatchObject({ code: 'CONFLICT' });
  expect(b.service.state().imports).toEqual([]);
  expect(b.service.state().reviews).toEqual([]);
});

const manifestOf = (overrides: Record<string, unknown>) => {
  const output = compileOffline({
    intent: 'Let viewers throw tomatoes with !tomato, three times per person per 60 seconds.',
    base: null,
  });
  return { ...(output.manifest as Record<string, unknown>), ...overrides };
};
const packOf = (manifest: Record<string, unknown>) =>
  ({ manifest, digest: digest(manifest) }) as unknown as RecipePackage;
const nobody: TwitchAccess = {
  connected: true,
  scopes: ['user:read:chat'],
  eligibility: 'unknown',
};

it('computes SDK, capability, consent and eligibility compatibility', () => {
  const sdk = compatibilityFor(
    packOf(manifestOf({ sdkVersion: '9.0.0' })),
    ['overlay'],
    nobody,
    null,
  );
  expect(sdk.installable).toBe(false);
  expect(sdk.checks[0]).toMatchObject({ id: 'sdk', status: 'blocked' });

  const polls = compatibilityFor(
    packOf(manifestOf({ capabilities: ['overlay', 'polls'] })),
    ['overlay', 'session'],
    nobody,
    null,
  );
  expect(polls.checks.find((check) => check.id === 'capability:polls')?.status).toBe('blocked');

  const pointsManifest = manifestOf({
    trigger: {
      command: '!hydrate',
      audience: ['viewer'],
      maxPerViewer: 1,
      windowMs: 60000,
      kind: 'points.redeem',
      reward: 'Hydrate',
      event: null,
    },
  });
  const consent = compatibilityFor(packOf(pointsManifest), ['overlay'], nobody, null);
  expect(consent.checks.find((check) => check.id === 'trigger')).toMatchObject({
    status: 'consent',
    grantUrl: '/auth/twitch?features=channel-points',
  });
  const ineligible = compatibilityFor(
    packOf(pointsManifest),
    ['overlay'],
    { connected: true, scopes: ['channel:manage:redemptions'], eligibility: 'ineligible' },
    null,
  );
  expect(ineligible.installable).toBe(false);
  const ready = compatibilityFor(
    packOf(pointsManifest),
    ['overlay'],
    { connected: true, scopes: ['channel:manage:redemptions'], eligibility: 'affiliate' },
    null,
  );
  expect(ready.checks.find((check) => check.id === 'trigger')?.status).toBe('ok');
  const conflict = compatibilityFor(packOf(pointsManifest), ['overlay'], nobody, 'Taken.');
  expect(conflict.installable).toBe(false);
});

it('diffs authority against nothing installed and against an installed edition', () => {
  const base = manifestOf({}) as unknown as RecipePackage['manifest'];
  const wider = manifestOf({
    trigger: { ...(base.trigger as object), audience: ['viewer', 'subscriber'] },
  }) as unknown as RecipePackage['manifest'];
  expect(scopeDiff(base, null).every((row) => row.before === null && row.changed)).toBe(true);
  const changed = scopeDiff(wider, base).filter((row) => row.changed);
  expect(changed.map((row) => row.field)).toEqual(['audience']);
});

it('serves install previews only behind the console guard and reads the same-origin directory', async () => {
  const app = await createApp({ logger: false, transport: createOfflineTransport() });
  apps.push(app);
  const response = await app.inject({
    method: 'POST',
    url: '/api/recipes/install-preview',
    headers: { 'x-riff-request': '1' },
    payload: { digest: 'a'.repeat(64) },
  });
  expect(response.statusCode).toBe(404);
  expect(response.json().message).toMatch(/unavailable/);
  const bad = await app.inject({
    method: 'POST',
    url: '/api/recipes/install-preview',
    headers: { 'x-riff-request': '1' },
    payload: { digest: 'https://example.com/recipe.json' },
  });
  expect(bad.statusCode).toBe(400);
  const guarded = await createApp({
    logger: false,
    secret: 'r'.repeat(32),
    console: { password: 'a-test-password-long-enough', accessToken: null },
  });
  apps.push(guarded);
  const refused = await guarded.inject({
    method: 'POST',
    url: '/api/recipes/install-preview',
    headers: { 'x-riff-request': '1' },
    payload: { digest: 'a'.repeat(64) },
  });
  expect(refused.statusCode).toBe(401);
});
