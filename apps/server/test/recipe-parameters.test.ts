import { afterEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { compileOffline, createCompileQueue, type CompilerTransport } from '@riff/compiler';
import { artifactIdentity } from '@riff/sandbox';
import type { RecipeParameter } from '@riff/sdk';
import { openDatabase, type DatabaseConnection } from '../src/db/client.js';
import { forChannel } from '../src/db/repositories/studio.js';
import { recipeRepository } from '../src/db/repositories/recipes.js';
import { createRecipeService } from '../src/services/recipes/service.js';
import { digest, parsePackage } from '../src/services/recipes/contract.js';
import {
  accentContrast,
  applyParameters,
  checkDeclarations,
} from '../src/services/recipes/parameters.js';

const databases: DatabaseConnection[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.close()));

/** Parameter remix must never reach the compiler: this transport fails the test if opened. */
const noModel: CompilerTransport = {
  kind: 'offline',
  model: null,
  open() {
    throw new Error('The model transport must not be used for a parameter-only remix.');
  },
};
function channel(id: string, reserved: string[] = []) {
  const database = openDatabase(':memory:');
  databases.push(database);
  migrate(database.db, { migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url)) });
  const repo = forChannel(database, id);
  repo.ensure(id);
  const service = createRecipeService({
    database,
    repo,
    transport: noModel,
    queue: createCompileQueue(),
    saveScene: () => undefined,
    reservedCommands: () => reserved,
  });
  return { database, repo, service };
}
function local(c: ReturnType<typeof channel>) {
  const output = compileOffline({
    intent: 'Let viewers throw tomatoes with !tomato, three times per person per 60 seconds.',
    base: null,
  });
  return c.repo.insertVersion({
    automationId: c.repo.createAutomation('Tomatoes').id,
    parentVersionId: null,
    artifactId: artifactIdentity({ source: output.source!, manifest: output.manifest }),
    title: 'Tomatoes',
    intent: 'private',
    source: output.source!,
    manifest: output.manifest,
    tests: output.tests,
    behavior: output.behavior,
    assumptions: [],
    evidence: {},
    origin: 'manual',
    compileRunId: null,
    status: 'candidate',
  });
}
const DECLARED: RecipeParameter[] = [
  { id: 'command', kind: 'command', label: 'Command' },
  { id: 'maxPerViewer', kind: 'number', label: 'Uses per viewer', min: 1, max: 6, step: 1 },
  {
    id: 'windowMs',
    kind: 'number',
    label: 'Window',
    min: 10_000,
    max: 120_000,
    step: 10_000,
  },
  {
    id: 'accent',
    kind: 'color',
    label: 'Accent',
    palette: ['#ffd166', '#7ae582', '#8ecae6'],
    default: '#ffd166',
  },
  {
    id: 'headline',
    kind: 'copy',
    label: 'Headline',
    maxLength: 60,
    default: { en: 'Splat the streamer', fr: 'Tomatez le streamer' },
  },
];
function published(parameters: RecipeParameter[] | null = DECLARED) {
  const a = channel('publisher');
  const version = local(a);
  const pack = a.service.export({
    versionId: version.id,
    title: 'Tomatoes',
    description: 'Public tomatoes',
    author: 'Declared',
    license: 'MIT',
    rightsAttested: true,
    ...(parameters ? { parameters } : {}),
  });
  return { a, pack };
}
const manifestOf = () =>
  compileOffline({
    intent: 'Throw tomatoes with !tomato, 3 per viewer per 60 seconds.',
    base: null,
  }).manifest;

describe('F29 declared parameter bounds', () => {
  it('refuses declarations outside host ceilings, without the published value or unreadable', () => {
    const manifest = manifestOf();
    expect(() =>
      checkDeclarations(
        [{ id: 'maxPerViewer', kind: 'number', label: 'n', min: 1, max: 50, step: 1 }],
        manifest,
      ),
    ).toThrow(/within 1–20/);
    expect(() =>
      checkDeclarations(
        [{ id: 'maxPerViewer', kind: 'number', label: 'n', min: 4, max: 6, step: 1 }],
        manifest,
      ),
    ).toThrow(/include the published value 3/);
    expect(accentContrast('#1a1a2e')).toBeLessThan(3);
    expect(() =>
      checkDeclarations(
        [{ id: 'accent', kind: 'color', label: 'c', palette: [], default: '#1a1a2e' }],
        manifest,
      ),
    ).toThrow(/too dark/);
    expect(() =>
      checkDeclarations(
        [{ id: 'experienceTitle', kind: 'copy', label: 't', maxLength: 40 }],
        manifest,
      ),
    ).toThrow(/needs a recipe with rounds/);
    expect(() =>
      checkDeclarations([{ id: 'command', kind: 'command', label: 'x', extra: 1 }], manifest),
    ).toThrow(/unsupported field/);
  });

  it('keeps declarations through export and import, and leaves undeclared editions unchanged', () => {
    const { pack } = published();
    expect(pack.parameters).toEqual(DECLARED);
    const b = channel('importer');
    const imported = b.service.import(JSON.parse(JSON.stringify(pack)));
    expect(imported.package.parameters).toEqual(DECLARED);
    // The declarations are part of the integrity digest.
    const tampered = structuredClone(pack);
    (tampered.parameters![1] as { max: number }).max = 20;
    expect(() => parsePackage(tampered)).toThrow(/digest/);
    const { pack: plain } = published(null);
    expect('parameters' in plain).toBe(false);
  });

  it('rejects out-of-range, undeclared and injected values server-side', () => {
    const { pack } = published();
    expect(() => applyParameters(pack, { maxPerViewer: 7 })).toThrow(/between 1 and 6/);
    expect(() => applyParameters(pack, { windowMs: 15_000 })).toThrow(/steps of 10000/);
    expect(() => applyParameters(pack, { accent: '#ff0000' })).toThrow(/palette/);
    expect(() => applyParameters(pack, { accent: 'red;background:url(x)' })).toThrow(/#rrggbb/);
    expect(() => applyParameters(pack, { command: "!x'); riff.chat.say('pwn" })).toThrow(
      /lowercase/,
    );
    expect(() => applyParameters(pack, { command: '!Splat' })).toThrow(/lowercase/);
    expect(() => applyParameters(pack, { headline: { en: 'Hi\u202eevil' } })).toThrow(/invisible/);
    expect(() => applyParameters(pack, { headline: { en: 'x'.repeat(61) } })).toThrow(/too long/);
    expect(() => applyParameters(pack, { headline: { xx: 'Hello' } })).toThrow(/language/);
    expect(() => applyParameters(pack, { experienceTitle: 'Nope' })).toThrow(/not editable/);
    expect(() => applyParameters(pack, { audience: ['moderator'] })).toThrow(/unsupported field/);
    const { pack: plain } = published(null);
    expect(() => applyParameters(plain, {})).toThrow(/declares no editable parameters/);
  });
});

describe('F29 parameter remix', () => {
  it('produces a deterministic, verified candidate with a new artifact id and no model call', async () => {
    const { pack } = published();
    const b = channel('recipient');
    b.service.import(pack);
    const values = {
      command: '!splat',
      windowMs: 30_000,
      accent: '#7ae582',
      headline: { en: 'Throw `${process.exit()}` at me' },
    };
    const first = await b.service.adapt({
      sourceDigest: pack.digest,
      profileRevision: 0,
      parameters: values,
    });
    const second = await b.service.adapt({
      sourceDigest: pack.digest,
      profileRevision: 0,
      parameters: values,
    });
    expect(first.passed).toBe(true);
    expect(first.source).toBe(pack.source);
    expect(first.artifactId).toBe(second.artifactId);
    expect(first.manifest).toEqual(second.manifest);
    expect(first.tests).toEqual(second.tests);
    expect(first.artifactId).not.toBe(
      artifactIdentity({ source: pack.source, manifest: pack.manifest }),
    );
    expect(first.manifest.trigger.command).toBe('!splat');
    expect(JSON.stringify(first.tests)).not.toContain('!tomato');
    expect(first.checks).toContain(
      'Declared parameters applied by the host within publisher bounds (no model call)',
    );
    expect(first.parameters?.style).toEqual({
      accent: '#7ae582',
      headline: { en: 'Throw `${process.exit()}` at me' },
    });
    // Copy is host-rendered style; it never reaches the executable source.
    expect(first.source).not.toContain('process.exit');
    expect((first.verification as { ok: boolean }).ok).toBe(true);
  });

  it('flags authority widening, regenerates allowance tests, and still requires approval', async () => {
    const { pack } = published();
    const b = channel('widening');
    b.service.import(pack);
    const review = await b.service.adapt({
      sourceDigest: pack.digest,
      profileRevision: 0,
      parameters: { maxPerViewer: 5 },
    });
    expect(review.passed).toBe(true);
    expect(review.parameters?.changes).toContainEqual({
      id: 'maxPerViewer',
      field: 'trigger.maxPerViewer',
      before: '3',
      after: '5',
      authority: 'widened',
    });
    expect(
      review.checks.some((check) =>
        check.startsWith('Authority widened — trigger.maxPerViewer: 3 → 5'),
      ),
    ).toBe(true);
    const trigger = review.differences.find((d) => d.field === 'trigger')!;
    expect(trigger.before).not.toBe(trigger.after);
    const limit = (review.tests as { kind: string; steps: { expect: string }[] }[]).find(
      (s) => s.kind === 'limit',
    )!;
    expect(limit.steps.filter((s) => s.expect === 'ACCEPTED')).toHaveLength(6);
    const narrowed = await b.service.adapt({
      sourceDigest: pack.digest,
      profileRevision: 0,
      parameters: { maxPerViewer: 2, windowMs: 120_000 },
    });
    expect(narrowed.parameters?.changes.filter((c) => c.authority === 'narrowed')).toHaveLength(2);
    expect(narrowed.checks.some((check) => check.startsWith('Authority widened'))).toBe(false);

    const installed = b.service.install({ reviewId: review.id, digest: review.digest });
    const version = b.repo.version(installed.versionId)!;
    expect(version.status).toBe('candidate');
    expect(version.artifactId).toBe(review.artifactId);
    expect(b.repo.automation(installed.automationId)?.activeVersionId).toBeNull();
  });

  it('checks command collisions and binds the reviewed values to install', async () => {
    const { pack } = published();
    const b = channel('collide', ['!hydrate']);
    b.service.import(pack);
    await expect(
      b.service.adapt({
        sourceDigest: pack.digest,
        profileRevision: 0,
        parameters: { command: '!riff' },
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(
      b.service.adapt({
        sourceDigest: pack.digest,
        profileRevision: 0,
        parameters: { command: '!hydrate' },
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(
      b.service.adapt({
        sourceDigest: pack.digest,
        profileRevision: 0,
        generate: true,
        parameters: { command: '!splat' },
      }),
    ).rejects.toMatchObject({ code: 'INVALID' });
    const review = await b.service.adapt({
      sourceDigest: pack.digest,
      profileRevision: 0,
      parameters: { accent: '#8ecae6' },
    });
    const records = recipeRepository(b.database, 'collide');
    const row = records.get()!;
    row.reviews[0]!.parameters!.style.accent = '#ffffff';
    records.save(row);
    expect(() => b.service.install({ reviewId: review.id, digest: review.digest })).toThrow(
      /Adapt again/,
    );
  });

  it('installs the reviewed style and keeps lineage and declarations on re-export', async () => {
    const { pack } = published();
    const b = channel('derivative');
    b.service.import(pack);
    const review = await b.service.adapt({
      sourceDigest: pack.digest,
      profileRevision: 0,
      parameters: { command: '!splat', accent: '#8ecae6', headline: { en: 'Splat away' } },
    });
    const installed = b.service.install({ reviewId: review.id, digest: review.digest });
    const presentation = b.service.presentation(installed.versionId);
    expect(presentation?.accent).toBe('#8ecae6');
    expect(presentation?.headline).toEqual({ en: 'Splat away' });
    const again = b.service.export({
      versionId: installed.versionId,
      title: 'Splats',
      description: 'Derivative',
      author: 'Recipient',
      license: 'MIT',
      rightsAttested: true,
    });
    expect(again.lineage.at(-1)).toMatchObject({ digest: pack.digest, author: 'Declared' });
    expect(again.parameters?.map((p) => p.id)).toEqual(DECLARED.map((p) => p.id));
    expect(again.parameters?.find((p) => p.id === 'accent')).toMatchObject({ default: '#8ecae6' });
    expect(again.manifest.trigger.command).toBe('!splat');
    expect(digest((({ digest: _d, ...rest }) => rest)(again))).toBe(again.digest);
  });
});
