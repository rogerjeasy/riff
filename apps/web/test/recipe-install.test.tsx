// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { defaultScene } from '../src/scenes/schema.js';
import { RecipeInstall } from '../src/console/recipes/install.js';
import { installLinkFor, parseInstallLink } from '../src/console/recipes/install-link.js';

const digest = 'a'.repeat(64);
const recipe = {
  version: 1,
  recipeId: '00000000-0000-4000-8000-000000000001',
  revision: 2,
  digest,
  title: 'Tomato',
  description: 'Public tomato recipe',
  author: 'A creator',
  license: 'CC-BY-4.0',
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
  lineage: [
    {
      recipeId: '00000000-0000-4000-8000-000000000009',
      revision: 1,
      digest: 'f'.repeat(64),
      author: 'Original author',
      license: 'CC-BY-4.0',
    },
  ],
};
const preview = (overrides: Record<string, unknown> = {}) => ({
  package: recipe,
  source: 'directory',
  proof: null,
  profileRevision: 0,
  compatibility: {
    installable: true,
    sdkVersion: '0.3.0',
    checks: [
      { id: 'sdk', label: 'SDK 0.3.0', status: 'ok', detail: 'Runs on this installation.' },
      {
        id: 'trigger',
        label: 'Channel Points trigger',
        status: 'consent',
        detail: 'Needs Channel Points consent.',
        grantUrl: '/auth/twitch?features=channel-points',
      },
    ],
  },
  scope: [
    { field: 'commands', label: 'Listens for', before: null, after: '!tomato', changed: true },
  ],
  existing: { status: 'none', versionId: null, title: null, revision: null },
  ...overrides,
});
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const noop = () => undefined;

it('parses install links, keeps the #digest form and never treats another origin as local', () => {
  const origin = 'https://riff.example';
  expect(parseInstallLink({ search: `?digest=${digest}`, hash: '', origin })).toEqual({
    kind: 'local',
    digest,
  });
  expect(parseInstallLink({ search: '', hash: `#${digest}`, origin })).toEqual({
    kind: 'local',
    digest,
  });
  const link = new URL(installLinkFor(origin, digest));
  expect(parseInstallLink({ search: link.search, hash: '', origin })).toEqual({
    kind: 'local',
    digest,
  });
  expect(
    parseInstallLink({ search: link.search, hash: '', origin: 'https://mine.example' }),
  ).toEqual({ kind: 'remote', digest, from: origin });
  expect(
    parseInstallLink({
      search: `?from=${encodeURIComponent('http://evil.example')}&digest=${digest}`,
      hash: '',
      origin,
    }).kind,
  ).toBe('invalid');
  expect(parseInstallLink({ search: '?digest=nothex', hash: '', origin }).kind).toBe('invalid');
});

it('shows author, digest, license, lineage, compatibility and scope before saving anything, and cancel writes nothing', async () => {
  const fetcher = vi.fn(async (url: RequestInfo | URL) =>
    String(url).endsWith('/install-preview') ? json({ preview: preview() }) : json({}, 500),
  );
  vi.stubGlobal('fetch', fetcher);
  const onClose = vi.fn();
  render(
    <RecipeInstall
      link={{ kind: 'local', digest }}
      onClose={onClose}
      onInstalled={noop}
      onReview={noop}
    />,
  );
  await screen.findByText(/publisher-declared/);
  expect(screen.getByText('A creator')).toBeTruthy();
  expect(screen.getByText('digest verified')).toBeTruthy();
  expect(screen.getByText('CC-BY-4.0')).toBeTruthy();
  expect(screen.getByText(/Original author \(edition 1, CC-BY-4.0\)/)).toBeTruthy();
  const grant = screen.getByRole('link', { name: /Grant on Twitch/ });
  expect(grant.getAttribute('href')).toBe('/auth/twitch?features=channel-points');
  expect(screen.getByRole('table')).toBeTruthy();
  expect(screen.getByText('Nothing installed')).toBeTruthy();
  fireEvent.click(screen.getAllByRole('button', { name: 'Cancel' })[0]!);
  expect(onClose).toHaveBeenCalled();
  expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual(['/api/recipes/install-preview']);
});

it('installs as a private candidate and hands the version to review', async () => {
  const fetcher = vi.fn(async (url: RequestInfo | URL, _init?: RequestInit) =>
    String(url).endsWith('/install-preview')
      ? json({ preview: preview() })
      : json({ installed: { versionId: 'v-1', alreadyInstalled: false }, state: {} }),
  );
  vi.stubGlobal('fetch', fetcher);
  const onInstalled = vi.fn(),
    onReview = vi.fn();
  render(
    <RecipeInstall
      link={{ kind: 'local', digest }}
      onClose={noop}
      onInstalled={onInstalled}
      onReview={onReview}
    />,
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Install as private candidate' }));
  await screen.findByText(/Nothing is live/);
  const body = JSON.parse(String(fetcher.mock.calls[1]![1]!.body)) as Record<string, unknown>;
  expect(body).toEqual({ digest, profileRevision: 0 });
  expect(onInstalled).toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Open candidate for review' }));
  expect(onReview).toHaveBeenCalledWith('v-1');
});

it('blocks incompatible editions and offers the installed candidate when already installed', async () => {
  vi.stubGlobal('fetch', async () =>
    json({
      preview: preview({
        compatibility: {
          installable: false,
          sdkVersion: '9.0.0',
          checks: [
            {
              id: 'sdk',
              label: 'SDK 9.0.0',
              status: 'blocked',
              detail: 'This installation cannot run SDK 9.0.0.',
            },
          ],
        },
      }),
    }),
  );
  render(
    <RecipeInstall
      link={{ kind: 'local', digest }}
      onClose={noop}
      onInstalled={noop}
      onReview={noop}
    />,
  );
  const install = await screen.findByRole('button', { name: 'Install as private candidate' });
  expect((install as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText(/1 check blocks this install/)).toBeTruthy();
  cleanup();

  const onReview = vi.fn();
  vi.stubGlobal('fetch', async () =>
    json({
      preview: preview({
        existing: { status: 'installed', versionId: 'v-9', title: 'Tomato', revision: 2 },
      }),
    }),
  );
  render(
    <RecipeInstall
      link={{ kind: 'local', digest }}
      onClose={noop}
      onInstalled={noop}
      onReview={onReview}
    />,
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Open installed candidate' }));
  expect(onReview).toHaveBeenCalledWith('v-9');
  expect(screen.queryByRole('button', { name: 'Install as private candidate' })).toBeNull();
});

it('names digest mismatches and unavailable recipes, and asks for a file for another directory', async () => {
  vi.stubGlobal('fetch', async () =>
    json({ code: 'NOT_FOUND', message: 'This published recipe is unavailable.' }, 404),
  );
  render(
    <RecipeInstall
      link={{ kind: 'local', digest }}
      onClose={noop}
      onInstalled={noop}
      onReview={noop}
    />,
  );
  expect((await screen.findByRole('alert')).textContent).toMatch(
    /Recipe unavailable.*Nothing was saved/,
  );
  cleanup();

  const fetcher = vi.fn(async () =>
    json({ code: 'CONFLICT', message: 'Digest mismatch: this file is a different edition.' }, 409),
  );
  vi.stubGlobal('fetch', fetcher);
  render(
    <RecipeInstall
      link={{ kind: 'remote', digest, from: 'https://other.example' }}
      onClose={noop}
      onInstalled={noop}
      onReview={noop}
    />,
  );
  expect(screen.getByText(/Riff never downloads from other sites/)).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Open that directory' }).getAttribute('href')).toBe(
    `https://other.example/recipes#${digest}`,
  );
  expect(fetcher).not.toHaveBeenCalled();
  const file = new File([JSON.stringify({ ...recipe, digest: 'b'.repeat(64) })], 'r.json', {
    type: 'application/json',
  });
  fireEvent.change(screen.getByLabelText(/Choose downloaded file/), { target: { files: [file] } });
  expect((await screen.findByRole('alert')).textContent).toMatch(/Digest mismatch/);
  expect(fetcher).toHaveBeenCalledTimes(1);
});
