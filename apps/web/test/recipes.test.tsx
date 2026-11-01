// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Version } from '../src/lib/types.js';
import { defaultScene } from '../src/scenes/schema.js';
import { recipePackageSchema } from '../src/console/recipes/contracts.js';
import { RecipeLibrary } from '../src/console/recipes/library.js';
import { RecipeDirectory } from '../src/console/recipes/directory.js';
const profile = {
  revision: 0,
  displayName: 'My channel',
  language: 'en',
  reducedMotion: true,
  scene: defaultScene(),
  capabilities: ['overlay', 'session'],
  command: '!tomato',
  audience: ['viewer'],
  maxPerViewer: 3,
  windowMs: 60000,
};
const recipe = {
  version: 1,
  recipeId: '00000000-0000-4000-8000-000000000001',
  revision: 1,
  digest: 'a'.repeat(64),
  title: 'Tomato',
  description: 'Public tomato recipe',
  author: 'A creator',
  license: 'MIT',
  rightsAttested: true,
  source: 'async (e,riff)=>{}',
  manifest: {
    sdkVersion: '0.3.0',
    capabilities: ['overlay'],
    trigger: { command: '!tomato', audience: ['viewer'], maxPerViewer: 3, windowMs: 60000 },
    limits: { effectsPerEvent: 1, effectsPerMinute: 60 },
  },
  tests: [],
  scene: defaultScene(),
  presentation: { language: 'en', reducedMotion: true },
  assets: [{ id: 'tomato', credit: 'Riff', license: 'project-license' }],
  lineage: [],
};
const proof = {
  synthetic: true,
  accepted: 1,
  blocked: 0,
  scores: {},
  contributions: 0,
  steps: [
    {
      at: 1,
      text: '!tomato',
      code: 'ACCEPTED',
      reason: 'Accepted sample',
      effects: [{ asset: 'tomato', x: 0.5 }],
    },
  ],
};
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it('reads stateless rules whose manifest carries an explicit null experience', async () => {
  const { requirements } = await import('../src/console/recipes/contracts.js');
  const rules = requirements({ ...recipe.manifest, sdkVersion: '0.4.0', experience: null });
  expect(rules?.trigger.command).toBe('!tomato');
  expect(rules?.experience).toBeNull();
});
it('rejects private fields and unlicensed external assets in browser packages', () => {
  expect(recipePackageSchema.safeParse(recipe).success).toBe(true);
  expect(recipePackageSchema.safeParse({ ...recipe, privatePrompt: 'Never share' }).success).toBe(
    false,
  );
  expect(
    recipePackageSchema.safeParse({
      ...recipe,
      assets: [{ id: 'other', url: 'https://example.com/image', license: 'unknown' }],
    }).success,
  ).toBe(false);
});
it('imports a pinned package without issuing an approval request', async () => {
  let state = { profile, imports: [] as unknown[], reviews: [], publications: [], reports: [] };
  const fetcher = vi.fn(async (url: RequestInfo | URL, _init?: RequestInit) => {
    if (String(url).endsWith('/import'))
      state = {
        ...state,
        imports: [{ digest: recipe.digest, package: recipe, supported: true, blockers: [] }],
      };
    return new Response(JSON.stringify({ state }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetcher);
  render(<RecipeLibrary versions={[]} onReview={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: /^Recipe library/ }));
  await screen.findByRole('button', { name: 'Import pinned recipe' });
  fireEvent.change(screen.getByLabelText('Recipe JSON'), {
    target: { value: JSON.stringify(recipe) },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Import pinned recipe' }));
  await screen.findByRole('heading', { name: 'Tomato · edition 1' });
  expect(fetcher.mock.calls.some(([url]) => String(url).includes('approve'))).toBe(false);
  const call = fetcher.mock.calls.find(([url]) => String(url).endsWith('/import'));
  expect(JSON.parse(String(call?.[1]?.body))).toEqual({ package: recipe });
});
it('public recipe page uses only directory routes and displays declared credit with synthetic preview', async () => {
  const publication = {
    package: recipe,
    withheld: false,
    proof,
    samples: [{ at: 1, asset: 'tomato', x: 0.5 }],
  };
  const fetcher = vi.fn(
    async (url: RequestInfo | URL) =>
      new Response(
        JSON.stringify(
          String(url).includes(recipe.digest)
            ? { recipe: publication }
            : { recipes: [publication] },
        ),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
  );
  vi.stubGlobal('fetch', fetcher);
  render(<RecipeDirectory />);
  fireEvent.click(await screen.findByRole('button', { name: 'Open Tomato' }));
  await screen.findByText(/Publisher-declared author: A creator/);
  expect(screen.getByText(/Publisher-declared/)).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Play sample chat' })).toBeTruthy();
  expect(fetcher.mock.calls.every(([url]) => String(url).startsWith('/directory/recipes'))).toBe(
    true,
  );
});
it('requires saving profile edits and reviewing the chosen update target before installation', async () => {
  const current = {
    id: 'review-current',
    digest: 'b'.repeat(64),
    sourceDigest: recipe.digest,
    profileRevision: 0,
    artifactId: 'c'.repeat(64),
    source: recipe.source,
    manifest: recipe.manifest,
    tests: [],
    scene: recipe.scene,
    differences: [],
    passed: true,
    checks: [],
    rehearsalHash: 'd'.repeat(64),
    installedVersionId: null,
    targetVersionId: null,
    proof,
    requiredTwitchScopes: ['user:read:chat'],
  };
  const state = {
    profile,
    imports: [{ digest: recipe.digest, package: recipe, supported: true, blockers: [] }],
    // Stored oldest first; the console reviews the newest one for the chosen source.
    reviews: [{ ...current, id: 'review-old', installedVersionId: 'installed' }, current],
    publications: [],
    reports: [],
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify({ state }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    ),
  );
  const versions = [
    { id: 'installed', title: 'Existing recipe', number: 1, approvedAt: null },
  ] as unknown as Version[];
  render(<RecipeLibrary versions={versions} onReview={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: /^Recipe library/ }));
  const adapt = await screen.findByRole('button', { name: 'Make this fit my channel' });
  fireEvent.change(screen.getByLabelText('Channel display name'), {
    target: { value: 'Unsaved identity' },
  });
  expect((adapt as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('Channel display name'), {
    target: { value: profile.displayName },
  });
  fireEvent.change(screen.getByLabelText('Install destination'), {
    target: { value: 'installed' },
  });
  expect(
    (screen.getByRole('button', { name: 'Install exact reviewed candidate' }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
});
it('describes stateful round resources instead of a rolling throw allowance in the directory', async () => {
  const publication = {
    package: {
      ...recipe,
      manifest: {
        ...recipe.manifest,
        capabilities: ['overlay', 'session'],
        experience: {
          title: 'Team round',
          durationMs: 60000,
          teams: [{ id: 'red', label: 'Red', joinCommand: '!red' }],
          resource: { name: 'tomatoes', perParticipant: 5 },
          contribution: { command: '!throw', points: 1 },
        },
      },
    },
    withheld: false,
    proof,
    samples: [],
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async (url: RequestInfo | URL) =>
        new Response(
          JSON.stringify(
            String(url).includes(recipe.digest)
              ? { recipe: publication }
              : { recipes: [publication] },
          ),
          { status: 200 },
        ),
    ),
  );
  render(<RecipeDirectory />);
  fireEvent.click(await screen.findByRole('button', { name: 'Open Tomato' }));
  await screen.findByText(/5 tomatoes per round/);
  expect(screen.getByText(/join with !red/)).toBeTruthy();
  expect(screen.getByText('!throw')).toBeTruthy();
  expect(screen.queryByText(/3 per viewer/)).toBeNull();
});
