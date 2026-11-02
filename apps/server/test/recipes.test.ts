import { expect, it } from 'vitest';
import { digest, parsePackage } from '../src/services/recipes/contract.js';
it('rejects malformed portable packages and private credential material', () => {
  expect(() =>
    parsePackage({ version: 1, digest: digest({ version: 1 }), access_token: 'private' }),
  ).toThrow();
});
it('uses canonical content digests', () =>
  expect(digest({ a: 1, b: 2 })).toBe(digest({ b: 2, a: 1 })));
import { afterEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { compileOffline, createOfflineTransport, createCompileQueue } from '@riff/compiler';
import { artifactIdentity } from '@riff/sandbox';
import { openDatabase, type DatabaseConnection } from '../src/db/client.js';
import { forChannel } from '../src/db/repositories/studio.js';
import { createRecipeService } from '../src/services/recipes/service.js';
import { recipeRepository } from '../src/db/repositories/recipes.js';
const databases: DatabaseConnection[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.close()));
type ServiceDeps = Parameters<typeof createRecipeService>[0];
function channel(
  id: string,
  reservedCommands: () => string[] = () => [],
  overrides: Partial<Omit<ServiceDeps, 'database' | 'repo' | 'saveScene'>> = {},
) {
  const database = openDatabase(':memory:');
  databases.push(database);
  migrate(database.db, { migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url)) });
  const repo = forChannel(database, id);
  repo.ensure(id);
  const scenes: string[] = [];
  const service = createRecipeService({
    database,
    repo,
    transport: createOfflineTransport(),
    queue: createCompileQueue(),
    saveScene: (versionId) => scenes.push(versionId),
    reservedCommands,
    ...overrides,
  });
  return { database, repo, service, scenes };
}
function local(c: ReturnType<typeof channel>) {
  const output = compileOffline({
    intent: 'Let viewers throw tomatoes with !tomato, three times per person per 60 seconds.',
    base: null,
  });
  return c.repo.insertVersion({
    automationId: c.repo.createAutomation('Public tomatoes').id,
    parentVersionId: null,
    artifactId: artifactIdentity({ source: output.source!, manifest: output.manifest }),
    title: 'Public tomatoes',
    intent: 'PRIVATE CREATOR PROMPT',
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
it('exports explicitly public fields, privately verifies on another channel and installs exactly once without approval', async () => {
  const a = channel('source-private-channel'),
    b = channel('recipient-private-channel');
  const source = local(a);
  const pack = a.service.export({
    versionId: source.id,
    title: 'Tomatoes',
    description: 'Synthetic public demonstration',
    author: 'Declared creator',
    license: 'MIT',
    rightsAttested: true,
  });
  expect(JSON.stringify(pack)).not.toMatch(
    /PRIVATE|source-private-channel|recipient-private-channel/,
  );
  expect(b.service.import(pack).supported).toBe(true);
  const review = await b.service.adapt({ sourceDigest: pack.digest, profileRevision: 0 });
  expect(review.passed).toBe(true);
  expect(review.proof.accepted).toBeGreaterThan(0);
  const installed = b.service.install({ reviewId: review.id, digest: review.digest });
  expect(b.service.install({ reviewId: review.id, digest: review.digest })).toEqual(installed);
  expect(b.repo.version(installed.versionId)?.status).toBe('candidate');
  expect(b.repo.automation(installed.automationId)?.activeVersionId).toBeNull();
  expect(b.scenes).toEqual([installed.versionId]);
  expect(a.service.directory()).toEqual([]);
  await a.service.publish(pack);
  expect(a.service.directory()).toHaveLength(1);
  expect(b.service.directory()).toEqual([]);
  const report = a.service.report(pack.digest, 'License needs review', 'synthetic-rate-key');
  a.service.moderate(report.id, true);
  expect(a.service.directory()).toEqual([]);
  expect(() => a.service.detail(pack.digest)).toThrow();
});
it('rejects stale profiles and tampered evidence and preserves source pinning', async () => {
  const a = channel('a'),
    b = channel('b'),
    v = local(a);
  const pack = a.service.export({
    versionId: v.id,
    title: 'Pin',
    description: 'Pinned source',
    author: 'Declared',
    license: 'MIT',
    rightsAttested: true,
  });
  b.service.import(pack);
  const review = await b.service.adapt({ sourceDigest: pack.digest, profileRevision: 0 });
  const records = recipeRepository(b.database, 'b');
  const row = records.get()!;
  row.reviews[0]!.proof.accepted += 1;
  records.save(row);
  expect(() => b.service.install({ reviewId: review.id, digest: review.digest })).toThrow();
  const profile = b.service.state().profile;
  const { revision, ...body } = profile;
  b.service.saveProfile(revision, { ...body, language: 'fr', reducedMotion: true });
  await expect(
    b.service.adapt({ sourceDigest: pack.digest, profileRevision: 0 }),
  ).rejects.toThrow();
  expect(b.service.state().imports[0]?.digest).toBe(pack.digest);
});
it('generates a proposed command with the shared compiler and pins an explicit update to the same automation', async () => {
  const a = channel('edition-owner'),
    b = channel('edition-recipient'),
    v = local(a);
  const pack = a.service.export({
    versionId: v.id,
    title: 'Edition',
    description: 'Public edition',
    author: 'Declared',
    license: 'MIT',
    rightsAttested: true,
  });
  b.service.import(pack);
  const { revision, ...profile } = b.service.state().profile;
  b.service.saveProfile(revision, {
    ...profile,
    command: '!splat',
    maxPerViewer: 2,
    windowMs: 30000,
    language: 'es',
    reducedMotion: true,
  });
  const review = await b.service.adapt({
    sourceDigest: pack.digest,
    profileRevision: 1,
    generate: true,
  });
  expect(review.manifest.trigger.command).toBe('!splat');
  expect(b.repo.runs()).toHaveLength(1);
  const first = b.service.install({ reviewId: review.id, digest: review.digest });
  const next = await b.service.adapt({
    sourceDigest: pack.digest,
    profileRevision: 1,
    generate: true,
    targetVersionId: first.versionId,
  });
  const update = b.service.install({ reviewId: next.id, digest: next.digest });
  expect(update.automationId).toBe(first.automationId);
  expect(b.repo.version(update.versionId)?.parentVersionId).toBe(first.versionId);
  expect(b.service.presentation(update.versionId)).toMatchObject({
    language: 'es',
    reducedMotion: true,
  });
  expect(b.service.presentation(update.versionId)?.instructions.join(' ')).toContain('!splat');
  const newer = { ...pack, revision: 2 };
  const content = { ...newer };
  Reflect.deleteProperty(content, 'digest');
  newer.digest = digest(content);
  b.service.import(newer);
  expect(b.service.state().reviews[0]?.sourceDigest).toBe(pack.digest);
  expect(b.repo.version(first.versionId)?.source).toBe(review.source);
});
it('shows unsupported capabilities and rejects unauthorized assets and digest tampering', () => {
  const a = channel('boundary-source'),
    b = channel('boundary-target'),
    v = local(a);
  const original = a.service.export({
    versionId: v.id,
    title: 'Boundaries',
    description: 'Synthetic example',
    author: 'Declared',
    license: 'MIT',
    rightsAttested: true,
  });
  const withCapability = {
    ...original,
    manifest: { ...original.manifest, capabilities: ['overlay', 'unknown-capability'] },
  };
  const content = { ...withCapability };
  Reflect.deleteProperty(content, 'digest');
  const result = b.service.import({ ...content, digest: digest(content) });
  expect(result.supported).toBe(false);
  expect(result.blockers.join(' ')).toContain('unknown-capability');
  const invalidAsset = {
    ...original,
    assets: [{ id: 'external', credit: 'Riff', license: 'project-license' }],
  };
  expect(() => b.service.import(invalidAsset)).toThrow();
  expect(() => b.service.import({ ...original, author: 'Tampered' })).toThrow();
});
it('rechecks command conflicts and profile revisions at installation', async () => {
  const a = channel('conflict-source'),
    b = channel('conflict-target'),
    v = local(a);
  const pack = a.service.export({
    versionId: v.id,
    title: 'Conflict',
    description: 'Synthetic example',
    author: 'Declared',
    license: 'MIT',
    rightsAttested: true,
  });
  b.service.import(pack);
  const review = await b.service.adapt({ sourceDigest: pack.digest, profileRevision: 0 });
  const competitor = local(b);
  b.repo.activate(competitor.automationId, competitor.id);
  expect(() => b.service.install({ reviewId: review.id, digest: review.digest })).toThrow(
    /command/,
  );
  b.repo.updateAutomation(competitor.automationId, { activeVersionId: null, status: 'draft' });
  const { revision, ...profile } = b.service.state().profile;
  b.service.saveProfile(revision, { ...profile, language: 'de' });
  expect(() => b.service.install({ reviewId: review.id, digest: review.digest })).toThrow(
    /profile/,
  );
});
it('canonical digest ordering is independent of locale', async () => {
  const { canonical } = await import('../src/services/recipes/contract.js');
  expect(canonical({ Z: 1, a: 2 })).toBe('{"Z":1,"a":2}');
});
it('refreshes capability blockers when the recipient profile changes', () => {
  const a = channel('source'),
    b = channel('target'),
    v = local(a);
  const pack = a.service.export({
    versionId: v.id,
    title: 'Tomatoes',
    description: 'Public sample',
    author: 'Creator',
    license: 'MIT',
    rightsAttested: true,
  });
  const { revision, ...profile } = b.service.state().profile;
  b.service.saveProfile(revision, { ...profile, capabilities: ['session'] });
  expect(b.service.import(pack).supported).toBe(false);
  b.service.saveProfile(1, { ...profile, capabilities: ['overlay', 'session'] });
  expect(b.service.state().imports[0]?.supported).toBe(true);
  expect(b.service.state().imports[0]?.blockers).toEqual([]);
});
it('keeps withheld editions private when resolving other reports and restores only explicitly', async () => {
  const a = channel('moderation'),
    v = local(a);
  const pack = a.service.export({
    versionId: v.id,
    title: 'Reported',
    description: 'Public sample',
    author: 'Creator',
    license: 'MIT',
    rightsAttested: true,
  });
  await a.service.publish(pack);
  const first = a.service.report(pack.digest, 'License report A', 'visitor-a'),
    second = a.service.report(pack.digest, 'License report B', 'visitor-b');
  a.service.moderate(first.id, true);
  a.service.moderate(second.id, false);
  expect(a.service.directory()).toEqual([]);
  expect(() => a.service.detail(pack.digest)).toThrow();
  a.service.restore(pack.digest, true);
  expect(a.service.detail(pack.digest).withheld).toBe(false);
});

it('rejects host commands and rechecks shared-command reservations after rehearsal', async () => {
  let reserved: string[] = [];
  const a = channel('reserved-source'),
    b = channel('reserved-target', () => reserved);
  const pack = a.service.export({
    versionId: local(a).id,
    title: 'Commands',
    description: 'Public example',
    author: 'Creator',
    license: 'MIT',
    rightsAttested: true,
  });
  b.service.import(pack);
  const review = await b.service.adapt({ sourceDigest: pack.digest, profileRevision: 0 });
  reserved = ['!tomato'];
  expect(() => b.service.install({ reviewId: review.id, digest: review.digest })).toThrow(
    /reserved/,
  );
  reserved = [];
  const { revision, ...profile } = b.service.state().profile;
  b.service.saveProfile(revision, { ...profile, command: '!riff' });
  await expect(
    b.service.adapt({ sourceDigest: pack.digest, profileRevision: 1, generate: true }),
  ).rejects.toThrow(/reserved/);
});

// ---------------------------------------------------------------------------
// Review regressions (F38 hardening)
// ---------------------------------------------------------------------------
import { createHash } from 'node:crypto';
import { QueueFullError, type CompilerTransport } from '@riff/compiler';
import { canonical, type RecipeError } from '../src/services/recipes/contract.js';
import type { RecipePackage } from '@riff/sdk';

const rehash = <T extends { digest: string }>(pack: T): T => {
  const content: Record<string, unknown> = { ...pack };
  Reflect.deleteProperty(content, 'digest');
  return { ...pack, digest: digest(content) };
};
const exportOf = (c: ReturnType<typeof channel>, versionId: string, title = 'Tomatoes') =>
  c.service.export({
    versionId,
    title,
    description: 'Public sample',
    author: 'Creator',
    license: 'MIT',
    rightsAttested: true,
  });
const failure = async (work: () => unknown) => {
  try {
    await work();
  } catch (error) {
    return error as RecipeError;
  }
  throw new Error('expected a recipe error');
};

it('canonical digests treat undefined exactly like JSON', () => {
  expect(canonical({ a: 1, b: undefined })).toBe(canonical({ a: 1 }));
  expect(canonical([1, undefined, 2])).toBe('[1,null,2]');
  const value = { z: [undefined, { y: undefined, x: 2 }], v: undefined };
  expect(digest(value)).toBe(digest(JSON.parse(JSON.stringify(value))));
});

it('bounds package source by UTF-8 bytes, not characters', () => {
  const a = channel('bytes'),
    pack = exportOf(a, local(a).id);
  const wide = rehash({ ...pack, source: `// ${'€'.repeat(6000)}\n${pack.source}` });
  expect(Buffer.byteLength(wide.source, 'utf8')).toBeGreaterThan(16384);
  expect(wide.source.length).toBeLessThan(16384);
  expect(() => parsePackage(wide)).toThrow(/source/i);
});

it('rejects recognizable credentials by field and accepts ordinary words and URLs', () => {
  const a = channel('secrets'),
    pack = exportOf(a, local(a).id);
  const header = Buffer.from('{"alg":"HS256"}').toString('base64url');
  const body = Buffer.from('{"sub":"1234567890"}').toString('base64url');
  const cases: [Partial<RecipePackage>, RegExp][] = [
    [{ description: `token ${header}.${body}.c2lnbmF0dXJl` }, /description/],
    [{ description: `use ghp_${'a'.repeat(36)}` }, /description/],
    [{ title: `github_pat_${'A1'.repeat(15)}` }, /title/],
    // Concatenated so the repository secret scan does not match a literal AWS key id.
    [{ author: 'AKIA' + 'ABCDEFGHIJKLMNOP' }, /author/],
    [{ description: `xoxb-${'1'.repeat(12)}-abcdefabcdef` }, /description/],
    [{ description: `sk-${'Ab1'.repeat(8)}` }, /description/],
    [{ description: 'see https://user:hunter2@example.com/path' }, /description/],
    // Assembled at runtime so the repository secret scan does not flag this fixture.
    [
      { source: `// ${['-----BEGIN RSA', 'PRIVATE KEY-----'].join(' ')}\n${pack.source}` },
      /source/,
    ],
  ];
  for (const [change, field] of cases) {
    const error = (() => {
      try {
        parsePackage(rehash({ ...pack, ...change }));
      } catch (e) {
        return e as Error;
      }
      return null;
    })();
    expect(error?.message, JSON.stringify(change).slice(0, 60)).toMatch(field);
    expect(error?.message).toMatch(/secret|credential/i);
  }
  const harmless = rehash({
    ...pack,
    description: 'Needs no authorization; rules at http://example.com/rules and access_token docs.',
  });
  expect(parsePackage(harmless).description).toContain('authorization');
});

it('marks a package whose manifest has no trigger as unsupported with a plain blocker', () => {
  const a = channel('no-trigger-source'),
    b = channel('no-trigger-target'),
    pack = exportOf(a, local(a).id);
  const manifest: Record<string, unknown> = { ...pack.manifest };
  Reflect.deleteProperty(manifest, 'trigger');
  const result = b.service.import(rehash({ ...pack, manifest } as unknown as RecipePackage));
  expect(result.supported).toBe(false);
  expect(result.blockers.join(' ')).toMatch(/manifest\.trigger is missing/);
});

it('names the first failing package path in plain words', async () => {
  const a = channel('paths'),
    pack = exportOf(a, local(a).id);
  const missing: Record<string, unknown> = { ...pack };
  Reflect.deleteProperty(missing, 'title');
  const error = await failure(() => a.service.import(missing));
  expect(error.code).toBe('INVALID');
  expect(error.message).toMatch(/title is missing/);
});

it('frees report capacity by pruning resolved reports and caps open reports per edition', async () => {
  const a = channel('report-capacity'),
    pack = exportOf(a, local(a).id);
  await a.service.publish(pack);
  let visitor = 0;
  const send = (n: number) => a.service.report(pack.digest, `Concern number ${n}`, `v${visitor++}`);
  for (let round = 0; round < 5; round++) {
    const batch = Array.from({ length: 20 }, (_, n) => send(round * 20 + n));
    for (const report of batch) a.service.moderate(report.id, false);
  }
  expect(a.service.state().reports).toHaveLength(100);
  const fresh = send(1000);
  expect(fresh.status).toBe('open');
  expect(a.service.state().reports.length).toBeLessThanOrEqual(100);
  for (let n = 1; n < 20; n++) send(2000 + n);
  const capped = await failure(() => send(3000));
  expect(capped.code).toBe('LIMIT');
  expect(capped.message).toMatch(/open reports/i);
});

it('hashes rate keys with the server secret and keeps active limits when evicting', async () => {
  let clock = 10_000_000;
  const a = channel('rate-keys', () => [], { rateSecret: 's'.repeat(32), now: () => clock });
  const pack = exportOf(a, local(a).id);
  await a.service.publish(pack);
  for (let n = 0; n < 5; n++) a.service.report(pack.digest, `Heavy concern ${n}`, 'heavy');
  const limited = await failure(() => a.service.report(pack.digest, 'Heavy concern 5', 'heavy'));
  expect(limited.code).toBe('RATE');
  const storage = recipeRepository(a.database, 'rate-keys');
  const row = storage.get()!;
  expect(Object.keys(row.rateKeys)).not.toContain(
    createHash('sha256').update(JSON.stringify('heavy')).digest('hex'),
  );
  for (let n = 0; n < 99; n++) row.rateKeys[`filler-${n}`] = [clock - 1_800_000];
  storage.save(row);
  clock += 1000;
  a.service.report(pack.digest, 'A new visitor concern', 'newcomer');
  expect(Object.keys(storage.get()!.rateKeys).length).toBeLessThanOrEqual(100);
  expect((await failure(() => a.service.report(pack.digest, 'Heavy again', 'heavy'))).code).toBe(
    'RATE',
  );
});

it('lets the creator remove exports and imports to make room, but never installed lineage', async () => {
  const a = channel('room-source'),
    b = channel('room-target'),
    v = local(a);
  const exported = Array.from({ length: 50 }, (_, n) => exportOf(a, v.id, `Edition ${n}`));
  const full = await failure(() => exportOf(a, v.id, 'One too many'));
  expect(full.code).toBe('LIMIT');
  expect(full.message).toMatch(/Remove an older export/);
  a.service.remove('export', exported[0]!.digest);
  expect(exportOf(a, v.id, 'Now it fits').title).toBe('Now it fits');

  a.service.remove('export', exported[1]!.digest);
  a.service.remove('export', exported[2]!.digest);
  for (const pack of exported.slice(1)) b.service.import(pack);
  const extra = exportOf(a, v.id, 'Second extra');
  b.service.import(exportOf(a, v.id, 'Fiftieth import'));
  const blocked = await failure(() => b.service.import(extra));
  expect(blocked.code).toBe('LIMIT');
  expect(blocked.message).toMatch(/Remove an older import/);
  const installedSource = exported[1]!;
  const review = await b.service.adapt({
    sourceDigest: installedSource.digest,
    profileRevision: 0,
  });
  b.service.install({ reviewId: review.id, digest: review.digest });
  const kept = await failure(() => b.service.remove('import', installedSource.digest));
  expect(kept.code).toBe('CONFLICT');
  expect(kept.message).toMatch(/installed/i);
  const state = b.service.remove('import', exported[2]!.digest);
  expect(state.imports.some((i) => i.digest === exported[2]!.digest)).toBe(false);
  expect(b.service.import(extra).digest).toBe(extra.digest);
  expect((await failure(() => b.service.remove('import', 'f'.repeat(64)))).code).toBe('NOT_FOUND');
});

it('prunes failed and superseded reviews, and checks the review cap before generation', async () => {
  const a = channel('review-source'),
    b = channel('review-target'),
    pack = exportOf(a, local(a).id);
  b.service.import(pack);
  const review = await b.service.adapt({ sourceDigest: pack.digest, profileRevision: 0 });
  const storage = recipeRepository(b.database, 'review-target');
  const row = storage.get()!;
  row.reviews = Array.from({ length: 50 }, (_, n) => ({
    ...review,
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    passed: n !== 0 ? review.passed : false,
  }));
  storage.save(row);
  const next = await b.service.adapt({ sourceDigest: pack.digest, profileRevision: 0 });
  const ids = b.service.state().reviews.map((r) => r.id);
  expect(ids).toHaveLength(50);
  expect(ids).toContain(next.id);
  expect(ids).not.toContain('00000000-0000-4000-8000-000000000000');

  const installed = storage.get()!;
  installed.reviews = installed.reviews.map((r, n) => ({
    ...r,
    installedVersionId: `installed-${n}`,
  }));
  storage.save(installed);
  const full = await failure(() =>
    b.service.adapt({ sourceDigest: pack.digest, profileRevision: 0, generate: true }),
  );
  expect(full.code).toBe('LIMIT');
  expect(full.message).toMatch(/50/);
  expect(b.repo.runs()).toHaveLength(0);
});

it('checks the publication cap before running the public rehearsal', async () => {
  const runs: string[] = [];
  const queue = createCompileQueue();
  const a = channel('publication-cap', () => [], {
    queue: {
      ...queue,
      run: (channelId, job, options) => {
        runs.push(channelId);
        return queue.run(channelId, job, options);
      },
    },
  });
  const v = local(a),
    first = exportOf(a, v.id, 'First'),
    second = exportOf(a, v.id, 'Second');
  await a.service.publish(first);
  const storage = recipeRepository(a.database, 'publication-cap');
  const row = storage.get()!;
  row.publications = Array.from({ length: 50 }, () => structuredClone(row.publications[0]!));
  storage.save(row);
  runs.length = 0;
  const error = await failure(() => a.service.publish(second));
  expect(error.code).toBe('LIMIT');
  expect(error.message).toMatch(/50 published editions/);
  expect(runs).toEqual([]);
});

it('fails a generated review that ignored the recipient profile and names the field', async () => {
  const offline = createOfflineTransport();
  const disobedient: CompilerTransport = {
    ...offline,
    open: (request, files, options) =>
      offline.open(
        { ...request, intent: request.intent.replaceAll('!splat', '!tomato') },
        files,
        options,
      ),
  };
  const a = channel('profile-source'),
    b = channel('profile-target', () => [], { transport: disobedient }),
    pack = exportOf(a, local(a).id);
  b.service.import(pack);
  const { revision, ...profile } = b.service.state().profile;
  b.service.saveProfile(revision, { ...profile, command: '!splat' });
  const review = await b.service.adapt({
    sourceDigest: pack.digest,
    profileRevision: 1,
    generate: true,
  });
  expect(review.manifest.trigger.command).toBe('!tomato');
  expect(review.passed).toBe(false);
  expect(review.checks.join('\n')).toMatch(/trigger\.command.*!splat.*!tomato/);
  expect(() => b.service.install({ reviewId: review.id, digest: review.digest })).toThrow();
});

it('allows explicit recipe ids only for this channel and only the next revision', async () => {
  const a = channel('spoof-owner'),
    v = local(a);
  const base = {
    versionId: v.id,
    title: 'Revisions',
    description: 'Public sample',
    author: 'Creator',
    license: 'MIT' as const,
    rightsAttested: true as const,
  };
  const foreign = await failure(() =>
    a.service.export({ ...base, recipeId: '11111111-1111-4111-8111-111111111111', revision: 2 }),
  );
  expect(foreign.code).toBe('CONFLICT');
  expect(foreign.message).toMatch(/not exported/);
  const first = a.service.export(base);
  expect(first.revision).toBe(1);
  const skip = await failure(() =>
    a.service.export({ ...base, title: 'Skip', recipeId: first.recipeId, revision: 3 }),
  );
  expect(skip.code).toBe('CONFLICT');
  expect(skip.message).toMatch(/revision 2/);
  const fresh = await failure(() => a.service.export({ ...base, revision: 4 }));
  expect(fresh.message).toMatch(/revision 1/);
  expect(
    a.service.export({ ...base, title: 'Second', recipeId: first.recipeId, revision: 2 }).revision,
  ).toBe(2);
  expect(a.service.export({ ...base, title: 'Third', recipeId: first.recipeId }).revision).toBe(3);
});

it('maps a full compiler queue, deadlines and shutdown to clear messages', async () => {
  const fullQueue = {
    ...createCompileQueue(),
    run: () => Promise.reject(new QueueFullError()),
  };
  const waiting = {
    ...createCompileQueue(),
    run: (_channel: string, _job: unknown, options: { signal?: AbortSignal } = {}) =>
      new Promise<never>((_resolve, reject) =>
        options.signal?.addEventListener('abort', () => reject(new Error('cancelled'))),
      ),
  };
  const a = channel('deadline-source'),
    pack = exportOf(a, local(a).id);
  const busy = channel('busy', () => [], { queue: fullQueue });
  busy.service.import(pack);
  const full = await failure(() =>
    busy.service.adapt({ sourceDigest: pack.digest, profileRevision: 0 }),
  );
  expect(full.code).toBe('BUSY');
  expect(full.message).toMatch(/compiler is busy, try again in a moment/i);

  const slow = channel('slow', () => [], { queue: waiting, deadlineMs: 1000 });
  slow.service.import(pack);
  const late = await failure(() =>
    slow.service.adapt({ sourceDigest: pack.digest, profileRevision: 0 }),
  );
  expect(late.message).toMatch(/timed out after 1 s/);

  const stopping = channel('stopping', () => [], { queue: waiting });
  stopping.service.import(pack);
  const pending = failure(() =>
    stopping.service.adapt({ sourceDigest: pack.digest, profileRevision: 0 }),
  );
  stopping.service.close();
  expect((await pending).message).toMatch(/server is shutting down/);
  const publishing = await failure(() => stopping.service.publish(pack));
  expect(publishing.code).toBe('BUSY');
});

it('gives every recipe error a specific message', async () => {
  const a = channel('messages');
  const missing = await failure(() =>
    a.service.moderate('00000000-0000-4000-8000-000000000000', true),
  );
  expect(missing.message).not.toBe('Recipe request could not be accepted.');
  expect(missing.message).toMatch(/report/i);
  const restore = await failure(() => a.service.restore('a'.repeat(64), true));
  expect(restore.message).toMatch(/edition/i);
});
